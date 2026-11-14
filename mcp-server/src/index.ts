import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { SandboxManager, sanitizeUserId } from "./sandbox.ts";

const PORT = Number(process.env.MCP_PORT || 3100);
const DEFAULT_USER_ID = sanitizeUserId(process.env.OPENBOXY_BOT_ID || "default");
const PUBLIC_URL = (process.env.OPENBOXY_PUBLIC_URL || "").replace(/\/+$/, "");
const UI_AUTH = (process.env.OPENBOXY_UI_AUTH || "token").trim().toLowerCase();
const USERS_FILE = (process.env.OPENBOXY_USERS_FILE || "/data/users.json").trim();

function loadUserTokens(): Map<string, string> {
  const users = new Map<string, string>();
  const defaultToken = (process.env.OPENBOXY_MCP_TOKEN || "").trim();
  if (defaultToken) {
    users.set(DEFAULT_USER_ID, defaultToken);
  }

  const rawList = (process.env.OPENBOXY_USERS || "").trim();
  if (rawList) {
    for (const entry of rawList.split(/[\n,]+/)) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const sep = trimmed.includes(":") ? ":" : "=";
      const idx = trimmed.indexOf(sep);
      if (idx <= 0) continue;
      const uid = sanitizeUserId(trimmed.slice(0, idx));
      const tok = trimmed.slice(idx + 1).trim();
      if (uid && tok) users.set(uid, tok);
    }
  }

  const parseJsonMap = (raw: string) => {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && v.trim()) {
          users.set(sanitizeUserId(k), v.trim());
        }
      }
    }
  };

  const rawJson = (process.env.OPENBOXY_USERS_JSON || "").trim();
  if (rawJson) {
    try {
      parseJsonMap(rawJson);
    } catch (err) {
      console.error("[openboxy-mcp] Invalid OPENBOXY_USERS_JSON:", err);
      process.exit(1);
    }
  }

  if (USERS_FILE && existsSync(USERS_FILE)) {
    try {
      parseJsonMap(readFileSync(USERS_FILE, "utf8"));
    } catch (err) {
      console.error(`[openboxy-mcp] Failed reading ${USERS_FILE}:`, err);
    }
  }

  return users;
}

const userTokens = loadUserTokens();
if (userTokens.size === 0) {
  console.error("[openboxy-mcp] At least one user token must be set via OPENBOXY_MCP_TOKEN, OPENBOXY_USERS, or OPENBOXY_USERS_JSON.");
  process.exit(1);
}

const SESSION_SECRET = (() => {
  const explicit = (process.env.OPENBOXY_SESSION_SECRET || "").trim();
  if (explicit) return explicit;
  const seed = Array.from(userTokens.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join("|");
  return createHash("sha256").update(`openboxy:${seed}`).digest("hex");
})();

const sandbox = new SandboxManager();

function safeEqual(aStr: string, bStr: string): boolean {
  const a = Buffer.from(aStr);
  const b = Buffer.from(bStr);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signAccessToken(clientId: string, userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: "openboxy", uid: userId, cid: clientId, iat: Math.floor(Date.now() / 1000) }),
  ).toString("base64url");
  const sig = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `obx.${payload}.${sig}`;
}

function resolveRawApiToken(offered: string): string | null {
  let matchedUser: string | null = null;
  for (const [uid, expected] of userTokens.entries()) {
    if (safeEqual(offered, expected)) {
      matchedUser = uid;
    }
  }
  return matchedUser;
}

function resolveTokenUser(token: string): string | null {
  if (!token) return null;
  const direct = resolveRawApiToken(token);
  if (direct) return direct;

  if (!token.startsWith("obx.")) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [, payload, sig] = parts;
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { uid?: unknown };
    if (typeof parsed.uid === "string" && userTokens.has(parsed.uid)) {
      return parsed.uid;
    }
  } catch {}
  return null;
}

