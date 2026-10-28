#!/usr/bin/env node

// Embeds Codex Taskboard into a running Trae window through the Chrome
// DevTools Protocol. Trae is a VS Code based Electron app, so the launcher
// injects a user script into the workbench renderer instead of patching Trae.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

const injectorPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(injectorPath), "..");
const userScriptPath = path.join(projectRoot, "inject", "trae-taskboard.user.js");
const traeApplication = process.env.TRAE_APP_PATH
  ? path.resolve(process.env.TRAE_APP_PATH)
  : "/Applications/Trae CN.app";

const options = {
  cdpPort: 9232,
  taskboardPort: Number(process.env.CODEX_TASKBOARD_PORT ?? 47823),
  open: false,
  launch: false,
  once: false,
  service: true,
  profile: process.env.TRAE_TASKBOARD_PROFILE
    ? path.resolve(process.env.TRAE_TASKBOARD_PROFILE)
    : null,
};

function readArguments(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port") {
      options.cdpPort = Number(argv[++index]);
    } else if (argument === "--taskboard-port") {
      options.taskboardPort = Number(argv[++index]);
    } else if (argument === "--profile") {
      options.profile = path.resolve(argv[++index]);
    } else if (argument === "--open") {
      options.open = true;
    } else if (argument === "--launch") {
      options.launch = true;
    } else if (argument === "--once") {
      options.once = true;
    } else if (argument === "--no-service") {
      options.service = false;
    } else if (argument === "--help" || argument === "-h") {
      console.log(`Usage: node scripts/trae-injector.mjs [options]

  --port <n>              Trae CDP port (default 9232)
  --taskboard-port <n>    Taskboard HTTP port (default 47823)
  --profile <dir>         user-data-dir used when launching Trae
  --launch                launch Trae with the CDP port when no window is reachable
  --open                  open the Taskboard panel after injecting
  --once                  inject once and exit (keeps an externally started service)
  --no-service            never start the Taskboard service
`);
      process.exit(0);
    }
  }
  if (!Number.isInteger(options.cdpPort) || options.cdpPort <= 0 || options.cdpPort > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  if (!Number.isInteger(options.taskboardPort) || options.taskboardPort <= 0 || options.taskboardPort > 65535) {
    throw new Error("--taskboard-port must be an integer between 1 and 65535");
  }
}

const taskboardOrigin = `http://127.0.0.1:${options.taskboardPort}`;
const taskboardUrl = `${taskboardOrigin}/?host=trae`;
const workbenchPattern = /\/workbench\/workbench\.html/;

let serviceProcess = null;
let runnerProcess = null;
let stopping = false;

function log(message) {
  console.log(`[trae-taskboard] ${message}`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function taskboardIsHealthy() {
  try {
    const response = await fetch(`${taskboardOrigin}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureTaskboardService() {
  if (await taskboardIsHealthy()) return;
  if (!options.service) {
    throw new Error(`Taskboard is not running at ${taskboardOrigin}`);
  }
  log(`starting Taskboard at ${taskboardOrigin}`);
  const child = spawn(process.execPath, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_TASKBOARD_HOST: "127.0.0.1",
      CODEX_TASKBOARD_PORT: String(options.taskboardPort),
      CODEX_TASKBOARD_DATA_DIR: path.join(projectRoot, ".data"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serviceProcess = child;
  child.stdout.on("data", (chunk) => process.stdout.write(`[taskboard] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[taskboard] ${chunk}`));
  child.once("exit", (code, signal) => {
    if (serviceProcess === child) serviceProcess = null;
    if (!stopping && code !== 0) {
      log(`Taskboard service exited (${signal ?? code})`);
    }
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await taskboardIsHealthy()) return;
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  throw new Error("Taskboard did not become healthy in time");
}

async function stopTaskboardService() {
  if (!serviceProcess || serviceProcess.exitCode !== null) return;
  const child = serviceProcess;
  serviceProcess = null;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(3_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function startRunner() {
  if (runnerProcess) return;
  log("starting Trae runner: issues moved to in_progress will execute automatically");
  const child = spawn(process.execPath, [
    path.join(projectRoot, "scripts", "trae-runner.mjs"),
    "--execute",
    "--port", String(options.cdpPort),
    "--server-url", taskboardOrigin,
  ], {
    cwd: projectRoot,
    env: { ...process.env, CODEX_TASKBOARD_URL: taskboardOrigin },
    stdio: ["ignore", "pipe", "pipe"],
  });
  runnerProcess = child;
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.once("exit", (code, signal) => {
    if (runnerProcess === child) runnerProcess = null;
    if (!stopping) log(`Trae runner exited unexpectedly (${signal ?? code})`);
  });
}

async function stopRunner() {
  if (!runnerProcess || runnerProcess.exitCode !== null) return;
  const child = runnerProcess;
  runnerProcess = null;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(3_000),
  ]);
}

async function traeIsRunning() {
  return await new Promise((resolve) => {
    const probe = spawn("pgrep", ["-f", traeApplication], { stdio: "ignore" });
    probe.once("exit", (code) => resolve(code === 0));
    probe.once("error", () => resolve(false));
  });
}

async function listTargets() {
  try {
    const response = await fetch(`http://127.0.0.1:${options.cdpPort}/json/list`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return [];
    const targets = await response.json();
    return targets.filter(
      (target) => target.type === "page"
        && typeof target.url === "string"
        && workbenchPattern.test(target.url)
        && typeof target.webSocketDebuggerUrl === "string",
    );
  } catch {
    return [];
  }
}

function connectTarget(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timeout);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });

  socket.on("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("CDP socket closed"));
    }
    pending.clear();
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error("CDP socket is not open"));
        return;
      }
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve({ socket, send }));
    socket.once("error", reject);
  });
}

