// Injected into the Trae workbench renderer by scripts/trae-injector.mjs.
// Adds a Taskboard entry to Trae's activity bar and renders the board on top of
// the editor area, mirroring how the Codex launcher embeds the same panel.
(() => {
  const TASKBOARD_URL = "__TRAE_TASKBOARD_URL__";
  const PANEL_ID = "trae-taskboard-panel";
  const ENTRY_ID = "trae-taskboard-entry";
  const FLOATING_ID = "trae-taskboard-floating-entry";
  const STYLE_ID = "trae-taskboard-style";
  const OPEN_STATE_KEY = "trae.taskboard.open";
  const HOST_CONTEXT_DELAY_MS = 120;

  if (window.__TRAE_TASKBOARD_V1__) {
    window.__TRAE_TASKBOARD_V1__.refresh();
    return;
  }

  const state = {
    panel: null,
    frame: null,
    entry: null,
    floating: null,
    challenge: "",
    themeObserver: null,
    layoutObserver: null,
    challengeTimer: null,
  };

  function currentTheme() {
    const classes = document.body.classList;
    if (classes.contains("dark") || classes.contains("vs-dark") || classes.contains("vscode-dark")) {
      return "dark";
    }
    if (classes.contains("light") || classes.contains("vs") || classes.contains("vscode-light")) {
      return "light";
    }
    const background = getComputedStyle(document.body).backgroundColor;
    const match = background.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return "dark";
    const luminance = (Number(match[1]) * 299 + Number(match[2]) * 587 + Number(match[3]) * 114) / 1000;
    return luminance < 128 ? "dark" : "light";
  }

  function postToFrame(message) {
    if (!state.frame?.contentWindow) return;
    state.frame.contentWindow.postMessage(message, "*");
  }

  function sendTheme() {
    postToFrame({ type: "taskboard:theme", theme: currentTheme() });
  }

  function sendHostContext() {
    postToFrame({
      type: "taskboard:host-context",
      payload: {
        language: navigator.language,
        theme: currentTheme(),
        sidebarCollapsed: false,
      },
    });
  }

  function publishHostContextSoon() {
    clearTimeout(state.challengeTimer);
    state.challengeTimer = setTimeout(sendHostContext, HOST_CONTEXT_DELAY_MS);
  }

  function postChallenge() {
    state.challenge = (
      typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2)
    );
    postToFrame({ type: "taskboard:frame-challenge", payload: { challenge: state.challenge } });
    publishHostContextSoon();
  }

  function answerUnsupportedThread(type, fallbackMessage) {
    postToFrame({
      type,
      payload: {
        error: fallbackMessage,
      },
    });
  }

  function handleFrameMessage(event) {
    if (!state.frame || event.source !== state.frame.contentWindow) return;
    const message = event.data;
    if (!message || typeof message !== "object" || typeof message.type !== "string") return;

    switch (message.type) {
      case "taskboard:frame-awaiting-challenge":
        postChallenge();
        break;
      case "taskboard:ready":
        publishHostContextSoon();
        break;
      case "taskboard:open-external": {
        const url = message.payload?.url;
        if (typeof url === "string" && /^https?:/i.test(url)) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
        break;
      }
      case "taskboard:open-thread":
        answerUnsupportedThread(
          "taskboard:thread-open-error",
          "Trae 面板内暂不支持直接打开对话，请复制对话 ID 后在 Trae 中使用。",
        );
        break;
      case "taskboard:create-thread":
        answerUnsupportedThread(
          "taskboard:thread-create-error",
          "Trae 面板内暂不支持打开新对话，请复制提示词后在 Trae 中使用。",
        );
        break;
      case "taskboard:automation-request":
        postToFrame({
          type: "taskboard:automation-response",
          payload: {
            requestId: message.payload?.requestId,
            ok: false,
            error: "Trae 面板不支持 Codex 自动化调度。",
          },
        });
        break;
      case "taskboard:expand-sidebar":
        openPanel();
        break;
      default:
        break;
    }
  }

  function editorRect() {
    const editor = document.querySelector(".part.editor");
    if (editor) {
      const rect = editor.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return rect;
    }
    const workbench = document.querySelector(".monaco-workbench");
    return (workbench ?? document.body).getBoundingClientRect();
  }

  function placePanel() {
    if (!state.panel) return;
    const rect = editorRect();
    state.panel.style.left = `${rect.x}px`;
    state.panel.style.top = `${rect.y}px`;
    state.panel.style.width = `${rect.width}px`;
    state.panel.style.height = `${rect.height}px`;
    if (state.floating) {
      state.floating.style.left = `${rect.x + 12}px`;
      state.floating.style.top = `${rect.y + 12}px`;
    }
  }

  function refresh() {
    if (!state.frame) return;
    const url = new URL(TASKBOARD_URL);
    url.searchParams.set("refresh", String(Date.now()));
    state.challenge = "";
    state.frame.src = url.href;
  }

  function openPanel() {
    if (!state.panel) buildPanel();
    if (!state.panel) return;
    state.panel.style.display = "flex";
    state.entry?.classList.add("active");
    state.floating?.classList.add("active");
    placePanel();
    localStorage.setItem(OPEN_STATE_KEY, "1");
    if (!state.frame.src) refresh();
  }

  function closePanel() {
    if (!state.panel) return;
    state.panel.style.display = "none";
    state.entry?.classList.remove("active");
    state.floating?.classList.remove("active");
    localStorage.setItem(OPEN_STATE_KEY, "0");
  }

  function togglePanel() {
    if (!state.panel || state.panel.style.display === "none") openPanel();
    else closePanel();
  }

  function buildIcon() {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 18 18");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(namespace, "path");
    path.setAttribute(
      "d",
      "M3.5 4.5h1.2l.8.9 1.7-2M8 4.5h6.5M3.5 9h1.2l.8.9 1.7-2M8 9h6.5M3.5 13.5h1.2l.8.9 1.7-2M8 13.5h6.5",
    );
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.35");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
#${PANEL_ID} {
  position: fixed;
  z-index: 900;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  background: var(--vscode-editor-background, #1e1e1e);
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
}
#${PANEL_ID} header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 36px;
  padding: 0 8px 0 12px;
  box-sizing: border-box;
  color: var(--vscode-foreground, #ddd);
  font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
#${PANEL_ID} header strong {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${PANEL_ID} .trae-taskboard-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
}
#${PANEL_ID} .trae-taskboard-action,
#${FLOATING_ID} {
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 5px 8px;
}
#${PANEL_ID} .trae-taskboard-action:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.25));
}
#${PANEL_ID} iframe {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: 0;
  background: var(--vscode-editor-background, #1e1e1e);
}
#${ENTRY_ID} {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 48px;
  border: 0;
  background: transparent;
  color: var(--vscode-activityBar-inactiveForeground, var(--vscode-foreground, #ccc));
  cursor: pointer;
}
#${ENTRY_ID}:hover,
#${ENTRY_ID}.active {
  color: var(--vscode-activityBar-foreground, var(--vscode-foreground, #fff));
}
#${ENTRY_ID}::before {
  content: "";
  position: absolute;
  left: 0;
  width: 2px;
  height: 24px;
  background: transparent;
}
#${ENTRY_ID}.active::before {
  background: var(--vscode-activityBar-activeBorder, #007acc);
}
#${FLOATING_ID} {
  position: fixed;
  z-index: 901;
  display: none;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  font-size: 12px;
}
#${FLOATING_ID}:hover {
  background: var(--vscode-button-hoverBackground, #1177bb);
}
`;
    document.head.appendChild(style);
  }

  function ensureEntry() {
    const activitybar = document.querySelector(".activitybar");
    if (activitybar && !document.getElementById(ENTRY_ID)) {
      const entry = document.createElement("button");
      entry.id = ENTRY_ID;
      entry.type = "button";
      entry.title = "Codex Taskboard 任务面板";
      entry.setAttribute("aria-label", "Codex Taskboard 任务面板");
      entry.append(buildIcon());
      entry.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        togglePanel();
      });
      activitybar.appendChild(entry);
      state.entry = entry;
    }
    if (!document.getElementById(FLOATING_ID)) {
      const floating = document.createElement("button");
      floating.id = FLOATING_ID;
      floating.type = "button";
      floating.textContent = "任务面板";
      floating.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        togglePanel();
      });
      document.body.appendChild(floating);
      state.floating = floating;
    }
  }

  function updateEntryVisibility() {
    const activitybar = document.querySelector(".activitybar");
    const visible = Boolean(activitybar && activitybar.getBoundingClientRect().width > 0);
    if (state.entry) state.entry.style.display = visible ? "flex" : "none";
    if (state.floating) {
      state.floating.style.display = visible ? "none" : "flex";
    }
  }

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) {
      state.panel = document.getElementById(PANEL_ID);
      state.frame = state.panel.querySelector("iframe");
      return;
    }
    ensureStyles();
    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = "任务面板";
    const actions = document.createElement("div");
    actions.className = "trae-taskboard-actions";

    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "trae-taskboard-action";
    refreshButton.textContent = "刷新";
    refreshButton.addEventListener("click", refresh);

    const browserButton = document.createElement("button");
    browserButton.type = "button";
    browserButton.className = "trae-taskboard-action";
    browserButton.textContent = "在浏览器打开";
    browserButton.addEventListener("click", () => {
      window.open(TASKBOARD_URL, "_blank", "noopener,noreferrer");
    });

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "trae-taskboard-action";
    closeButton.textContent = "关闭";
    closeButton.addEventListener("click", closePanel);

    actions.append(refreshButton, browserButton, closeButton);
    header.append(title, actions);

    const frame = document.createElement("iframe");
    frame.title = "Codex Taskboard";
    frame.setAttribute("allow", "clipboard-read; clipboard-write");
    frame.src = TASKBOARD_URL;

    panel.append(header, frame);
    document.body.appendChild(panel);
    state.panel = panel;
    state.frame = frame;
    panel.style.display = "none";

    const resizeObserver = new ResizeObserver(placePanel);
    resizeObserver.observe(document.querySelector(".part.editor") ?? document.body);
    state.layoutObserver = resizeObserver;
    window.addEventListener("resize", placePanel);
    placePanel();
  }

  function observeTheme() {
    if (state.themeObserver) return;
    state.themeObserver = new MutationObserver(() => {
      sendTheme();
    });
    state.themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  window.addEventListener("message", handleFrameMessage);
  ensureStyles();
  ensureEntry();
  observeTheme();

  const entryInterval = setInterval(() => {
    ensureEntry();
    updateEntryVisibility();
  }, 2000);
  window.addEventListener("beforeunload", () => clearInterval(entryInterval));

  window.__TRAE_TASKBOARD_V1__ = {
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
    refresh,
    isOpen: () => Boolean(state.panel && state.panel.style.display !== "none"),
  };

  buildPanel();
  if (localStorage.getItem(OPEN_STATE_KEY) === "1") openPanel();
  else updateEntryVisibility();
})();