function authorized(req: Request): string | null {
  const auth = req.headers.get("authorization")?.trim() || "";
  const offered = auth.replace(/^Bearer\s+/i, "").trim();
  if (!offered) return null;
  return resolveTokenUser(offered);
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

function uiAuthorized(req: Request): string | null {
  if (UI_AUTH === "off" || UI_AUTH === "none" || UI_AUTH === "false") {
    return DEFAULT_USER_ID;
  }
  const bearerUser = authorized(req);
  if (bearerUser) return bearerUser;
  const cookie = readCookie(req, "openboxy_ui");
  return cookie ? resolveTokenUser(cookie) : null;
}

function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

const OPENBOXY_THEME_HEAD = `
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.2.5/index.css" />
  <script>
    (function () {
      try {
        var dark = window.localStorage.getItem("openbot-theme") === "dark";
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.colorScheme = dark ? "dark" : "light";
      } catch {}
    })();
  </script>
  <style>
    :root {
      --background: oklch(0.983 0.003 286.4);
      --card: oklch(1 0 0);
      --card-foreground: oklch(0.108 0.015 220.9);
      --primary: oklch(0.108 0.015 220.9);
      --primary-foreground: oklch(1 0 0);
      --muted: oklch(0.956 0.005 286.3);
      --muted-foreground: oklch(0.506 0.013 285.9);
      --border: oklch(0.894 0.014 286.1);
      --destructive: oklch(0.577 0.245 27.325);
    }
    .dark {
      --background: oklch(0.182 0.023 296.6);
      --card: oklch(0.212 0.028 297.1);
      --card-foreground: oklch(0.956 0.005 286.3);
      --primary: oklch(0.956 0.005 286.3);
      --primary-foreground: oklch(0.108 0.015 220.9);
      --muted: oklch(0.253 0.032 297.6);
      --muted-foreground: oklch(0.69 0.017 285.9);
      --border: oklch(0.28 0.035 298.6);
      --destructive: oklch(0.704 0.191 22.216);
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif; background: var(--background); color: var(--card-foreground); -webkit-font-smoothing: antialiased; }
    button, input { font-family: inherit; }
    .obx-center { display: grid; place-items: center; min-height: 100vh; padding: 16px; }
    .obx-card { background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: 14px; padding: 28px; width: 100%; max-width: 410px; box-shadow: 0 12px 32px rgba(0,0,0,.08); }
    .dark .obx-card { box-shadow: 0 20px 44px rgba(0,0,0,.4); }
    .obx-card h1 { font-size: 20px; font-weight: 700; margin: 0 0 8px; letter-spacing: -0.01em; }
    .obx-card p { font-size: 14px; color: var(--muted-foreground); margin: 0 0 18px; line-height: 1.5; }
    .obx-card label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    .obx-card code { background: var(--muted); color: var(--card-foreground); padding: 2px 6px; border-radius: 6px; font-size: 12px; }
    .obx-card input[type="password"] { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--background); color: var(--card-foreground); font-size: 14px; margin-bottom: 16px; outline: none; }
    .obx-card input[type="password"]:focus { border-color: var(--primary); }
    .obx-card button { width: 100%; padding: 10px 14px; border-radius: 10px; border: 0; background: var(--primary); color: var(--primary-foreground); font-weight: 600; font-size: 14px; cursor: pointer; }
    .obx-card button:hover { opacity: 0.9; }
    .obx-err { background: color-mix(in oklch, var(--destructive) 14%, transparent); color: var(--destructive); border: 1px solid color-mix(in oklch, var(--destructive) 30%, transparent); padding: 10px 12px; border-radius: 10px; font-size: 13px; margin-bottom: 14px; }
  </style>
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderLoginPage(nextPath: string, error?: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenBoxy Sign In</title>
  ${OPENBOXY_THEME_HEAD}
  <style>
    .obx-login-wrap {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 24px;
      min-height: 100vh;
      padding: 24px 16px;
      background:
        radial-gradient(600px circle at 50% 18%, color-mix(in oklch, var(--primary) 7%, transparent), transparent 70%),
        var(--background);
    }
    .obx-hero { text-align: center; max-width: 520px; }
    .obx-badge {
      display: inline-block;
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted-foreground);
      background: var(--muted);
      border: 1px solid var(--border);
      padding: 4px 10px;
      border-radius: 999px;
      margin-bottom: 12px;
    }
    .obx-hero h2 {
      margin: 0 0 8px;
      font-size: clamp(22px, 3.6vw, 30px);
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1.2;
      color: var(--card-foreground);
    }
    .obx-hero p {
      margin: 0;
      font-size: 14.5px;
      line-height: 1.55;
      color: var(--muted-foreground);
    }
  </style>
</head>
<body class="obx-login-wrap">
  <div class="obx-hero">
    <span class="obx-badge">OpenBoxy MCP</span>
    <h2>Give your AI agents a real browser and terminal.</h2>
    <p>OpenBoxy equips chat-only AI agents with a persistent Chromium browser, workspace shell, and live human takeover over MCP.</p>
  </div>
  <div class="obx-card">
    <h1>Sign In</h1>
    <p>Enter your API access token to open your isolated browser session and terminal.</p>
    ${error ? `<div class="obx-err">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
      <label for="token">API Access Token</label>
      <input id="token" name="token" type="password" autocomplete="current-password" required autofocus placeholder="Paste your API token" />
      <button type="submit">Sign In</button>
    </form>
    <p style="margin: 16px 0 0; font-size: 12.5px; text-align: center;">
      New here? See <a href="https://github.com/viczhang/openboxy" target="_blank" rel="noopener noreferrer" style="color: var(--card-foreground); font-weight: 600;">github.com/viczhang/openboxy</a> to learn how OpenBoxy works or host your own.
    </p>
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
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
};

const registeredClients = new Map<string, RegisteredClient>();
const authCodes = new Map<string, AuthCodeRecord>();

