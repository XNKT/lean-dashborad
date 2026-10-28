// Executes Taskboard issues inside Trae by driving its chat UI through the
// Chrome DevTools Protocol. Issues marked "in_progress" are dispatched one at
// a time; the Trae agent is instructed to report back and move the issue to
// "in_review" with taskctl, so the runner only waits for that status change.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const taskctlPath = path.join(projectRoot, "cli", "taskctl.mjs");
const workbenchPattern = /\/workbench\/workbench\.html/;

const options = {
  cdpPort: 9232,
  intervalMs: 10_000,
  timeoutMs: 45 * 60_000,
  execute: false,
  once: false,
  serverUrl: process.env.CODEX_TASKBOARD_URL ?? "",
  statePath: path.join(projectRoot, ".data", "trae-runner-state.json"),
};

function readArguments(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port") options.cdpPort = Number(argv[++index]);
    else if (argument === "--interval") options.intervalMs = Number(argv[++index]) * 1000;
    else if (argument === "--timeout") options.timeoutMs = Number(argv[++index]) * 60_000;
    else if (argument === "--server-url") options.serverUrl = argv[++index];
    else if (argument === "--state") options.statePath = path.resolve(argv[++index]);
    else if (argument === "--execute") options.execute = true;
    else if (argument === "--once") options.once = true;
    else if (argument === "--help" || argument === "-h") {
      console.log(`Usage: node scripts/trae-runner.mjs [options]

  --port <n>          Trae CDP port (default 9232)
  --interval <s>      Board poll interval (default 10)
  --timeout <m>       Per-task timeout in minutes (default 45)
  --server-url <url>  Taskboard base URL (default CODEX_TASKBOARD_URL/local)
  --state <file>      Runner state file (default .data/trae-runner-state.json)
  --execute           Actually dispatch prompts into Trae (default dry-run)
  --once              Stop after one task finishes
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
}

const log = (message) => console.log(`[trae-runner ${new Date().toLocaleTimeString()}] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runTaskctl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [taskctlPath, ...args], {
      cwd: projectRoot,
      env: options.serverUrl ? { ...process.env, CODEX_TASKBOARD_URL: options.serverUrl } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        const detail = stderr.split("\n").find((line) => line.trim().startsWith("{")) ?? stderr.trim() ?? `exit ${code}`;
        reject(new Error(detail));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`taskctl returned non-JSON output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

async function listInProgress() {
  const { tasks } = await runTaskctl(["issue", "list", "--status", "in_progress", "--json"]);
  return tasks;
}

async function getTask(identifier) {
  const { task } = await runTaskctl(["issue", "get", String(identifier), "--json"]);
  return task;
}

async function listProjects() {
  const { projects } = await runTaskctl(["project", "list", "--json"]);
  return projects;
}

async function loadState() {
  try {
    return JSON.parse(await readFile(options.statePath, "utf8"));
  } catch {
    return { tasks: {} };
  }
}

async function saveState(state) {
  await mkdir(path.dirname(options.statePath), { recursive: true });
  await writeFile(options.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function taskctlCommand(args) {
  const prefix = options.serverUrl ? `CODEX_TASKBOARD_URL=${options.serverUrl} ` : "";
  return `${prefix}${process.execPath} ${taskctlPath} ${args.join(" ")}`;
}

function buildPrompt(task, project) {
  const workspace = project?.workspacePath;
  const completion = [
    taskctlCommand(["comment", "add", task.identifier, "--body", '"<你的完成总结>"', "--agent-platform", "trae"]),
    taskctlCommand(["issue", "get", task.identifier, "--json"]),
    taskctlCommand(["issue", "move", task.identifier, "--status", "in_review", "--if-version", "<上一步返回的 version>", "--agent-platform", "trae"]),
  ].join("\n");
  return [
    `你是 Trae 中的自动执行体。现在执行看板议题 ${task.identifier}。`,
    "",
    `标题：${task.title}`,
    `工作区：${workspace ?? "未指定，请在当前打开的工作区中执行"}`,
    task.description ? `描述：\n${task.description}` : "描述：（无）",
    "",
    "要求：",
    "1. 只处理这一个议题，不要改动其他议题，也不要修改看板中其他内容。",
    `2. 实际完成代码/文档改动，并做必要验证（构建、测试或运行）。`,
    `3. 完成后，在本议题下写一条评论，说明改了什么、如何验证、遗留问题。`,
    `4. 然后按顺序执行以下命令（原样执行，替换占位符）：`,
    "",
    "```bash",
    completion,
    "```",
    "",
    "如果 move 返回 409/version 冲突，先执行 issue get 取最新 version 再重试。",
    "不要执行上述命令以外的状态变更。",
  ].join("\n");
}

async function findWorkbench() {
  try {
    const response = await fetch(`http://127.0.0.1:${options.cdpPort}/json/list`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find((target) => target.type === "page"
      && typeof target.url === "string"
      && workbenchPattern.test(target.url)
      && typeof target.webSocketDebuggerUrl === "string") ?? null;
  } catch {
    return null;
  }
}

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error(`${method} timed out`)), 15_000);
  });
  const evaluate = async (expression) => (await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    userGesture: true,
  }))?.result?.value;
  return { socket, send, evaluate };
}

