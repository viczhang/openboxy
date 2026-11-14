import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.MCP_PORT || 3100);
const COMPUTER_URL = (process.env.COMPUTER_URL || "http://openboxy:4100").replace(/\/+$/, "");
const UI_URL = (process.env.OPENBOXY_UI_URL || "http://openboxy:3001").replace(/\/+$/, "");
const COMPUTER_TOKEN = (process.env.COMPUTER_TOKEN || "").trim();
const MCP_TOKEN = (process.env.OPENBOXY_MCP_TOKEN || "").trim();
const DEFAULT_BOT_ID = (process.env.OPENBOXY_BOT_ID || "default").trim();
const PUBLIC_URL = (process.env.OPENBOXY_PUBLIC_URL || "").replace(/\/+$/, "");
const UI_AUTH = (process.env.OPENBOXY_UI_AUTH || "token").trim().toLowerCase();

if (!COMPUTER_TOKEN) {
  console.error("[openboxy-mcp] COMPUTER_TOKEN must be set.");
  process.exit(1);
}
if (!MCP_TOKEN) {
  console.error("[openboxy-mcp] OPENBOXY_MCP_TOKEN must be set.");
  process.exit(1);
}

function safeEqual(aStr: string, bStr: string): boolean {
  const a = Buffer.from(aStr);
  const b = Buffer.from(bStr);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signAccessToken(clientId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: "openboxy", cid: clientId, iat: Math.floor(Date.now() / 1000) }),
  ).toString("base64url");
  const sig = createHmac("sha256", MCP_TOKEN).update(payload).digest("base64url");
  return `obx.${payload}.${sig}`;
}

function verifyAccessToken(token: string): boolean {
  if (safeEqual(token, MCP_TOKEN)) return true;
  if (!token.startsWith("obx.")) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [, payload, sig] = parts;
  if (!payload || !sig) return false;
  const expected = createHmac("sha256", MCP_TOKEN).update(payload).digest("base64url");
  return safeEqual(sig, expected);
}

function authorized(req: Request): boolean {
  const auth = req.headers.get("authorization")?.trim() || "";
  const offered = auth.replace(/^Bearer\s+/i, "").trim();
  if (!offered) return false;
  return verifyAccessToken(offered);
}

function readCookie(req: Request, name: string): string {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return "";
}

function uiAuthorized(req: Request): boolean {
  if (UI_AUTH === "off" || UI_AUTH === "none" || UI_AUTH === "false") return true;
  if (authorized(req)) return true;
  const cookie = readCookie(req, "openboxy_ui");
  return cookie ? verifyAccessToken(cookie) : false;
}

function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