function renderViewPage(req: Request, userId: string, initialTab: "browser" | "terminal" | "files" = "browser"): Response {
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
  const showLogout = UI_AUTH !== "off" && UI_AUTH !== "none" && UI_AUTH !== "false";

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenBoxy</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css" />
  ${OPENBOXY_THEME_HEAD}
  <style>
    body { display: flex; flex-direction: column; height: 100vh; }
    header { display: flex; gap: 10px; align-items: center; padding: 8px 14px; background: var(--card); border-bottom: 1px solid var(--border); flex-wrap: nowrap; min-height: 50px; }
    .brand { color: var(--card-foreground); text-decoration: none; font-size: 14px; font-weight: 600; letter-spacing: -0.05em; line-height: 1.25; padding: 5px 8px; border-radius: 8px; flex-shrink: 0; }
    .brand:hover { background: var(--muted); }
    .tabs { display: flex; gap: 2px; background: var(--muted); padding: 3px; border-radius: 9px; border: 1px solid var(--border); flex-shrink: 0; }
    .tab { padding: 4px 11px; border-radius: 6px; border: 0; background: transparent; color: var(--muted-foreground); font-weight: 600; cursor: pointer; font-size: 12.5px; }
    .tab.active { background: var(--card); color: var(--card-foreground); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    .url-bar { display: flex; flex: 1; align-items: center; gap: 4px; min-width: 140px; max-width: 680px; background: var(--background); border: 1px solid var(--border); border-radius: 9px; padding: 2px 4px 2px 10px; }
    .url-bar:focus-within { border-color: var(--primary); }
    .url-bar input[type="text"] { flex: 1; min-width: 0; padding: 4px 0; border: 0; background: transparent; color: var(--card-foreground); font-size: 12.5px; outline: none; }
    .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border-radius: 7px; border: 0; background: transparent; color: var(--muted-foreground); cursor: pointer; font-size: 14px; }
    .icon-btn:hover { background: var(--muted); color: var(--card-foreground); }
    .spacer { flex: 1; display: none; }
    .actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-shrink: 0; }
    button { padding: 6px 12px; border-radius: 9px; border: 1px solid transparent; background: var(--primary); color: var(--primary-foreground); font-weight: 600; cursor: pointer; font-size: 12.5px; white-space: nowrap; }
    button:hover { opacity: 0.9; }
    button.sec { background: var(--muted); color: var(--card-foreground); border-color: var(--border); }
    button.sec:hover { opacity: 0.85; }
    button.take { background: #d97706; color: #fff; }
    button.release { background: #16a34a; color: #fff; }
    .meta { font-size: 11.5px; color: var(--muted-foreground); white-space: nowrap; max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
    .menu-wrap { position: relative; }
    .menu-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 10px; border-radius: 9px; border: 1px solid var(--border); background: var(--muted); color: var(--card-foreground); font-weight: 600; font-size: 12.5px; cursor: pointer; }
    .menu-btn:hover { opacity: 0.85; }
    .menu-pop { display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 190px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 6px; box-shadow: 0 14px 36px rgba(0,0,0,.18); z-index: 1000; }
    .menu-pop.open { display: flex; flex-direction: column; gap: 2px; }
    .menu-head { padding: 6px 10px; font-size: 11.5px; color: var(--muted-foreground); border-bottom: 1px solid var(--border); margin-bottom: 4px; }
    .menu-item { display: flex; align-items: center; justify-content: space-between; width: 100%; text-align: left; padding: 7px 10px; border-radius: 8px; border: 0; background: transparent; color: var(--card-foreground); font-size: 12.5px; font-weight: 500; cursor: pointer; text-decoration: none; }
    .menu-item:hover { background: var(--muted); opacity: 1; }
    .menu-item.danger { color: var(--destructive); }
    @media (max-width: 720px) { .meta { display: none; } header { gap: 6px; padding: 8px 10px; } }
    main { flex: 1; display: grid; place-items: center; overflow: auto; padding: 12px; position: relative; }
    img { max-width: 100%; max-height: calc(100vh - 76px); border: 2px solid var(--border); border-radius: 12px; background: #fff; box-shadow: 0 10px 28px rgba(0,0,0,.12); outline: none; display: block; }
    .dark img { box-shadow: 0 12px 32px rgba(0,0,0,.45); }
    img.controlling { border-color: #22c55e; cursor: crosshair; }
    #browserWrap { display: flex; align-items: stretch; gap: 8px; max-width: 100%; max-height: calc(100vh - 76px); }
    #vScroll { display: flex; flex-direction: column; align-items: center; width: 22px; background: var(--card); border: 1px solid var(--border); border-radius: 11px; padding: 3px; gap: 4px; flex-shrink: 0; user-select: none; }
    #vScroll.disabled { opacity: 0.4; }
    .vscroll-step { width: 16px; height: 18px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--muted-foreground); font-size: 9px; display: grid; place-items: center; cursor: pointer; }
    .vscroll-step:hover { background: var(--muted); color: var(--card-foreground); opacity: 1; }
    #vTrack { position: relative; flex: 1; width: 100%; border-radius: 6px; background: var(--muted); cursor: pointer; touch-action: none; }
    #vThumb { position: absolute; left: 2px; right: 2px; top: 0; height: 32px; border-radius: 5px; background: var(--muted-foreground); opacity: 0.55; cursor: grab; transition: opacity 0.15s; }
    #vThumb:hover, #vThumb.dragging { opacity: 0.9; cursor: grabbing; }
    #termWrap { display: none; width: 100%; height: 100%; background: var(--card); border: 2px solid var(--border); border-radius: 12px; padding: 10px; overflow: hidden; }
    #termWrap.controlling { border-color: #22c55e; }
    #terminal { width: 100%; height: 100%; }
    #filesWrap { display: none; width: 100%; height: 100%; grid-template-columns: minmax(260px, 380px) 1fr; gap: 12px; }
    @media (max-width: 820px) { #filesWrap { grid-template-columns: 1fr; grid-template-rows: 260px 1fr; } }
    .files-panel, .preview-panel { display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; min-height: 0; }
    .files-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--muted); font-size: 12px; }
    .crumbs { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-width: 0; }
    .crumb { border: 0; background: transparent; color: var(--card-foreground); font-weight: 600; padding: 2px 6px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    .crumb:hover { background: var(--card); }
    .files-list { flex: 1; overflow: auto; padding: 6px; }
    .file-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; border-radius: 8px; cursor: pointer; font-size: 12.5px; }
    .file-row:hover { background: var(--muted); }
    .file-row.active { background: var(--muted); outline: 1px solid var(--border); }
    .file-name { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .file-meta { display: flex; align-items: center; gap: 6px; color: var(--muted-foreground); font-size: 11.5px; flex-shrink: 0; }
    .file-act { border: 0; background: transparent; color: var(--muted-foreground); padding: 2px 5px; border-radius: 5px; cursor: pointer; font-size: 12px; }
    .file-act:hover { background: var(--card); color: var(--card-foreground); }
    .file-act.del:hover { color: var(--destructive); }
    .preview-body { flex: 1; overflow: auto; padding: 14px; display: grid; place-items: center; }
    .preview-body img { max-width: 100%; max-height: 100%; border: 1px solid var(--border); border-radius: 8px; box-shadow: none; }
    .preview-body pre { width: 100%; height: 100%; margin: 0; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: var(--card-foreground); }
    .preview-empty { color: var(--muted-foreground); font-size: 13px; text-align: center; }
    #mcpModal { display: none; position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,0.45); place-items: center; padding: 16px; }
    #mcpModal .modal-card { width: min(500px, 100%); max-height: 85vh; overflow: auto; background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: 14px; padding: 20px; box-shadow: 0 20px 50px rgba(0,0,0,0.3); font-size: 13px; line-height: 1.5; }
    #mcpModal pre { margin: 0 0 12px; padding: 10px 12px; background: var(--muted); border: 1px solid var(--border); border-radius: 10px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; color: var(--card-foreground); }
    #mcpModal code { background: var(--muted); color: var(--card-foreground); padding: 2px 6px; border-radius: 6px; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <a class="brand" href="/">OpenBoxy</a>
    <div class="tabs">
      <button class="tab active" id="tabBrowser" type="button">Browser</button>
      <button class="tab" id="tabTerminal" type="button">Terminal</button>
      <button class="tab" id="tabFiles" type="button">Files</button>
    </div>
    <form id="navForm" class="url-bar">
      <input id="urlInput" type="text" placeholder="https://example.com" />
      <button class="icon-btn" id="refreshBtn" type="button" title="Refresh view">&#8635;</button>
      <button class="icon-btn" type="submit" title="Navigate">&#8594;</button>
    </form>
    <div class="actions">
      <span class="meta" id="status">Loading…</span>
      <button class="take" id="controlBtn" type="button">Take Control</button>
      <div class="menu-wrap">
        <button class="menu-btn" id="menuBtn" type="button" aria-haspopup="true" aria-expanded="false" title="More options">&#8943;</button>
        <div class="menu-pop" id="menuPop" role="menu">
          <div class="menu-head">Signed in as <strong>@${escapeHtml(userId)}</strong></div>
          <button class="menu-item" id="mcpSetupBtn" type="button" role="menuitem">MCP Setup</button>
          <button class="menu-item" id="themeBtn" type="button" role="menuitem">Theme</button>
          ${showLogout ? `<a class="menu-item danger" href="/logout" role="menuitem">Sign Out</a>` : ""}
        </div>
      </div>
    </div>
  </header>
  <main>
    <div id="browserWrap">
      <img id="screen" tabindex="0" alt="Live Browser View" />
      <div id="vScroll" class="disabled" title="Scroll remote page (Take Control first)">
        <button type="button" class="vscroll-step" id="scrollUpBtn" title="Scroll up">&#9650;</button>
        <div id="vTrack"><div id="vThumb"></div></div>
        <button type="button" class="vscroll-step" id="scrollDownBtn" title="Scroll down">&#9660;</button>
      </div>
    </div>
    <div id="termWrap"><div id="terminal"></div></div>
    <div id="filesWrap">
      <div class="files-panel">
        <div class="files-bar">
          <div class="crumbs" id="fileCrumbs"></div>
          <div style="display:flex;gap:4px;flex-shrink:0;">
            <label class="sec" style="padding:4px 8px;border-radius:7px;border:1px solid var(--border);background:var(--card);cursor:pointer;font-weight:600;font-size:11.5px;">
              Upload<input id="fileUploadInput" type="file" multiple style="display:none;" />
            </label>
            <button class="sec" id="filesRefreshBtn" type="button" style="padding:4px 8px;font-size:11.5px;">Refresh</button>
          </div>
        </div>
        <div class="files-list" id="filesList"></div>
      </div>
      <div class="preview-panel">
        <div class="files-bar">
          <span id="previewTitle" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Select a file to preview</span>
          <a id="previewDownload" href="#" style="display:none;text-decoration:none;"><button class="sec" type="button" style="padding:4px 8px;font-size:11.5px;">Download</button></a>
        </div>
        <div class="preview-body" id="previewBody">
          <div class="preview-empty">Screenshots, images, logs, and code saved in your workspace appear here.</div>
        </div>
      </div>
    </div>
  </main>
  <div id="mcpModal" onclick="if(event.target===this)this.style.display='none';">
    <div class="modal-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <strong style="font-size:15px;">Connect MCP (${escapeHtml(mcpName)})</strong>
        <button type="button" class="sec" style="padding:4px 9px;" onclick="document.getElementById('mcpModal').style.display='none';">&times;</button>
      </div>
      <div style="margin-bottom:12px;color:var(--muted-foreground);">Endpoint: <code>${escapeHtml(mcpUrl)}</code></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span><strong>Option 1 — Paste to an AI Agent</strong> (OpenCode, Claude Code, Cursor, Codex):</span>
        <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxAgentPrompt').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
      </div>
      <pre id="obxAgentPrompt">${escapeHtml(agentPrompt)}</pre>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span><strong>Option 2 — Manual JSON</strong> (<code>~/.config/opencode/opencode.jsonc</code>):</span>
        <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxMcpJson').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
      </div>
      <pre id="obxMcpJson">${escapeHtml(opencodeJson)}</pre>
      <div style="color:var(--muted-foreground);font-size:12px;">Then in OpenCode run <code>/mcps</code>, select <strong>${escapeHtml(mcpName)}</strong>, and sign in with your API access token (user <code>@${escapeHtml(userId)}</code>).</div>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script>
    const browserWrap = document.getElementById("browserWrap");
    const vScroll = document.getElementById("vScroll");
    const vTrack = document.getElementById("vTrack");
    const vThumb = document.getElementById("vThumb");
    const scrollUpBtn = document.getElementById("scrollUpBtn");
    const scrollDownBtn = document.getElementById("scrollDownBtn");
    const img = document.getElementById("screen");
    const termWrap = document.getElementById("termWrap");
    const termEl = document.getElementById("terminal");
    const navForm = document.getElementById("navForm");
    const urlInput = document.getElementById("urlInput");
    const controlBtn = document.getElementById("controlBtn");
    const refreshBtn = document.getElementById("refreshBtn");
    const mcpSetupBtn = document.getElementById("mcpSetupBtn");
    const mcpModal = document.getElementById("mcpModal");
    const menuBtn = document.getElementById("menuBtn");
    const menuPop = document.getElementById("menuPop");
    const tabBrowser = document.getElementById("tabBrowser");
    const tabTerminal = document.getElementById("tabTerminal");
    const tabFiles = document.getElementById("tabFiles");
    const filesWrap = document.getElementById("filesWrap");
    const fileCrumbs = document.getElementById("fileCrumbs");
    const filesList = document.getElementById("filesList");
    const filesRefreshBtn = document.getElementById("filesRefreshBtn");
    const fileUploadInput = document.getElementById("fileUploadInput");
    const previewTitle = document.getElementById("previewTitle");
    const previewDownload = document.getElementById("previewDownload");
    const previewBody = document.getElementById("previewBody");
    const statusEl = document.getElementById("status");
    let currentDir = ".";
    let selectedFile = "";
    let busy = false;
    let controlling = false;
    let activeTab = "browser";
    let scrollTimer = null;
    let pendingScrollY = 0;
    let term = null;
    let fitAddon = null;
    let termWs = null;

    function closeMenu() {
      menuPop.classList.remove("open");
      menuBtn.setAttribute("aria-expanded", "false");
    }
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menuPop.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("click", (e) => {
      if (!menuPop.contains(e.target) && e.target !== menuBtn) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeMenu(); mcpModal.style.display = "none"; }
    });

    mcpSetupBtn.addEventListener("click", () => {
      closeMenu();
      mcpModal.style.display = mcpModal.style.display === "grid" ? "none" : "grid";
    });

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

    let pageMetrics = { scrollY: 0, scrollHeight: 800, clientHeight: 800 };
    let draggingThumb = false;

    function updateScrollbar(scrollY, scrollHeight, clientHeight) {
      pageMetrics = {
        scrollY: Number(scrollY) || 0,
        scrollHeight: Math.max(1, Number(scrollHeight) || 800),
        clientHeight: Math.max(1, Number(clientHeight) || 800),
      };
      const maxScroll = Math.max(0, pageMetrics.scrollHeight - pageMetrics.clientHeight);
      vScroll.classList.toggle("disabled", maxScroll <= 2);
      const trackH = vTrack.clientHeight || 200;
      const ratio = Math.min(1, pageMetrics.clientHeight / pageMetrics.scrollHeight);
      const thumbH = Math.max(24, Math.round(trackH * ratio));
      const maxTop = Math.max(0, trackH - thumbH);
      const top = maxScroll > 0 ? Math.round((pageMetrics.scrollY / maxScroll) * maxTop) : 0;
      vThumb.style.height = thumbH + "px";
      vThumb.style.top = top + "px";
    }

    async function refresh() {
      if (busy || activeTab !== "browser") return;
      busy = true;
      try {
        const res = await fetch("/view/screenshot");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        img.src = "data:image/png;base64," + data.base64;
        if (!draggingThumb) {
          updateScrollbar(data.scrollY, data.scrollHeight, data.clientHeight);
        }
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

    const themeBtn = document.getElementById("themeBtn");
    function getTermTheme(isDark) {
      return isDark
        ? { background: "#161221", foreground: "#f1f5f9", cursor: "#f1f5f9" }
        : { background: "#ffffff", foreground: "#0f172a", cursor: "#0f172a", selectionBackground: "#cbd5e1" };
    }
    function applyTheme(isDark) {
      document.documentElement.classList.toggle("dark", isDark);
      document.documentElement.style.colorScheme = isDark ? "dark" : "light";
      themeBtn.innerHTML = isDark ? "<span>Theme</span><span>Light</span>" : "<span>Theme</span><span>Dark</span>";
      if (term) term.options.theme = getTermTheme(isDark);
    }
    applyTheme(document.documentElement.classList.contains("dark"));
    themeBtn.addEventListener("click", () => {
      const next = !document.documentElement.classList.contains("dark");
      try { window.localStorage.setItem("openbot-theme", next ? "dark" : "light"); } catch {}
      applyTheme(next);
    });
    window.addEventListener("storage", (e) => {
      if (e.key === "openbot-theme") applyTheme(e.newValue === "dark");
    });

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
          theme: getTermTheme(document.documentElement.classList.contains("dark")),
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
            if (msg.type === "error") term.writeln("\\r\\n[Error: " + (msg.error || msg.message || "Unknown error") + "]");
          } catch {}
          return;
        }
        term.write(new Uint8Array(e.data));
      };
      termWs.onclose = () => {
        statusEl.textContent = "Terminal disconnected";
      };
    }

    function formatBytes(n) {
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / (1024 * 1024)).toFixed(1) + " MB";
    }

    function renderCrumbs(dir) {
      fileCrumbs.innerHTML = "";
      const rootBtn = document.createElement("button");
      rootBtn.type = "button";
      rootBtn.className = "crumb";
      rootBtn.textContent = "workspace";
      rootBtn.onclick = () => loadFiles(".");
      fileCrumbs.appendChild(rootBtn);
      if (dir && dir !== ".") {
        const parts = dir.split("/").filter(Boolean);
        let acc = "";
        for (const p of parts) {
          acc = acc ? acc + "/" + p : p;
          const sep = document.createElement("span");
          sep.textContent = "/";
          sep.style.color = "var(--muted-foreground)";
          fileCrumbs.appendChild(sep);
          const target = acc;
          const b = document.createElement("button");
          b.type = "button";
          b.className = "crumb";
          b.textContent = p;
          b.onclick = () => loadFiles(target);
          fileCrumbs.appendChild(b);
        }
      }
    }

    async function previewFile(relPath) {
      selectedFile = relPath;
      previewTitle.textContent = relPath;
      const rawUrl = "/api/files/raw?path=" + encodeURIComponent(relPath);
      previewDownload.href = rawUrl + "&download=1";
      previewDownload.style.display = "inline-block";
      const ext = (relPath.split(".").pop() || "").toLowerCase();
      if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) {
        previewBody.innerHTML = "";
        const im = document.createElement("img");
        im.src = rawUrl + "&t=" + Date.now();
        im.alt = relPath;
        previewBody.appendChild(im);
      } else if (ext === "pdf") {
        previewBody.innerHTML = "";
        const fr = document.createElement("iframe");
        fr.src = rawUrl;
        fr.style.cssText = "width:100%;height:100%;border:0;border-radius:8px;background:#fff;";
        previewBody.appendChild(fr);
      } else if (["txt", "md", "json", "log", "csv", "ts", "tsx", "js", "jsx", "py", "sh", "yml", "yaml", "toml", "css", "html", "xml", "env"].includes(ext) || !relPath.includes(".")) {
        previewBody.innerHTML = '<div class="preview-empty">Loading…</div>';
        try {
          const res = await fetch(rawUrl);
          if (!res.ok) throw new Error("HTTP " + res.status);
          const text = await res.text();
          previewBody.innerHTML = "";
          const pre = document.createElement("pre");
          pre.textContent = text.slice(0, 200000);
          previewBody.appendChild(pre);
        } catch (err) {
          previewBody.innerHTML = '<div class="preview-empty">Failed to load: ' + (err.message || err) + "</div>";
        }
      } else {
        previewBody.innerHTML = '<div class="preview-empty">Binary file — click <strong>Download</strong> above.</div>';
      }
      loadFiles(currentDir, true);
    }

    async function loadFiles(dir = currentDir, skipTitle = false) {
      currentDir = dir || ".";
      renderCrumbs(currentDir);
      try {
        const res = await fetch("/api/files?path=" + encodeURIComponent(currentDir));
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        filesList.innerHTML = "";
        if (!data.entries || data.entries.length === 0) {
          filesList.innerHTML = '<div class="preview-empty" style="padding:24px;">Empty folder</div>';
        } else {
          for (const entry of data.entries) {
            const rel = currentDir === "." ? entry.name : currentDir + "/" + entry.name;
            const row = document.createElement("div");
            row.className = "file-row" + (selectedFile === rel ? " active" : "");
            const left = document.createElement("div");
            left.className = "file-name";
            left.textContent = (entry.type === "dir" ? "📁 " : "📄 ") + entry.name;
            const right = document.createElement("div");
            right.className = "file-meta";
            if (entry.type === "file") {
              const sz = document.createElement("span");
              sz.textContent = formatBytes(entry.size);
              right.appendChild(sz);
              const dl = document.createElement("a");
              dl.href = "/api/files/raw?path=" + encodeURIComponent(rel) + "&download=1";
              dl.className = "file-act";
              dl.textContent = "↓";
              dl.title = "Download";
              dl.onclick = (e) => e.stopPropagation();
              right.appendChild(dl);
            }
            const del = document.createElement("button");
            del.type = "button";
            del.className = "file-act del";
            del.textContent = "✕";
            del.title = "Delete";
            del.onclick = async (e) => {
              e.stopPropagation();
              if (!confirm("Delete " + rel + "?")) return;
              await fetch("/api/files?path=" + encodeURIComponent(rel), { method: "DELETE" });
              if (selectedFile === rel) {
                selectedFile = "";
                previewTitle.textContent = "Select a file to preview";
                previewDownload.style.display = "none";
                previewBody.innerHTML = '<div class="preview-empty">Deleted.</div>';
              }
              loadFiles(currentDir);
            };
            right.appendChild(del);
            row.appendChild(left);
            row.appendChild(right);
            row.onclick = () => {
              if (entry.type === "dir") loadFiles(rel);
              else previewFile(rel);
            };
            filesList.appendChild(row);
          }
        }
        if (!skipTitle) statusEl.textContent = "Files · " + currentDir;
      } catch (err) {
        statusEl.textContent = "Error: " + (err.message || err);
      }
    }

    filesRefreshBtn.addEventListener("click", () => loadFiles(currentDir));
    fileUploadInput.addEventListener("change", async () => {
      if (!fileUploadInput.files || fileUploadInput.files.length === 0) return;
      const fd = new FormData();
      for (const f of fileUploadInput.files) fd.append("file", f);
      statusEl.textContent = "Uploading…";
      await fetch("/api/files/upload?path=" + encodeURIComponent(currentDir), { method: "POST", body: fd });
      fileUploadInput.value = "";
      loadFiles(currentDir);
    });

    function setTab(tab) {
      activeTab = tab;
      tabBrowser.className = tab === "browser" ? "tab active" : "tab";
      tabTerminal.className = tab === "terminal" ? "tab active" : "tab";
      tabFiles.className = tab === "files" ? "tab active" : "tab";
      browserWrap.style.display = tab === "browser" ? "flex" : "none";
      navForm.style.display = tab === "browser" ? "flex" : "none";
      refreshBtn.style.display = tab === "browser" ? "inline-flex" : "none";
      controlBtn.style.display = tab === "files" ? "none" : "inline-block";
      termWrap.style.display = tab === "terminal" ? "block" : "none";
      filesWrap.style.display = tab === "files" ? "grid" : "none";
      if (tab === "terminal") {
        connectTerminal();
        if (term) term.focus();
      } else if (tab === "files") {
        loadFiles(currentDir);
      } else {
        refresh();
      }
    }

    tabBrowser.addEventListener("click", () => setTab("browser"));
    tabTerminal.addEventListener("click", () => setTab("terminal"));
    tabFiles.addEventListener("click", () => setTab("files"));

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

    function requireControlForScroll() {
      if (controlling) return true;
      statusEl.textContent = "Click Take Control to scroll";
      return false;
    }

    scrollUpBtn.addEventListener("click", async () => {
      if (!requireControlForScroll()) return;
      await sendAction("/view/scroll", { deltaY: -260 });
      setTimeout(refresh, 100);
    });

    scrollDownBtn.addEventListener("click", async () => {
      if (!requireControlForScroll()) return;
      await sendAction("/view/scroll", { deltaY: 260 });
      setTimeout(refresh, 100);
    });

    function scrollToTrackY(clientY) {
      const rect = vTrack.getBoundingClientRect();
      const thumbH = vThumb.offsetHeight || 24;
      const maxTop = Math.max(1, rect.height - thumbH);
      const rel = Math.min(Math.max(0, clientY - rect.top - thumbH / 2), maxTop);
      const frac = rel / maxTop;
      const maxScroll = Math.max(0, pageMetrics.scrollHeight - pageMetrics.clientHeight);
      const targetY = Math.round(frac * maxScroll);
      vThumb.style.top = Math.round(rel) + "px";
      return targetY;
    }

    let thumbCommitTimer = null;
    vTrack.addEventListener("pointerdown", (e) => {
      if (!requireControlForScroll()) return;
      e.preventDefault();
      draggingThumb = true;
      vThumb.classList.add("dragging");
      vTrack.setPointerCapture(e.pointerId);
      const targetY = scrollToTrackY(e.clientY);
      if (thumbCommitTimer) clearTimeout(thumbCommitTimer);
      thumbCommitTimer = setTimeout(async () => {
        await sendAction("/view/scroll", { y: targetY });
        setTimeout(refresh, 100);
      }, 60);
    });

    vTrack.addEventListener("pointermove", (e) => {
      if (!draggingThumb) return;
      const targetY = scrollToTrackY(e.clientY);
      if (thumbCommitTimer) clearTimeout(thumbCommitTimer);
      thumbCommitTimer = setTimeout(async () => {
        await sendAction("/view/scroll", { y: targetY });
      }, 60);
    });

    function endThumbDrag(e) {
      if (!draggingThumb) return;
      draggingThumb = false;
      vThumb.classList.remove("dragging");
      const targetY = scrollToTrackY(e.clientY);
      sendAction("/view/scroll", { y: targetY }).then(() => setTimeout(refresh, 100)).catch(() => {});
    }
    vTrack.addEventListener("pointerup", endThumbDrag);
    vTrack.addEventListener("pointercancel", endThumbDrag);

    let touchLastY = null;
    img.addEventListener("touchstart", (e) => {
      if (!controlling || e.touches.length !== 1) return;
      touchLastY = e.touches[0].clientY;
    }, { passive: true });
    img.addEventListener("touchmove", (e) => {
      if (!controlling || touchLastY === null || e.touches.length !== 1) return;
      const dy = touchLastY - e.touches[0].clientY;
      touchLastY = e.touches[0].clientY;
      if (Math.abs(dy) < 4) return;
      e.preventDefault();
      pendingScrollY += dy * 1.5;
      if (scrollTimer) return;
      scrollTimer = setTimeout(async () => {
        const deltaY = Math.round(pendingScrollY);
        pendingScrollY = 0;
        scrollTimer = null;
        if (!deltaY) return;
        await sendAction("/view/scroll", { deltaY }).catch(() => {});
        setTimeout(refresh, 120);
      }, 120);
    }, { passive: false });
    img.addEventListener("touchend", () => { touchLastY = null; });

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
  ${OPENBOXY_THEME_HEAD}