async function dispatchToTrae(prompt) {
  const target = await findWorkbench();
  if (!target) throw new Error(`No Trae workbench on port ${options.cdpPort}`);
  const { socket, send, evaluate } = await connect(target);
  try {
    const autoApproval = await evaluate(
      `document.querySelector("[class*=permissionModeTriggerLabel]")?.textContent?.trim() ?? ""`,
    );
    if (!autoApproval.includes("自动审批")) {
      throw new Error(`Trae 当前权限模式为「${autoApproval || "未知"}」，请在对话底部切换为「自动审批」后重试`);
    }

    const created = await evaluate(`(() => {
      const button = [...document.querySelectorAll("a.codicon-icube-NewChat")]
        .find((element) => element.getBoundingClientRect().width > 0);
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!created) throw new Error("没有找到 Trae 的「新建任务」按钮");

    let ready = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(300);
      ready = await evaluate(`(() => {
        const input = [...document.querySelectorAll(".chat-input-v2-input-box-editable")]
          .find((element) => element.getBoundingClientRect().width > 0);
        if (!input) return false;
        const fresh = !document.querySelector(".ai-chat") || /轻松应对复杂项目开发/.test(document.body.innerText);
        return fresh;
      })()`);
      if (ready) break;
    }
    if (!ready) throw new Error("新建会话没有进入空白输入界面，已中止（未发送提示词）");

    await evaluate(`(() => {
      const input = [...document.querySelectorAll(".chat-input-v2-input-box-editable")]
        .find((element) => element.getBoundingClientRect().width > 0);
      input?.focus();
      return Boolean(input);
    })()`);
    await send("Input.insertText", { text: prompt });
    await sleep(500);
    const typed = await evaluate(
      `document.querySelector(".chat-input-v2-input-box-editable")?.innerText?.trim() ?? ""`,
    );
    if (!typed.includes(prompt.slice(0, 20))) throw new Error("提示词没有写入 Trae 输入框");
    const clicked = await evaluate(`(() => {
      const button = document.querySelector(".chat-input-v2-send-button");
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error("没有找到发送按钮");
    await sleep(1_500);
    const cleared = await evaluate(
      `document.querySelector(".chat-input-v2-input-box-editable")?.innerText?.trim() === ""`,
    );
    if (!cleared) throw new Error("点击发送后输入框未清空，可能未成功提交");
    log("prompt dispatched");
  } finally {
    socket.close();
  }
}

async function main() {
  readArguments(process.argv.slice(2));
  const state = await loadState();
  let dispatched = null;

  const handled = (task) => state.tasks[task.id]?.version === task.version;

  for (;;) {
    if (dispatched) {
      const record = state.tasks[dispatched];
      let current;
      try {
        current = await getTask(record.identifier);
      } catch (error) {
        log(`could not read ${record.identifier}: ${error.message}`);
        current = null;
      }
      if (current && current.status !== "in_progress") {
        record.status = "completed";
        record.finishedAt = new Date().toISOString();
        await saveState(state);
        log(`${record.identifier} finished with status ${current.status}`);
        dispatched = null;
        if (options.once) return;
      } else if (!current || Date.now() - new Date(record.dispatchedAt).getTime() > options.timeoutMs) {
        record.status = current ? "failed" : "unknown";
        record.finishedAt = new Date().toISOString();
        await saveState(state);
        log(`${record.identifier} timed out or disappeared; clear it from the state file to retry`);
        dispatched = null;
        if (options.once) return;
      } else {
        await sleep(options.intervalMs);
        continue;
      }
    }

    let tasks;
    try {
      tasks = await listInProgress();
    } catch (error) {
      log(`board unavailable: ${error.message}`);
      if (options.once) throw error;
      await sleep(options.intervalMs);
      continue;
    }
    const next = tasks.find((task) => !handled(task));
    if (!next) {
      if (options.once) {
        log("no pending in_progress issue");
        return;
      }
      await sleep(options.intervalMs);
      continue;
    }
    const projects = await listProjects();
    const project = projects.find((entry) => entry.id === next.projectId);
    const prompt = buildPrompt(next, project);
    if (!options.execute) {
      log(`dry-run: would execute ${next.identifier}`);
      console.log(prompt);
      return;
    }
    log(`dispatching ${next.identifier}: ${next.title}`);
    try {
      await dispatchToTrae(prompt);
    } catch (error) {
      log(`dispatch failed: ${error.message}`);
      state.tasks[next.id] = {
        identifier: next.identifier,
        version: next.version,
        status: "failed",
        error: error.message,
        finishedAt: new Date().toISOString(),
      };
      await saveState(state);
      if (options.once) throw error;
      await sleep(options.intervalMs);
      continue;
    }
    state.tasks[next.id] = {
      identifier: next.identifier,
      version: next.version,
      status: "dispatched",
      dispatchedAt: new Date().toISOString(),
    };
    await saveState(state);
    dispatched = next.id;
  }
}

main().catch((error) => {
  console.error(`[trae-runner] ${error.message}`);
  process.exit(1);
});