async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed");
  }
  return result.result?.value;
}

const injectedTargets = new Set();
let userScriptSource = null;

async function injectInto(target) {
  let session;
  try {
    session = await connectTarget(target);
  } catch {
    return;
  }
  try {
    const ready = await evaluate(
      session,
      "Boolean(document.querySelector('.part.editor'))",
    );
    if (!ready) return;

    const installed = await evaluate(session, "Boolean(window.__TRAE_TASKBOARD_V1__)");
    if (!installed) {
      userScriptSource ??= await readFile(userScriptPath, "utf8");
      const source = userScriptSource.replace("__TRAE_TASKBOARD_URL__", taskboardUrl);
      await evaluate(session, source);
      log(`injected Taskboard into ${target.title || target.id}`);
    }
    if (options.open) {
      await evaluate(session, "window.__TRAE_TASKBOARD_V1__?.open()");
    }
    injectedTargets.add(target.id);
  } catch (error) {
    log(`injection failed for ${target.title || target.id}: ${error.message}`);
    injectedTargets.delete(target.id);
  } finally {
    session.socket.close();
  }
}

async function launchTrae() {
  if (await traeIsRunning()) {
    throw new Error(
      `Trae is already running without the CDP port ${options.cdpPort}. `
      + `Quit Trae, then run this command again (it will reopen Trae with the panel).`,
    );
  }
  const args = [
    `--remote-debugging-port=${options.cdpPort}`,
    `--remote-allow-origins=http://127.0.0.1:${options.cdpPort}`,
  ];
  if (options.profile) args.push(`--user-data-dir=${options.profile}`);
  log(`launching Trae with CDP port ${options.cdpPort}`);
  spawn("open", ["-n", "-a", traeApplication, "--args", ...args], { stdio: "ignore" });
}

async function waitForTargets(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets();
    if (targets.length > 0) return targets;
    await sleep(1_000);
  }
  return [];
}

async function watch() {
  const targets = await listTargets();
  if (targets.length === 0) return false;
  for (const target of targets) {
    if (!injectedTargets.has(target.id)) await injectInto(target);
    else {
      // A reload keeps the target id but drops the injected script.
      try {
        const session = await connectTarget(target);
        const installed = await evaluate(session, "Boolean(window.__TRAE_TASKBOARD_V1__)");
        session.socket.close();
        if (!installed) {
          injectedTargets.delete(target.id);
          await injectInto(target);
        }
      } catch {
        injectedTargets.delete(target.id);
      }
    }
  }
  return true;
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stopRunner();
  await stopTaskboardService();
  process.exit(0);
}

async function main() {
  readArguments(process.argv.slice(2));
  await ensureTaskboardService();

  let targets = await listTargets();
  if (targets.length === 0 && options.launch) {
    await launchTrae();
    log("waiting for a Trae workbench window. Open the IDE view if Trae starts in Agent mode.");
    targets = await waitForTargets(120_000);
  }
  if (targets.length === 0) {
    throw new Error(
      `No Trae workbench found on port ${options.cdpPort}. `
      + `Start Trae with --remote-debugging-port=${options.cdpPort} and try again.`,
    );
  }

  await watch();
  if (options.once) {
    if (serviceProcess) {
      // Keep a service started for this one-shot run available to the panel.
      serviceProcess.unref();
      serviceProcess.stdout.destroy();
      serviceProcess.stderr.destroy();
      serviceProcess = null;
    }
    return;
  }

  log(`watching Trae on port ${options.cdpPort}; press Ctrl-C to stop`);
  startRunner();
  for (;;) {
    await sleep(2_000);
    try {
      await watch();
    } catch (error) {
      log(error.message);
    }
  }
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

main().catch(async (error) => {
  console.error(`[trae-taskboard] ${error.message}`);
  await stopTaskboardService();
  process.exitCode = 1;
});