</head>
<body class="obx-center">
  <div class="obx-card">
    <h1>Authorize MCP Client</h1>
    <p><strong>${escapeHtml(params.clientName)}</strong> is requesting MCP access to your OpenBoxy browser session and terminal.<br/>Redirect: <code>${escapeHtml(params.redirectUri)}</code></p>
    ${params.error ? `<div class="obx-err">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}" />
      <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}" />
      <input type="hidden" name="state" value="${escapeHtml(params.state)}" />
      <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}" />
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.codeChallengeMethod)}" />
      <label for="token">Your API Access Token</label>
      <input id="token" name="token" type="password" autocomplete="off" required placeholder="Paste your API access token" />
      <button type="submit">Approve &amp; Connect</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: params.error ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
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

function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({
    name: process.env.OPENBOXY_MCP_NAME?.trim() || "boxy",
    version: "2.0.0",
  });

  server.registerTool(
    "shell",
    {
      description:
        "Run a bash command in your persistent workspace shell. Returns stdout, stderr, exit code, and cwd.",
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
      const timeoutMs = timeout_s ? timeout_s * 1000 : 60_000;
      const result = await sandbox.execShell(userId, command, timeoutMs);
      return textResult(result);
    },
  );

  server.registerTool(
    "read_file",
    {
      description: "Read a file from your workspace (with optional 1-based line offset and limit).",
      inputSchema: {
        path: z.string().min(1).describe("File path relative to workspace"),
        offset: z.number().int().min(1).optional().describe("First line to return (1-based)"),
        limit: z.number().int().min(1).max(5000).optional().describe("Maximum lines to return"),
      },
    },
    async ({ path: filePath, offset, limit }) => {
      const res = await sandbox.readFile(userId, filePath);
      if (offset !== undefined || limit !== undefined) {
        const lines = res.contents.split("\n");
        const start = Math.max(0, (offset ?? 1) - 1);
        const end = limit !== undefined ? start + limit : lines.length;
        return textResult({
          path: res.path,
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
      description: "Create or overwrite a file in your workspace (parent directories are created automatically).",
      inputSchema: {
        path: z.string().min(1).describe("Target file path"),
        content: z.string().describe("Full file contents"),
        append: z.boolean().optional().describe("Append instead of overwriting"),
      },
    },
    async ({ path: filePath, content, append }) => {
      return textResult(await sandbox.writeFile(userId, filePath, content, append === true));
    },
  );

  server.registerTool(
    "edit_file",
    {
      description: "Replace an exact string occurrence in an existing file in your workspace.",
      inputSchema: {
        path: z.string().min(1).describe("Target file path"),
        old_text: z.string().min(1).describe("Exact text to find"),
        new_text: z.string().describe("Replacement text"),
      },
    },
    async ({ path: filePath, old_text, new_text }) => {
      const res = await sandbox.readFile(userId, filePath);
      if (!res.contents.includes(old_text)) {
        throw new Error(`old_text not found in ${filePath}`);
      }
      const updated = res.contents.replace(old_text, new_text);
      return textResult(await sandbox.writeFile(userId, filePath, updated, false));
    },
  );

  server.registerTool(
    "list_dir",
    {
      description: "List files and directories inside your workspace.",
      inputSchema: {
        path: z.string().optional().describe("Directory path (defaults to workspace root)"),
      },
    },
    async ({ path: dirPath }) => {
      return textResult(await sandbox.listDir(userId, dirPath));
    },
  );

  server.registerTool(
    "browser_navigate",
    {
      description: "Navigate your persistent Chromium browser to a URL and return readable page text.",
      inputSchema: {
        url: z.string().url().describe("Target URL (http:// or https://)"),
      },
    },
    async ({ url }) => {
      return textResult(await sandbox.navigate(userId, url));
    },
  );

  server.registerTool(
    "browser_snapshot",
    {
      description:
        "Take a snapshot of interactive elements on the current page. Returns snapshotId and element refs for browser_click / browser_type.",
      inputSchema: {},
    },
    async () => {
      return textResult(await sandbox.snapshot(userId));
    },
  );

  server.registerTool(
    "browser_read",
    {
      description: "Read the current page's URL, title, and extracted readable text.",
      inputSchema: {},
    },
    async () => {
      return textResult(await sandbox.readPage(userId));
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
      return textResult(await sandbox.clickRef(userId, ref, snapshotId));
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
      return textResult(await sandbox.typeRef(userId, ref, snapshotId, text, submit === true));
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
      return textResult(await sandbox.pressKey(userId, key, ref, snapshotId));
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
      return textResult(await sandbox.scroll(userId, deltaY));
    },
  );

  server.registerTool(
    "screenshot",
    {
      description:
        "Capture a visual PNG screenshot of the current browser viewport and save it to the user's workspace (default: screenshots/screenshot-<timestamp>.png) so it can be viewed in the Files tab.",
      inputSchema: {
        path: z.string().optional().describe("Optional workspace path to save the PNG (defaults to screenshots/screenshot-<timestamp>.png)"),
      },
    },
    async ({ path: savePath }) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const targetPath = savePath && savePath.trim() ? savePath.trim() : `screenshots/screenshot-${stamp}.png`;
      const res = await sandbox.screenshot(userId, targetPath);
      const base = PUBLIC_URL || `http://127.0.0.1:${PORT}`;
      const filesUrl = `${base}/view/files`;
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
              savedPath: res.savedPath,
              filesUrl,
              note: `Saved PNG to workspace at ${res.savedPath}. Tell the user they can view or download it in the Files tab at ${filesUrl}.`,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "browser_view",
    {
      description: "Get the live OpenBoxy UI URLs (Browser, Terminal, and Files) where the user can visually watch, take over, or browse workspace files.",
      inputSchema: {},
    },
    async () => {
      const base = PUBLIC_URL || `http://127.0.0.1:${PORT}`;
      return textResult({
        userId,
        url: `${base}/view`,
        terminalUrl: `${base}/view/terminal`,
        filesUrl: `${base}/view/files`,
        note: "Open /view for the live browser, /view/terminal for the shell, or /view/files to view/download saved screenshots and files.",
      });
    },
  );

  return server;
}