function renderLoginPage(nextPath: string, error?: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenBoxy Sign In</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; margin: 0; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 28px; width: 100%; max-width: 400px; box-shadow: 0 20px 40px rgba(0,0,0,.4); }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p { font-size: 14px; color: #94a3b8; margin: 0 0 18px; line-height: 1.5; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #f8fafc; font-size: 14px; margin-bottom: 16px; }
    button { width: 100%; padding: 11px; border-radius: 8px; border: 0; background: #3b82f6; color: #fff; font-weight: 600; font-size: 14px; cursor: pointer; }
    button:hover { background: #2563eb; }
    .err { background: #7f1d1d; color: #fecaca; padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>OpenBoxy</h1>
    <p>Enter your <code>OPENBOXY_MCP_TOKEN</code> to access the live browser, terminal, and UI.</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
      <label for="token">Access Token</label>
      <input id="token" name="token" type="password" autocomplete="current-password" required autofocus placeholder="Paste OPENBOXY_MCP_TOKEN" />
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(html, { status: error ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function publicOrigin(req: Request): string {
  if (PUBLIC_URL) return PUBLIC_URL;
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

type RegisteredClient = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
};

type AuthCodeRecord = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
};

const registeredClients = new Map<string, RegisteredClient>();
const authCodes = new Map<string, AuthCodeRecord>();

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderViewPage(initialTab: "browser" | "terminal" = "browser"): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenBoxy Live View</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; flex-direction: column; height: 100vh; }
    header { display: flex; gap: 8px; align-items: center; padding: 10px 14px; background: #1e293b; border-bottom: 1px solid #334155; flex-wrap: wrap; }
    .tabs { display: flex; gap: 4px; background: #0f172a; padding: 3px; border-radius: 8px; border: 1px solid #334155; }
    .tab { padding: 5px 12px; border-radius: 6px; border: 0; background: transparent; color: #94a3b8; font-weight: 600; cursor: pointer; font-size: 13px; }
    .tab.active { background: #334155; color: #f8fafc; }
    header form { display: flex; flex: 1; gap: 8px; min-width: 220px; }
    input[type="text"] { flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #f8fafc; font-size: 14px; }
    button { padding: 8px 14px; border-radius: 8px; border: 0; background: #3b82f6; color: #fff; font-weight: 600; cursor: pointer; font-size: 13px; white-space: nowrap; }
    button:hover { background: #2563eb; }
    button.sec { background: #334155; }
    button.sec:hover { background: #475569; }
    button.take { background: #d97706; }
    button.take:hover { background: #b45309; }
    button.release { background: #16a34a; }
    button.release:hover { background: #15803d; }
    .meta { font-size: 12px; color: #94a3b8; white-space: nowrap; }
    main { flex: 1; display: grid; place-items: center; overflow: auto; padding: 12px; position: relative; }
    img { max-width: 100%; max-height: calc(100vh - 76px); border: 2px solid #334155; border-radius: 8px; background: #fff; box-shadow: 0 12px 32px rgba(0,0,0,.45); outline: none; }
    img.controlling { border-color: #22c55e; cursor: crosshair; }
    #termWrap { display: none; width: 100%; height: 100%; background: #020617; border: 2px solid #334155; border-radius: 8px; padding: 8px; overflow: hidden; }
    #termWrap.controlling { border-color: #22c55e; }
    #terminal { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <header>
    <a href="/" style="color:#f8fafc;text-decoration:none;font-weight:700;">OpenBoxy</a>
    <div class="tabs">
      <button class="tab active" id="tabBrowser" type="button">Browser</button>
      <button class="tab" id="tabTerminal" type="button">Terminal</button>
    </div>
    <form id="navForm">
      <input id="urlInput" type="text" placeholder="https://example.com" />
      <button type="submit">Go</button>
    </form>
    <button class="take" id="controlBtn" type="button">Take Control</button>
    <button class="sec" id="refreshBtn" type="button">Refresh</button>
    <span class="meta" id="status">Loading…</span>
  </header>
  <main>
    <img id="screen" tabindex="0" alt="Live Browser View" />
    <div id="termWrap"><div id="terminal"></div></div>
  </main>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script>
    const img = document.getElementById("screen");
    const termWrap = document.getElementById("termWrap");
    const termEl = document.getElementById("terminal");
    const navForm = document.getElementById("navForm");
    const urlInput = document.getElementById("urlInput");
    const controlBtn = document.getElementById("controlBtn");
    const refreshBtn = document.getElementById("refreshBtn");
    const tabBrowser = document.getElementById("tabBrowser");
    const tabTerminal = document.getElementById("tabTerminal");
    const statusEl = document.getElementById("status");
    let busy = false;
    let controlling = false;
    let activeTab = "browser";
    let scrollTimer = null;
    let pendingScrollY = 0;
    let term = null;
    let fitAddon = null;
    let termWs = null;

    function updateControlUi(state) {
      controlling = state && state.holder === "human";
      controlBtn.textContent = controlling ? "Release Control" : "Take Control";
      controlBtn.className = controlling ? "release" : "take";
      img.className = controlling ? "controlling" : "";
      termWrap.className = controlling ? "controlling" : "";
    }

    async function syncControl() {
      try {
        const res = await fetch("/view/control");
        if (res.ok) updateControlUi(await res.json());
      } catch {}
    }

    async function refresh() {
      if (busy || activeTab !== "browser") return;
      busy = true;
      try {
        const res = await fetch("/view/screenshot");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        img.src = "data:image/png;base64," + data.base64;
        if (document.activeElement !== urlInput && data.url) {
          urlInput.value = data.url;
        }
        statusEl.textContent = (controlling ? "Controlling · " : "Viewing · ") + new Date().toLocaleTimeString();
      } catch (err) {
        statusEl.textContent = "Error: " + (err.message || err);
      } finally {
        busy = false;
      }
    }

    function connectTerminal() {
      if (!window.Terminal) {
        statusEl.textContent = "xterm.js failed to load";
        return;
      }
      if (!term) {
        term = new window.Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          theme: { background: "#020617", foreground: "#e2e8f0" },
        });
        fitAddon = new window.FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(termEl);
        term.onData((data) => {
          if (!controlling) {
            statusEl.textContent = "Click Take Control to type in terminal";
            return;
          }
          if (termWs && termWs.readyState === WebSocket.OPEN) {
            termWs.send(JSON.stringify({ type: "input", data }));
          }
        });
        window.addEventListener("resize", () => {
          if (activeTab === "terminal" && fitAddon && termWs && termWs.readyState === WebSocket.OPEN) {
            fitAddon.fit();
            termWs.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          }
        });
      }
      setTimeout(() => {
        if (fitAddon) fitAddon.fit();
      }, 20);
      if (termWs && (termWs.readyState === WebSocket.OPEN || termWs.readyState === WebSocket.CONNECTING)) {
        return;
      }
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      termWs = new WebSocket(proto + "//" + location.host + "/view/terminal");
      termWs.binaryType = "arraybuffer";
      termWs.onopen = () => {
        if (fitAddon) fitAddon.fit();
        termWs.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        statusEl.textContent = controlling ? "Terminal · Controlling" : "Terminal · Viewing (Take Control to type)";
      };
      termWs.onmessage = (e) => {
        if (typeof e.data === "string") {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === "snapshot") term.reset();
            else if (msg.type === "error") term.writeln("\\r\\n[Error: " + (msg.error || msg.message || "Unknown error") + "]");
          } catch {}
          return;
        }
        const bytes = new Uint8Array(e.data);
        term.write(bytes);
        if (termWs && termWs.readyState === WebSocket.OPEN) {
          termWs.send(JSON.stringify({ type: "ack", bytes: bytes.byteLength }));
        }
      };
      termWs.onclose = () => {
        statusEl.textContent = "Terminal disconnected";
      };
    }

    function setTab(tab) {
      activeTab = tab;
      tabBrowser.className = tab === "browser" ? "tab active" : "tab";
      tabTerminal.className = tab === "terminal" ? "tab active" : "tab";
      img.style.display = tab === "browser" ? "block" : "none";
      navForm.style.display = tab === "browser" ? "flex" : "none";
      refreshBtn.style.display = tab === "browser" ? "inline-block" : "none";
      termWrap.style.display = tab === "terminal" ? "block" : "none";
      if (tab === "terminal") {
        connectTerminal();
        if (term) term.focus();
      } else {
        refresh();
      }
    }

    tabBrowser.addEventListener("click", () => setTab("browser"));
    tabTerminal.addEventListener("click", () => setTab("terminal"));

    async function sendAction(path, payload) {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || ("HTTP " + res.status));
      }
      return res.json();
    }

    controlBtn.addEventListener("click", async () => {
      try {
        statusEl.textContent = controlling ? "Releasing…" : "Taking control…";
        const state = await sendAction(controlling ? "/view/control/release" : "/view/control/take", {});
        updateControlUi(state);
        if (controlling) {
          if (activeTab === "terminal" && term) term.focus();
          else img.focus();
        }
        if (activeTab === "browser") await refresh();
        else statusEl.textContent = controlling ? "Terminal · Controlling" : "Terminal · Viewing (Take Control to type)";
      } catch (err) {
        statusEl.textContent = "Error: " + (err.message || err);
      }
    });

    img.addEventListener("click", async (e) => {
      if (!controlling) return;
      img.focus();
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height || !img.naturalWidth || !img.naturalHeight) return;
      const x = Math.round((e.clientX - rect.left) * (img.naturalWidth / rect.width));
      const y = Math.round((e.clientY - rect.top) * (img.naturalHeight / rect.height));
      try {
        await sendAction("/view/click", { x, y });
        setTimeout(refresh, 150);
      } catch (err) {
        statusEl.textContent = "Error: " + (err.message || err);
      }
    });

    img.addEventListener("keydown", async (e) => {
      if (!controlling) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      try {
        if (e.key.length === 1) {
          await sendAction("/view/type", { text: e.key });
        } else {
          await sendAction("/view/key", { key: e.key });
        }
        setTimeout(refresh, 150);
      } catch (err) {
        statusEl.textContent = "Error: " + (err.message || err);
      }
    });

    img.addEventListener("paste", async (e) => {
      if (!controlling) return;
      const text = e.clipboardData && e.clipboardData.getData("text");
      if (!text) return;
      e.preventDefault();
      try {
        await sendAction("/view/type", { text });
        setTimeout(refresh, 150);
      } catch (err) {
        statusEl.textContent = "Error: " + (err.message || err);
      }
    });

    img.addEventListener("wheel", (e) => {
      if (!controlling) return;
      e.preventDefault();
      pendingScrollY += e.deltaY;
      if (scrollTimer) return;
      scrollTimer = setTimeout(async () => {
        const deltaY = Math.round(pendingScrollY);
        pendingScrollY = 0;
        scrollTimer = null;
        if (!deltaY) return;
        try {
          await sendAction("/view/scroll", { deltaY });
          setTimeout(refresh, 120);
        } catch (err) {
          statusEl.textContent = "Error: " + (err.message || err);
        }
      }, 120);
    }, { passive: false });

    navForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      let target = urlInput.value.trim();
      if (!target) return;
      if (!/^https?:\\/\\//i.test(target)) target = "https://" + target;
      statusEl.textContent = "Navigating…";
      await sendAction("/view/navigate", { url: target });
      await refresh();
    });

    refreshBtn.addEventListener("click", refresh);
    setTab(${JSON.stringify(initialTab)});
    syncControl().then(() => { if (activeTab === "browser") refresh(); });
    setInterval(() => { syncControl(); refresh(); }, 1500);
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderAuthorizePage(params: {
  clientName: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  error?: string;
}): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize OpenBoxy MCP</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 28px; max-width: 420px; width: 100%; box-shadow: 0 20px 40px rgba(0,0,0,.4); }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0 0 18px; color: #94a3b8; font-size: 14px; line-height: 1.5; }
    code { background: #0f172a; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: #38bdf8; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #f8fafc; font-size: 14px; margin-bottom: 16px; }
    button { width: 100%; padding: 11px; border-radius: 8px; border: 0; background: #3b82f6; color: white; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:hover { background: #2563eb; }
    .err { background: #7f1d1d; color: #fecaca; padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect to OpenBoxy</h1>
    <p><strong>${escapeHtml(params.clientName)}</strong> is requesting MCP access to your OpenBoxy terminal and browser.<br/>Redirect: <code>${escapeHtml(params.redirectUri)}</code></p>
    ${params.error ? `<div class="err">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}" />
      <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}" />
      <input type="hidden" name="state" value="${escapeHtml(params.state)}" />
      <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}" />
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.codeChallengeMethod)}" />
      <label for="token">OpenBoxy MCP Token (<code>OPENBOXY_MCP_TOKEN</code>)</label>
      <input id="token" name="token" type="password" autocomplete="current-password" required autofocus placeholder="Paste your OPENBOXY_MCP_TOKEN" />
      <button type="submit">Approve &amp; Connect</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: params.error ? 403 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function callComputer<T = Record<string, unknown>>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const method = options.method ?? (options.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = {
    "x-openbot-computer-token": COMPUTER_TOKEN,
    "x-openbot-bot-id": DEFAULT_BOT_ID,
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${COMPUTER_URL}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `HTTP ${res.status}: ${text.slice(0, 500)}`;
    throw new Error(errMsg);
  }

  return parsed as T;
}

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: process.env.OPENBOXY_MCP_NAME?.trim() || "boxy",
    version: "1.0.0",
  });

  server.registerTool(
    "shell",
    {
      description:
        "Run a bash command in the persistent workspace shell (/workspace). Returns stdout, stderr, exit code, and cwd.",
      inputSchema: {
        command: z.string().min(1).describe("Bash command to execute"),
        timeout_s: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe("Timeout in seconds (default 60, max 600)"),
      },
    },
    async ({ command, timeout_s }) => {
      const timeoutMs = timeout_s ? timeout_s * 1000 : undefined;
      const result = await callComputer("/exec", {
        body: { command, ...(timeoutMs ? { timeoutMs } : {}) },
        timeoutMs: (timeoutMs ?? 60_000) + 5_000,
      });
      return textResult(result);
    },
  );

  server.registerTool(
    "read_file",
    {
      description: "Read a file from /workspace (with optional 1-based line offset and limit).",
      inputSchema: {
        path: z.string().min(1).describe("File path relative to /workspace or inside /workspace"),
        offset: z.number().int().min(1).optional().describe("First line to return (1-based)"),
        limit: z.number().int().min(1).max(5000).optional().describe("Maximum lines to return"),
      },
    },
    async ({ path, offset, limit }) => {
      const res = await callComputer<{ contents?: string; path?: string; [k: string]: unknown }>("/files/read", {
        body: { path },
      });
      if (typeof res.contents === "string" && (offset !== undefined || limit !== undefined)) {
        const lines = res.contents.split("\n");
        const start = Math.max(0, (offset ?? 1) - 1);
        const end = limit !== undefined ? start + limit : lines.length;
        return textResult({
          ...res,
          offset: start + 1,
          totalLines: lines.length,
          contents: lines.slice(start, end).join("\n"),
        });
      }
      return textResult(res);
    },
  );

  server.registerTool(
    "write_file",
    {
      description: "Create or overwrite a file in /workspace (parent directories are created automatically).",
      inputSchema: {
        path: z.string().min(1).describe("Target file path"),
        content: z.string().describe("Full file contents"),
        append: z.boolean().optional().describe("Append instead of overwriting"),
      },
    },
    async ({ path, content, append }) => {
      const res = await callComputer("/files/write", {
        body: { path, contents: content, append: append === true },
      });
      return textResult(res);
    },
  );

  server.registerTool(
    "edit_file",
    {
      description: "Replace an exact string occurrence in an existing file in /workspace.",
      inputSchema: {
        path: z.string().min(1).describe("Target file path"),
        old_text: z.string().min(1).describe("Exact text to find"),
        new_text: z.string().describe("Replacement text"),
      },
    },
    async ({ path, old_text, new_text }) => {
      const readRes = await callComputer<{ contents?: string }>("/files/read", {
        body: { path },
      });
      const contents = readRes.contents;
      if (typeof contents !== "string") {
        throw new Error(`Unable to read text contents of ${path}`);
      }
      if (!contents.includes(old_text)) {
        throw new Error(`old_text not found in ${path}`);
      }
      const updated = contents.replace(old_text, new_text);
      const writeRes = await callComputer("/files/write", {
        body: { path, contents: updated, append: false },
      });
      return textResult(writeRes);
    },
  );

  server.registerTool(
    "list_dir",
    {
      description: "List files and directories inside /workspace.",
      inputSchema: {
        path: z.string().optional().describe("Directory path (defaults to /workspace root)"),
      },
    },
    async ({ path }) => {
      const res = await callComputer("/files/list", {
        body: path ? { path } : {},
      });
      return textResult(res);
    },
  );

  server.registerTool(
    "browser_navigate",
    {
      description: "Navigate the persistent Chromium browser to a URL and return readable page text.",
      inputSchema: {
        url: z.string().url().describe("Target URL (http:// or https://)"),
      },
    },
    async ({ url }) => {
      const res = await callComputer("/navigate", {
        body: { url },
        timeoutMs: 65_000,
      });
      return textResult(res);
    },
  );

  server.registerTool(
    "browser_snapshot",
    {
      description:
        "Take an accessibility (ARIA) snapshot of the current page. Returns snapshotId and element refs for browser_click / browser_type.",
      inputSchema: {},
    },
    async () => {
      const res = await callComputer("/snapshot", { body: {} });
      return textResult(res);
    },
  );

  server.registerTool(
    "browser_read",
    {
      description: "Read the current page's URL, title, and extracted readable text.",
      inputSchema: {},
    },
    async () => {
      const res = await callComputer("/read", { method: "GET" });
      return textResult(res);
    },
  );

  server.registerTool(
    "browser_click",
    {
      description: "Click an element from the latest browser_snapshot using its ref and snapshotId.",
      inputSchema: {
        ref: z.string().min(1).describe("Element ref from browser_snapshot"),
        snapshotId: z.number().int().describe("snapshotId from browser_snapshot"),
      },
    },
    async ({ ref, snapshotId }) => {
      const res = await callComputer("/click", {
        body: { ref, snapshotId },
      });
      return textResult(res);
    },
  );

  server.registerTool(
    "browser_type",
    {
      description: "Type text into an element from the latest browser_snapshot.",
      inputSchema: {
        ref: z.string().min(1).describe("Element ref from browser_snapshot"),
        snapshotId: z.number().int().describe("snapshotId from browser_snapshot"),
        text: z.string().describe("Text to type"),
        submit: z.boolean().optional().describe("Press Enter after typing"),
      },
    },
    async ({ ref, snapshotId, text, submit }) => {
      const res = await callComputer("/type", {
        body: { ref, snapshotId, text, submit: submit === true },
      });
      return textResult(res);
    },
  );

  server.registerTool(
    "browser_press",
    {
      description: "Press a keyboard key (e.g. Enter, Tab, Escape, ArrowDown) in the browser.",
      inputSchema: {
        key: z.string().min(1).describe("Key name"),
        ref: z.string().optional().describe("Optional element ref to focus first"),
        snapshotId: z.number().int().optional().describe("snapshotId if ref is provided"),
      },
    },
    async ({ key, ref, snapshotId }) => {
      const res = await callComputer("/key", {
        body: {
          key,
          ...(ref !== undefined ? { ref } : {}),
          ...(snapshotId !== undefined ? { snapshotId } : {}),
        },
      });
      return textResult(res);
    },
  );

  server.registerTool(
    "browser_scroll",
    {
      description: "Scroll the current page vertically by deltaY pixels (positive scrolls down, negative scrolls up).",
      inputSchema: {
        deltaY: z.number().describe("Vertical scroll delta in pixels"),
      },
    },
    async ({ deltaY }) => {
      const res = await callComputer("/scroll", {
        body: { deltaY },
      });
      return textResult(res);
    },
  );

  server.registerTool(
    "screenshot",
    {
      description: "Capture a visual PNG screenshot of the current browser viewport.",
      inputSchema: {},
    },
    async () => {
      const res = await callComputer<{
        base64: string;
        width: number;
        height: number;
        url: string;
        capturedAt: string;
      }>("/screenshot", { method: "GET" });

      return {
        content: [
          {
            type: "image" as const,
            data: res.base64,
            mimeType: "image/png",
          },
          {
            type: "text" as const,
            text: JSON.stringify({
              url: res.url,
              width: res.width,
              height: res.height,
              capturedAt: res.capturedAt,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "browser_view",
    {
      description: "Get the live OpenBot UI URL where the user can visually watch or take over the browser.",
      inputSchema: {},
    },
    async () => {
      return textResult({
        url: PUBLIC_URL ? `${PUBLIC_URL}/view` : "http://127.0.0.1:3100/view",
        openbotUi: PUBLIC_URL || "http://127.0.0.1:3001",
        note: "Open the /view URL in a browser to see the live MCP browser screen.",
      });
    },
  );

  return server;
}

const server = Bun.serve<{ upstream: WebSocket | null; pending: (string | Buffer)[]; uiPath?: string }>({
  port: PORT,
  idleTimeout: 255,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/view/terminal") {
      if (!uiAuthorized(req)) {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        return new Response(null, {
          status: 302,
          headers: { Location: "/login?next=%2Fview%2Fterminal" },
        });
      }
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (srv.upgrade(req, { data: { upstream: null, pending: [] } })) {
          return undefined as unknown as Response;
        }
        return Response.json({ error: "Expected WebSocket upgrade" }, { status: 400 });
      }
      return renderViewPage("terminal");
    }

    if (req.method === "GET" && url.pathname === "/login") {
      return renderLoginPage(safeNextPath(url.searchParams.get("next")));
    }

    if (req.method === "POST" && url.pathname === "/login") {
      const form = await req.formData();
      const token = String(form.get("token") || "").trim();
      const nextPath = safeNextPath(String(form.get("next") || "/"));
      if (!token || !safeEqual(token, MCP_TOKEN)) {
        return renderLoginPage(nextPath, "Invalid token.");
      }
      const isHttps =
        req.headers.get("x-forwarded-proto") === "https" || url.protocol === "https:";
      const cookie = `openboxy_ui=${encodeURIComponent(signAccessToken("ui"))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${isHttps ? "; Secure" : ""}`;
      return new Response(null, {
        status: 303,
        headers: { Location: nextPath, "Set-Cookie": cookie },
      });
    }

    if (req.method === "POST" && url.pathname === "/logout") {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/login",
          "Set-Cookie": "openboxy_ui=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", service: "openboxy-mcp" });
    }

    if (req.method === "GET" && url.pathname === "/") {
      if (!uiAuthorized(req)) {
        return new Response(null, {
          status: 302,
          headers: { Location: "/login?next=%2F" },
        });
      }
      const upstream = await fetch(`${UI_URL}/`, {
        headers: {
          host: "localhost:3001",
          origin: "http://localhost:3001",
          "accept-encoding": "identity",
        },
      });
      const ct = upstream.headers.get("content-type") || "";
      if (!upstream.ok || !ct.includes("text/html")) {
        return upstream;
      }
      const html = await upstream.text();
      const mcpUrl = `${publicOrigin(req)}/mcp`;
      const mcpName = process.env.OPENBOXY_MCP_NAME?.trim() || "boxy";
      const opencodeJson = JSON.stringify(
        {
          mcp: {
            [mcpName]: {
              type: "remote",
              url: mcpUrl,
              enabled: true,
            },
          },
        },
        null,
        2,
      );
      const agentPrompt = `Add the remote Streamable HTTP MCP server "${mcpName}" at ${mcpUrl} (with OAuth) to my MCP client config, then tell me how to finish signing in.`;
      const pill = `<div id="openboxy-nav-pill" style="position:fixed;bottom:14px;right:14px;z-index:99999;display:flex;gap:6px;align-items:center;background:rgba(15,23,42,0.94);border:1px solid #334155;border-radius:999px;padding:6px 10px;box-shadow:0 8px 24px rgba(0,0,0,0.35);font-family:system-ui,-apple-system,sans-serif;font-size:12px;">
  <a href="/view" style="color:#f8fafc;text-decoration:none;font-weight:600;padding:4px 10px;border-radius:999px;background:#2563eb;">Live Browser</a>
  <a href="/view/terminal" style="color:#e2e8f0;text-decoration:none;font-weight:600;padding:4px 10px;border-radius:999px;background:#334155;">Terminal</a>
  <button type="button" onclick="var m=document.getElementById('openboxy-mcp-modal');m.style.display=m.style.display==='block'?'none':'block';" style="color:#e2e8f0;border:0;cursor:pointer;font-weight:600;padding:4px 10px;border-radius:999px;background:#0f766e;font-size:12px;">MCP Setup</button>
</div>
<div id="openboxy-mcp-modal" style="display:none;position:fixed;bottom:58px;right:14px;z-index:99999;width:min(480px,calc(100vw - 28px));max-height:80vh;overflow:auto;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:12px;padding:14px 16px;box-shadow:0 16px 40px rgba(0,0,0,0.55);font-family:system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.45;">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
    <strong style="font-size:14px;color:#f8fafc;">Connect MCP (${escapeHtml(mcpName)})</strong>
    <button type="button" onclick="document.getElementById('openboxy-mcp-modal').style.display='none';" style="background:transparent;border:0;color:#94a3b8;cursor:pointer;font-size:16px;line-height:1;">&times;</button>
  </div>
  <div style="margin-bottom:10px;color:#cbd5e1;">Endpoint: <code style="background:#1e293b;padding:2px 6px;border-radius:4px;color:#93c5fd;">${escapeHtml(mcpUrl)}</code></div>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;color:#cbd5e1;">
    <span><strong>Option 1 — Paste to an AI Agent</strong> (OpenCode, Claude Code, Cursor, Codex):</span>
    <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('openboxy-agent-prompt').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);" style="background:#334155;color:#f8fafc;border:0;border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;">Copy</button>
  </div>
  <pre id="openboxy-agent-prompt" style="margin:0 0 10px 0;padding:8px 10px;background:#020617;border:1px solid #1e293b;border-radius:8px;white-space:pre-wrap;word-break:break-word;font-size:11px;color:#a7f3d0;">${escapeHtml(agentPrompt)}</pre>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;color:#cbd5e1;">
    <span><strong>Option 2 — Manual JSON</strong> (<code style="background:#1e293b;padding:1px 5px;border-radius:4px;">~/.config/opencode/opencode.jsonc</code>):</span>
    <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('openboxy-mcp-json').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);" style="background:#334155;color:#f8fafc;border:0;border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;">Copy</button>
  </div>
  <pre id="openboxy-mcp-json" style="margin:0 0 8px 0;padding:8px 10px;background:#020617;border:1px solid #1e293b;border-radius:8px;overflow:auto;font-size:11px;color:#e2e8f0;">${escapeHtml(opencodeJson)}</pre>
  <div style="color:#94a3b8;font-size:12px;">Then in OpenCode run <code style="background:#1e293b;padding:1px 5px;border-radius:4px;color:#e2e8f0;">/mcps</code>, select <strong style="color:#e2e8f0;">${escapeHtml(mcpName)}</strong>, and sign in with your <code style="background:#1e293b;padding:1px 5px;border-radius:4px;">OPENBOXY_MCP_TOKEN</code>.</div>
</div>`;
      const patched = html.includes("</body>")
        ? html.replace("</body>", `${pill}</body>`)
        : `${html}${pill}`;
      const headers = new Headers(upstream.headers);
      headers.delete("content-length");
      return new Response(patched, { status: upstream.status, headers });
    }

    if (url.pathname === "/view" || url.pathname.startsWith("/view/")) {
      if (!uiAuthorized(req)) {
        if (req.method === "GET" && url.pathname === "/view") {
          return new Response(null, {
            status: 302,
            headers: { Location: "/login?next=%2Fview" },
          });
        }
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    if (req.method === "GET" && url.pathname === "/view") {
      return renderViewPage();
    }

    if (req.method === "GET" && url.pathname === "/view/screenshot") {
      const res = await callComputer("/screenshot", { method: "GET" });
      return Response.json(res);
    }

    if (req.method === "POST" && url.pathname === "/view/navigate") {
      const body = (await req.json().catch(() => null)) as { url?: string } | null;
      if (!body?.url) return Response.json({ error: "url is required" }, { status: 400 });
      const res = await callComputer("/navigate", { body: { url: body.url }, timeoutMs: 65_000 });
      return Response.json(res);
    }

    if (req.method === "GET" && url.pathname === "/view/control") {
      const res = await callComputer("/control", { method: "GET" });
      return Response.json(res);
    }

    if (req.method === "POST" && url.pathname === "/view/control/take") {
      type ControlShape = {
        holder?: string;
        requested?: boolean;
        requestId?: string;
        request?: { id?: string; requestId?: string; status?: string };
      };
      const extractId = (c: ControlShape): string | undefined =>
        c.request?.id ?? c.request?.requestId ?? c.requestId;

      const current = (await callComputer("/control", { method: "GET" })) as ControlShape;
      if (current.holder === "human") {
        return Response.json(current);
      }
      let requestId =
        current.requested && current.request?.status === "waiting"
          ? extractId(current)
          : undefined;
      if (!requestId) {
        const reqRes = (await callComputer("/control/request", {
          body: { source: "manual", reason: "Owner taking control from /view" },
        })) as ControlShape;
        requestId = extractId(reqRes);
      }
      if (!requestId) {
        return Response.json({ error: "Could not obtain control requestId" }, { status: 500 });
      }
      const taken = await callComputer("/control/take", {
        body: { requestId, by: "owner" },
      });
      return Response.json(taken);
    }

    if (req.method === "POST" && url.pathname === "/view/control/release") {
      const current = (await callComputer("/control", { method: "GET" })) as {
        requestId?: string;
        request?: { id?: string; requestId?: string };
      };
      const requestId = current.request?.id ?? current.request?.requestId ?? current.requestId;
      if (!requestId) {
        return Response.json(current);
      }
      const released = await callComputer("/control/release", {
        body: { requestId },
      });
      return Response.json(released);
    }

    if (req.method === "POST" && url.pathname === "/view/click") {
      const body = (await req.json().catch(() => null)) as { x?: number; y?: number } | null;
      if (typeof body?.x !== "number" || typeof body?.y !== "number") {
        return Response.json({ error: "x and y are required" }, { status: 400 });
      }
      try {
        const res = await callComputer("/human/click", { body: { x: body.x, y: body.y } });
        return Response.json(res);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/type") {
      const body = (await req.json().catch(() => null)) as { text?: string } | null;
      if (typeof body?.text !== "string") {
        return Response.json({ error: "text is required" }, { status: 400 });
      }
      try {
        const res = await callComputer("/human/type", { body: { text: body.text } });
        return Response.json(res);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/key") {
      const body = (await req.json().catch(() => null)) as { key?: string } | null;
      if (typeof body?.key !== "string" || !body.key) {
        return Response.json({ error: "key is required" }, { status: 400 });
      }
      try {
        const res = await callComputer("/human/key", { body: { key: body.key } });
        return Response.json(res);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/scroll") {
      const body = (await req.json().catch(() => null)) as { deltaY?: number } | null;
      if (typeof body?.deltaY !== "number") {
        return Response.json({ error: "deltaY is required" }, { status: 400 });
      }
      try {
        const res = await callComputer("/human/scroll", { body: { deltaY: body.deltaY } });
        return Response.json(res);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
      }
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp")
    ) {
      const origin = publicOrigin(req);
      return Response.json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
      });
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/openid-configuration")
    ) {
      const origin = publicOrigin(req);
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      });
    }

    if (req.method === "POST" && url.pathname === "/oauth/register") {
      const body = (await req.json().catch(() => null)) as {
        client_name?: unknown;
        redirect_uris?: unknown;
      } | null;
      const redirectUris = Array.isArray(body?.redirect_uris)
        ? body.redirect_uris.filter((u): u is string => typeof u === "string" && u.length > 0)
        : [];
      if (redirectUris.length === 0) {
        return Response.json(
          { error: "invalid_client_metadata", error_description: "redirect_uris is required" },
          { status: 400 },
        );
      }
      const clientId = `obx_client_${randomBytes(12).toString("hex")}`;
      const clientName =
        typeof body?.client_name === "string" && body.client_name.trim()
          ? body.client_name.trim()
          : "MCP Client";
      registeredClients.set(clientId, {
        client_id: clientId,
        client_name: clientName,
        redirect_uris: redirectUris,
      });
      return Response.json(
        {
          client_id: clientId,
          client_name: clientName,
          redirect_uris: redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
        },
        { status: 201 },
      );
    }

    if (req.method === "GET" && url.pathname === "/oauth/authorize") {
      const clientId = url.searchParams.get("client_id") || "";
      const redirectUri = url.searchParams.get("redirect_uri") || "";
      const state = url.searchParams.get("state") || "";
      const codeChallenge = url.searchParams.get("code_challenge") || "";
      const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "S256";
      if (!clientId || !redirectUri || !codeChallenge || codeChallengeMethod !== "S256") {
        return Response.json(
          { error: "invalid_request", error_description: "Missing client_id, redirect_uri, or S256 code_challenge" },
          { status: 400 },
        );
      }
      const client = registeredClients.get(clientId);
      if (client && !client.redirect_uris.includes(redirectUri)) {
        return Response.json({ error: "invalid_request", error_description: "redirect_uri mismatch" }, { status: 400 });
      }
      return renderAuthorizePage({
        clientName: client?.client_name || clientId,
        clientId,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
      });
    }

    if (req.method === "POST" && url.pathname === "/oauth/authorize") {
      const form = await req.formData().catch(() => null);
      const clientId = String(form?.get("client_id") || "");
      const redirectUri = String(form?.get("redirect_uri") || "");
      const state = String(form?.get("state") || "");
      const codeChallenge = String(form?.get("code_challenge") || "");
      const codeChallengeMethod = String(form?.get("code_challenge_method") || "S256");
      const token = String(form?.get("token") || "").trim();
      const client = registeredClients.get(clientId);
      if (!clientId || !redirectUri || !codeChallenge || codeChallengeMethod !== "S256") {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      if (client && !client.redirect_uris.includes(redirectUri)) {
        return Response.json({ error: "invalid_request", error_description: "redirect_uri mismatch" }, { status: 400 });
      }
      if (!safeEqual(token, MCP_TOKEN)) {
        return renderAuthorizePage({
          clientName: client?.client_name || clientId,
          clientId,
          redirectUri,
          state,
          codeChallenge,
          codeChallengeMethod,
          error: "Invalid OPENBOXY_MCP_TOKEN. Please try again.",
        });
      }
      const code = randomBytes(24).toString("base64url");
      authCodes.set(code, {
        clientId,
        redirectUri,
        codeChallenge,
        expiresAt: Date.now() + 5 * 60_000,
      });
      const dest = new URL(redirectUri);
      dest.searchParams.set("code", code);
      if (state) dest.searchParams.set("state", state);
      return Response.redirect(dest.toString(), 302);
    }

    if (req.method === "POST" && url.pathname === "/oauth/token") {
      const ct = req.headers.get("content-type") || "";
      let params: Record<string, string> = {};
      if (ct.includes("application/x-www-form-urlencoded")) {
        const form = new URLSearchParams(await req.text());
        for (const [k, v] of form.entries()) params[k] = v;
      } else {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        for (const [k, v] of Object.entries(body)) {
          if (typeof v === "string") params[k] = v;
        }
      }
      if (params.grant_type !== "authorization_code") {
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }
      const record = params.code ? authCodes.get(params.code) : undefined;
      if (params.code) authCodes.delete(params.code);
      if (!record || record.expiresAt < Date.now()) {
        return Response.json({ error: "invalid_grant", error_description: "Code expired or invalid" }, { status: 400 });
      }
      if (params.redirect_uri && params.redirect_uri !== record.redirectUri) {
        return Response.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, { status: 400 });
      }
      const verifier = params.code_verifier || "";
      const computed = createHash("sha256").update(verifier).digest("base64url");
      if (!verifier || !safeEqual(computed, record.codeChallenge)) {
        return Response.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, { status: 400 });
      }
      return Response.json({
        access_token: signAccessToken(record.clientId),
        token_type: "Bearer",
        expires_in: 30 * 24 * 60 * 60,
      });
    }

    if (url.pathname === "/mcp") {
      if (!authorized(req)) {
        const origin = publicOrigin(req);
        return Response.json(
          { error: "Unauthorized" },
          {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
            },
          },
        );
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcp = buildMcpServer();
      transport.onclose = () => {
        void mcp.close().catch(() => {});
      };
      await mcp.connect(transport);
      return await transport.handleRequest(req);
    }

    if (!uiAuthorized(req)) {
      if (req.method === "GET" && (req.headers.get("accept") || "").includes("text/html")) {
        return new Response(null, {
          status: 302,
          headers: { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` },
        });
      }
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (srv.upgrade(req, { data: { upstream: null, pending: [], uiPath: url.pathname + url.search } })) {
        return undefined as unknown as Response;
      }
      return Response.json({ error: "Expected WebSocket upgrade" }, { status: 400 });
    }

    const fwdHeaders = new Headers(req.headers);
    fwdHeaders.set("host", "localhost:3001");
    fwdHeaders.set("origin", "http://localhost:3001");
    const upstream = await fetch(`${UI_URL}${url.pathname}${url.search}`, {
      method: req.method,
      headers: fwdHeaders,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  },
  websocket: {
    open(ws) {
      const upstream = ws.data.uiPath
        ? new WebSocket(`${UI_URL.replace(/^http/i, "ws")}${ws.data.uiPath}`, {
            headers: { host: "localhost:3001", origin: "http://localhost:3001" },
          } as unknown as string[])
        : new WebSocket(
            `${COMPUTER_URL.replace(/^http/i, "ws")}/terminal?bot=${encodeURIComponent(DEFAULT_BOT_ID)}&token=${encodeURIComponent(COMPUTER_TOKEN)}`,
          );
      upstream.binaryType = "arraybuffer";
      ws.data.upstream = upstream;
      upstream.onopen = () => {
        for (const msg of ws.data.pending) {
          upstream.send(msg);
        }
        ws.data.pending = [];
      };
      upstream.onmessage = (e) => {
        if (ws.readyState !== 1) return;
        if (e.data instanceof ArrayBuffer) {
          ws.send(new Uint8Array(e.data));
        } else {
          ws.send(String(e.data));
        }
      };
      upstream.onclose = () => {
        try { ws.close(); } catch {}
      };
      upstream.onerror = () => {
        try { ws.close(); } catch {}
      };
    },
    message(ws, msg) {
      const upstream = ws.data.upstream;
      if (!upstream) return;
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(msg);
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        ws.data.pending.push(msg);
      }
    },
    close(ws) {
      try { ws.data.upstream?.close(); } catch {}
      ws.data.upstream = null;
    },
  },
});

console.log(`[openboxy-mcp] Listening on http://0.0.0.0:${server.port}/mcp (upstream ${COMPUTER_URL})`);