type TerminalSocketData = {
  userId: string;
  proc?: ReturnType<typeof Bun.spawn>;
};

const server = Bun.serve<TerminalSocketData>({
  port: PORT,
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        service: "openboxy-mcp",
        mode: "single-container",
        users: userTokens.size,
      });
    }

    if (req.method === "GET" && url.pathname === "/login") {
      const nextPath = safeNextPath(url.searchParams.get("next"));
      if (uiAuthorized(req)) {
        return Response.redirect(new URL(nextPath, publicOrigin(req)).toString(), 302);
      }
      return renderLoginPage(nextPath);
    }

    if (req.method === "POST" && url.pathname === "/login") {
      const form = await req.formData().catch(() => null);
      const token = String(form?.get("token") || "").trim();
      const nextPath = safeNextPath(String(form?.get("next") || "/"));
      const userId = resolveTokenUser(token);
      if (!userId) {
        return renderLoginPage(nextPath, "Invalid API access token.");
      }
      const isSecure = publicOrigin(req).startsWith("https://");
      const sessionCookie = encodeURIComponent(signAccessToken("ui", userId));
      return new Response(null, {
        status: 303,
        headers: {
          Location: nextPath,
          "Set-Cookie": `openboxy_ui=${sessionCookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${isSecure ? "; Secure" : ""}`,
        },
      });
    }

    if (url.pathname === "/logout") {
      const isSecure = publicOrigin(req).startsWith("https://");
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/login",
          "Set-Cookie": `openboxy_ui=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure ? "; Secure" : ""}`,
        },
      });
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
      const userId = resolveTokenUser(token);
      if (!userId) {
        return renderAuthorizePage({
          clientName: client?.client_name || clientId,
          clientId,
          redirectUri,
          state,
          codeChallenge,
          codeChallengeMethod,
          error: "Invalid API access token. Please try again.",
        });
      }
      const code = randomBytes(24).toString("base64url");
      authCodes.set(code, {
        clientId,
        userId,
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
        access_token: signAccessToken(record.clientId, record.userId),
        token_type: "Bearer",
        expires_in: 30 * 24 * 60 * 60,
      });
    }

    if (url.pathname === "/mcp") {
      const userId = authorized(req);
      if (!userId) {
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
      const mcp = buildMcpServer(userId);
      transport.onclose = () => {
        void mcp.close().catch(() => {});
      };
      await mcp.connect(transport);
      return await transport.handleRequest(req);
    }

    const uiUserId = uiAuthorized(req);
    if (!uiUserId) {
      if (req.method === "GET" && (req.headers.get("accept") || "").includes("text/html")) {
        return new Response(null, {
          status: 302,
          headers: { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` },
        });
      }
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket" && url.pathname === "/view/terminal") {
      const upgraded = srv.upgrade(req, { data: { userId: uiUserId } });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/view")) {
      return renderViewPage(req, uiUserId, "browser");
    }

    if (req.method === "GET" && url.pathname === "/view/terminal") {
      return renderViewPage(req, uiUserId, "terminal");
    }

    if (req.method === "GET" && url.pathname === "/view/files") {
      return renderViewPage(req, uiUserId, "files");
    }

    if (req.method === "GET" && url.pathname === "/api/files") {
      try {
        const dirPath = url.searchParams.get("path") || ".";
        return Response.json(await sandbox.listDir(uiUserId, dirPath));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }

    if (req.method === "DELETE" && url.pathname === "/api/files") {
      try {
        const target = url.searchParams.get("path") || "";
        return Response.json(await sandbox.deletePath(uiUserId, target));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/files/upload") {
      try {
        const dirPath = url.searchParams.get("path") || ".";
        const form = await req.formData();
        const uploaded: Array<{ path: string; bytes: number }> = [];
        for (const val of form.getAll("file")) {
          if (val instanceof File) {
            const name = val.name.replace(/[/\\]/g, "_") || "upload.bin";
            const target = dirPath === "." ? name : `${dirPath}/${name}`;
            const buf = new Uint8Array(await val.arrayBuffer());
            uploaded.push(await sandbox.writeFileBytes(uiUserId, target, buf));
          }
        }
        return Response.json({ uploaded });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/files/raw") {
      try {
        const filePath = url.searchParams.get("path") || "";
        const download = url.searchParams.get("download") === "1";
        const { path: relPath, bytes } = await sandbox.readFileBytes(uiUserId, filePath);
        const ext = (relPath.split(".").pop() || "").toLowerCase();
        const mimeMap: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          svg: "image/svg+xml",
          pdf: "application/pdf",
          json: "application/json; charset=utf-8",
          txt: "text/plain; charset=utf-8",
          md: "text/plain; charset=utf-8",
          log: "text/plain; charset=utf-8",
          csv: "text/csv; charset=utf-8",
          html: "text/plain; charset=utf-8",
        };
        const contentType = mimeMap[ext] || "application/octet-stream";
        const filename = relPath.split("/").pop() || "file";
        return new Response(bytes, {
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename.replaceAll('"', "")}"`,
            "Content-Security-Policy": "sandbox",
          },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 });
      }
    }

    if (req.method === "GET" && url.pathname === "/view/screenshot") {
      try {
        return Response.json(await sandbox.screenshot(uiUserId));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "GET" && url.pathname === "/view/control") {
      return Response.json(await sandbox.getControl(uiUserId));
    }

    if (req.method === "POST" && url.pathname === "/view/control/take") {
      return Response.json(await sandbox.setControl(uiUserId, "human"));
    }

    if (req.method === "POST" && url.pathname === "/view/control/release") {
      return Response.json(await sandbox.setControl(uiUserId, "agent"));
    }

    if (req.method === "POST" && url.pathname === "/view/navigate") {
      const body = (await req.json().catch(() => ({}))) as { url?: string };
      if (!body.url) return Response.json({ error: "url is required" }, { status: 400 });
      try {
        return Response.json(await sandbox.navigate(uiUserId, body.url));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/click") {
      const body = (await req.json().catch(() => ({}))) as { x?: number; y?: number };
      if (typeof body.x !== "number" || typeof body.y !== "number") {
        return Response.json({ error: "x and y are required" }, { status: 400 });
      }
      try {
        return Response.json(await sandbox.clickAt(uiUserId, body.x, body.y));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/type") {
      const body = (await req.json().catch(() => ({}))) as { text?: string };
      if (typeof body.text !== "string") return Response.json({ error: "text is required" }, { status: 400 });
      try {
        return Response.json(await sandbox.typeText(uiUserId, body.text));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/key") {
      const body = (await req.json().catch(() => ({}))) as { key?: string };
      if (!body.key) return Response.json({ error: "key is required" }, { status: 400 });
      try {
        return Response.json(await sandbox.pressKey(uiUserId, body.key));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/scroll") {
      const body = (await req.json().catch(() => ({}))) as { deltaY?: number; y?: number };
      if (typeof body.deltaY !== "number" && typeof body.y !== "number") {
        return Response.json({ error: "deltaY or y is required" }, { status: 400 });
      }
      try {
        return Response.json(await sandbox.scroll(uiUserId, body.deltaY ?? 0, body.y));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const { userId } = ws.data;
      try {
        const { workspaceDir, homeDir } = sandbox.getPathsSync(userId);
        const proc = Bun.spawn(["bash", "-l"], {
          cwd: workspaceDir,
          env: {
            ...process.env,
            HOME: homeDir,
            TERM: "xterm-256color",
            OPENBOXY_USER: userId,
            OPENBOXY_WORKSPACE: workspaceDir,
          },
          terminal: {
            cols: 80,
            rows: 24,
            data(_term, data) {
              try {
                ws.sendBinary(data);
              } catch {}
            },
            exit() {
              try {
                ws.close();
              } catch {}
            },
          },
        });
        ws.data.proc = proc;
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", error: err instanceof Error ? err.message : String(err) }));
        ws.close();
      }
    },
    message(ws, message) {
      const proc = ws.data.proc;
      if (!proc?.terminal) return;
      if (typeof message === "string") {
        try {
          const parsed = JSON.parse(message) as { type?: string; data?: string; cols?: number; rows?: number };
          if (parsed.type === "input" && typeof parsed.data === "string") {
            proc.terminal.write(parsed.data);
          } else if (
            parsed.type === "resize" &&
            typeof parsed.cols === "number" &&
            typeof parsed.rows === "number"
          ) {
            proc.terminal.resize(Math.max(10, parsed.cols), Math.max(4, parsed.rows));
          }
        } catch {}
      } else {
        proc.terminal.write(message);
      }
    },
    close(ws) {
      try {
        ws.data.proc?.kill();
      } catch {}
    },
  },
});

console.log(`[openboxy-mcp] Listening on :${server.port} (single-container, users=${userTokens.size})`);
