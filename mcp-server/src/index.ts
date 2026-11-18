import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { deleteBookmark, listBookmarks, renderBookmarksPage, upsertBookmark } from "./bookmarks.ts";
import { getPluginExtensionDirs, getPluginHomeLinks, getPluginProxyUrl, handlePluginHttp, loadPlugins, registerPluginTools, type OpenBoxyPlugin } from "./plugins.ts";
import { SandboxManager, sanitizeUserId } from "./sandbox.ts";
import {
  renderShareNotFoundPage,
  renderSharePasswordPage,
  renderShareViewerPage,
  ShareManager,
  type ShareExpiryOption,
  saveUrlToWorkspaceForShare,
} from "./shares.ts";
import { getOrSynthesizeArticleAudio, serveAudioFileWithRange } from "./tts.ts";

const PORT = Number(process.env.MCP_PORT || 3100);

const COUNTRY_TIMEZONES: Record<string, string> = {
  US: "America/Los_Angeles",
  JP: "Asia/Tokyo",
  SG: "Asia/Singapore",
  HK: "Asia/Hong_Kong",
  TW: "Asia/Taipei",
  KR: "Asia/Seoul",
  DE: "Europe/Berlin",
  GB: "Europe/London",
  UK: "Europe/London",
  FR: "Europe/Paris",
  CA: "America/Toronto",
  NL: "Europe/Amsterdam",
  CH: "Europe/Zurich",
  SE: "Europe/Stockholm",
  FI: "Europe/Helsinki",
  PL: "Europe/Warsaw",
  AU: "Australia/Sydney",
  IN: "Asia/Kolkata",
};

let cachedServerTimezone: string | null = null;
let cachedNetStatus: { key: string; at: number; data: Record<string, unknown> } | null = null;

async function getServerIpTimezone(): Promise<string> {
  if (cachedServerTimezone) return cachedServerTimezone;
  try {
    const res = await fetch("https://ipwho.is/", { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const j = (await res.json()) as { timezone?: { id?: string } };
      if (j.timezone?.id) {
        cachedServerTimezone = j.timezone.id;
        return cachedServerTimezone;
      }
    }
  } catch {}
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

async function getHomeNetworkStatus(loadedPlugins: OpenBoxyPlugin[], force = false): Promise<Record<string, unknown>> {
  const serverTimezone = await getServerIpTimezone();
  const hasVpn = loadedPlugins.some((p) => p.name === "vless-vpn");
  let activeCountry: string | null = null;
  if (hasVpn) {
    try {
      const stRes = await fetch(`http://127.0.0.1:${PORT}/p/vless-vpn/state`);
      if (stRes.ok) {
        const st = (await stRes.json()) as { activeCountry?: string | null };
        activeCountry = st.activeCountry || null;
      }
    } catch {}
  }

  const cacheKey = activeCountry || "DIRECT";
  if (!force && cachedNetStatus && cachedNetStatus.key === cacheKey && Date.now() - cachedNetStatus.at < 15_000) {
    return {
      ...cachedNetStatus.data,
      serverNowMs: Date.now(),
      serverTimezone,
    };
  }

  let ip = "";
  let country = "";
  let city = "";
  let remoteTimezone: string | null = activeCountry ? COUNTRY_TIMEZONES[activeCountry] || null : null;

  try {
    const ipRes = await fetch(
      hasVpn ? `http://127.0.0.1:${PORT}/p/vless-vpn/ip` : "https://ipwho.is/",
      { signal: AbortSignal.timeout(9000) },
    );
    if (ipRes.ok) {
      const j = (await ipRes.json()) as Record<string, unknown>;
      ip = typeof j.ip === "string" ? j.ip : "";
      country = typeof j.country === "string" ? j.country : "";
      city = typeof j.city === "string" ? j.city : "";
      const tzObj = j.timezone as { id?: string } | undefined;
      if (tzObj?.id) remoteTimezone = tzObj.id;
    }
  } catch {}

  if (activeCountry && ip && !remoteTimezone) {
    try {
      const gRes = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(4000) });
      if (gRes.ok) {
        const g = (await gRes.json()) as { timezone?: { id?: string } };
        if (g.timezone?.id) remoteTimezone = g.timezone.id;
      }
    } catch {}
  }

  const payload = {
    ip,
    country,
    city,
    activeCountry,
    remoteTimezone,
  };
  cachedNetStatus = { key: cacheKey, at: Date.now(), data: payload };
  return {
    ...payload,
    serverNowMs: Date.now(),
    serverTimezone,
  };
}
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
const shares = new ShareManager(SESSION_SECRET);
const loadedPlugins = await loadPlugins();
sandbox.setExtensionResolver((uid) => getPluginExtensionDirs(loadedPlugins, uid));
sandbox.setProxyResolver((uid) => getPluginProxyUrl(loadedPlugins, uid));

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

const TOKEN_TTL_S = 30 * 24 * 60 * 60;

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
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { uid?: unknown; iat?: unknown };
    if (
      typeof parsed.uid === "string" &&
      userTokens.has(parsed.uid) &&
      typeof parsed.iat === "number" &&
      Math.floor(Date.now() / 1000) - parsed.iat <= TOKEN_TTL_S
    ) {
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

const OPENBOXY_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <style>
    .box-line { stroke: #0f172a; stroke-width: 2.1; stroke-linecap: round; stroke-linejoin: round; }
    @media (prefers-color-scheme: dark) { .box-line { stroke: #f8fafc; } }
  </style>
  <polygon class="box-line" points="6.5,10.7 3.2,7.2 12.6,4.2 16,7.5" />
  <polygon class="box-line" points="25.5,10.7 28.8,7.2 19.4,4.2 16,7.5" />
  <polygon class="box-line" points="6.5,10.7 4.0,14.2 13.2,17.5 16,13.9" />
  <polygon class="box-line" points="25.5,10.7 28.0,14.2 18.8,17.5 16,13.9" />
  <polyline class="box-line" points="6.5,15.1 6.5,23.8 16,27.5 25.5,23.8 25.5,15.1" />
  <line class="box-line" x1="16" y1="7.5" x2="16" y2="27.5" />
</svg>`;

const OPENBOXY_LOGO_SVG = `<svg class="obx-logo" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6.5,10.7 3.2,7.2 12.6,4.2 16,7.5"/><polygon points="25.5,10.7 28.8,7.2 19.4,4.2 16,7.5"/><polygon points="6.5,10.7 4.0,14.2 13.2,17.5 16,13.9"/><polygon points="25.5,10.7 28.0,14.2 18.8,17.5 16,13.9"/><polyline points="6.5,15.1 6.5,23.8 16,27.5 25.5,23.8 25.5,15.1"/><line x1="16" y1="7.5" x2="16" y2="27.5"/></svg>`;

const OPENBOXY_THEME_HEAD = `
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
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

function contentDisposition(disposition: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "").replaceAll("\\", "_") || "file";
  const utf8 = encodeURIComponent(filename).replace(/['()!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
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
      display: inline-flex;
      align-items: center;
      gap: 6px;
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
    .obx-badge .obx-logo { width: 15px; height: 15px; color: var(--card-foreground); }
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
    <span class="obx-badge">${OPENBOXY_LOGO_SVG}<span>OpenBoxy MCP</span></span>
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
  const geminiCliJson = JSON.stringify(
    {
      mcpServers: {
        [mcpName]: {
          httpUrl: mcpUrl,
          oauth: { enabled: true },
        },
      },
    },
    null,
    2,
  );
  const cursorJson = JSON.stringify(
    {
      mcpServers: {
        [mcpName]: {
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );
  const openclawJson = JSON.stringify(
    {
      mcp: {
        servers: {
          [mcpName]: {
            transport: "http",
            url: mcpUrl,
          },
        },
      },
    },
    null,
    2,
  );
  const codexToml = `[mcp_servers.${mcpName}]\nurl = "${mcpUrl}"`;
  const vscodeJson = JSON.stringify(
    {
      servers: {
        [mcpName]: {
          type: "http",
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );
  const workbuddyJson = JSON.stringify(
    {
      mcpServers: {
        [mcpName]: {
          transport: "http",
          url: mcpUrl,
          headers: {
            Authorization: "Bearer YOUR_API_TOKEN",
          },
        },
      },
    },
    null,
    2,
  );
  const hermesYaml = `mcp_servers:\n  ${mcpName}:\n    url: "${mcpUrl}"\n    transport: "streamable"\n    enabled: true\n    headers:\n      Authorization: "Bearer \${env:OPENBOXY_MCP_TOKEN}"`;
  const deepseekYaml = `- id: mcp-${mcpName}\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: ${mcpName}\n    transport: streamable-http\n    url: ${mcpUrl}\n    headers:\n      Authorization: !!js '\`Bearer \${process.env.OPENBOXY_MCP_TOKEN}\`'`;
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
    .brand { display: inline-flex; align-items: center; gap: 6px; color: var(--card-foreground); text-decoration: none; font-size: 14px; font-weight: 600; letter-spacing: -0.05em; line-height: 1.25; padding: 5px 8px; border-radius: 8px; flex-shrink: 0; }
    .brand .obx-logo { width: 18px; height: 18px; flex-shrink: 0; }
    .brand:hover { background: var(--muted); }
    .tabs { display: flex; gap: 2px; background: var(--muted); padding: 3px; border-radius: 9px; border: 1px solid var(--border); flex-shrink: 0; }
    .tab { padding: 4px 11px; border-radius: 6px; border: 0; background: transparent; color: var(--muted-foreground); font-weight: 600; cursor: pointer; font-size: 12.5px; }
    .tab.active { background: var(--card); color: var(--card-foreground); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    .nav-btns { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
    .url-bar { display: flex; flex: 1; align-items: center; gap: 4px; min-width: 140px; max-width: 680px; background: var(--background); border: 1px solid var(--border); border-radius: 9px; padding: 2px 4px 2px 10px; }
    .url-bar:focus-within { border-color: var(--primary); }
    .url-bar input[type="text"] { flex: 1; min-width: 0; padding: 4px 0; border: 0; background: transparent; color: var(--card-foreground); font-size: 12.5px; outline: none; }
    .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border-radius: 7px; border: 0; background: transparent; color: var(--muted-foreground); cursor: pointer; font-size: 14px; }
    .icon-btn:hover { background: var(--muted); color: var(--card-foreground); }
    .go-btn { padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--muted); color: var(--card-foreground); font-weight: 600; font-size: 11.5px; cursor: pointer; line-height: 1.2; flex-shrink: 0; }
    .go-btn:hover { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); opacity: 1; }
    .spacer { flex: 1; display: none; }
    .actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-shrink: 0; }
    button { padding: 6px 12px; border-radius: 9px; border: 1px solid transparent; background: var(--primary); color: var(--primary-foreground); font-weight: 600; cursor: pointer; font-size: 12.5px; white-space: nowrap; }
    button:hover { opacity: 0.9; }
    button.sec { background: var(--muted); color: var(--card-foreground); border-color: var(--border); }
    button.sec:hover { opacity: 0.85; }
    button.take { background: #d97706; color: #fff; }
    button.release { background: #16a34a; color: #fff; }
    .meta { font-size: 11.5px; color: var(--muted-foreground); white-space: nowrap; width: 84px; text-align: center; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
    .menu-wrap { position: relative; }
    .menu-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 10px; border-radius: 9px; border: 1px solid var(--border); background: var(--muted); color: var(--card-foreground); font-weight: 600; font-size: 12.5px; cursor: pointer; }
    .menu-btn:hover { opacity: 0.85; }
    .menu-pop { display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 190px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 6px; box-shadow: 0 14px 36px rgba(0,0,0,.18); z-index: 1000; }
    .menu-pop.open { display: flex; flex-direction: column; gap: 2px; }
    .menu-head { padding: 6px 10px; font-size: 11.5px; color: var(--muted-foreground); border-bottom: 1px solid var(--border); margin-bottom: 4px; }
    .menu-item { display: flex; align-items: center; justify-content: space-between; width: 100%; text-align: left; padding: 7px 10px; border-radius: 8px; border: 0; background: transparent; color: var(--card-foreground); font-size: 12.5px; font-weight: 500; cursor: pointer; text-decoration: none; }
    .menu-item:hover { background: var(--muted); opacity: 1; }
    .menu-item.danger { color: var(--destructive); }
    #ctxMenu { display: none; position: fixed; z-index: 99999; min-width: 190px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 5px; box-shadow: 0 14px 36px rgba(0,0,0,.22); flex-direction: column; gap: 2px; }
    #ctxMenu.open { display: flex; }
    .ctx-sep { height: 1px; background: var(--border); margin: 3px 6px; }
    @media (max-width: 720px) { .meta { display: none; } header { gap: 6px; padding: 8px 10px; } }
    main { flex: 1; display: grid; place-items: center; overflow: auto; padding: 12px; position: relative; }
    img { max-width: 100%; max-height: calc(100vh - 76px); border: 2px solid var(--border); border-radius: 12px; background: #fff; box-shadow: 0 10px 28px rgba(0,0,0,.12); outline: none; display: block; }
    .dark img { box-shadow: 0 12px 32px rgba(0,0,0,.45); }
    img.controlling { border-color: #22c55e; cursor: crosshair; touch-action: none; user-select: none; }
    #browserStage { display: flex; flex-direction: column; gap: 6px; max-width: 100%; max-height: calc(100vh - 76px); }
    #browserStage img { max-height: calc(100vh - 116px); }
    body.obx-fs header, body.obx-fs .browser-tabs-row { display: none !important; }
    body.obx-fs main { padding: 0; overflow: hidden; }
    body.obx-fs #browserStage { width: 100vw; height: 100vh; max-width: 100vw; max-height: 100vh; gap: 0; }
    body.obx-fs #browserWrap { width: 100%; height: 100%; align-items: center; justify-content: center; background: #000; }
    body.obx-fs #browserStage img { max-width: 100vw; max-height: 100vh; width: auto; height: auto; border-radius: 0; border: 0; box-shadow: none; }
    #fsExitBtn { display: none; position: fixed; top: 10px; right: 12px; z-index: 99990; padding: 6px 11px; border-radius: 9px; border: 1px solid var(--border); background: var(--card); color: var(--card-foreground); font-size: 12px; font-weight: 600; opacity: 0.78; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    #fsExitBtn:hover { opacity: 1; }
    body.obx-fs #fsExitBtn { display: inline-flex; align-items: center; gap: 5px; }
    .browser-tabs-row { display: flex; align-items: center; gap: 6px; flex-shrink: 0; min-width: 0; }
    .browser-tabs-bar { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; overflow-x: auto; overflow-y: hidden; padding: 2px 0; scrollbar-width: thin; }
    .btab { display: inline-flex; align-items: center; gap: 6px; max-width: 190px; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--muted); color: var(--muted-foreground); font-size: 11.5px; font-weight: 500; cursor: pointer; flex-shrink: 0; }
    .btab.active { background: var(--card); color: var(--card-foreground); border-color: var(--primary); font-weight: 600; }
    .btab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .btab-close { display: inline-grid; place-items: center; width: 15px; height: 15px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: inherit; font-size: 12px; line-height: 1; opacity: 0.7; cursor: pointer; flex-shrink: 0; }
    .btab-close:hover { opacity: 1; background: var(--border); }
    .btab-add { display: inline-grid; place-items: center; width: 24px; height: 24px; padding: 0; border-radius: 7px; border: 1px solid var(--border); background: var(--card); color: var(--card-foreground); font-size: 15px; line-height: 1; cursor: pointer; flex-shrink: 0; }
    .btab-add:hover { background: var(--muted); }
    #browserWrap { position: relative; display: flex; align-items: stretch; gap: 8px; max-width: 100%; min-height: 0; flex: 1; }
    #bookmarksOverlay { display: none; position: absolute; inset: 0; z-index: 20; background: var(--card); border: 2px solid var(--border); border-radius: 12px; padding: 28px; overflow: auto; }
    .bm-wrap { max-width: 860px; margin: 0 auto; }
    .home-status-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; margin-bottom: 22px; }
    .home-stat { background: var(--background); border: 1px solid var(--border); border-radius: 12px; padding: 11px 14px; display: flex; flex-direction: column; gap: 3px; }
    .home-stat-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted-foreground); }
    .home-stat-val { font-size: 13.5px; font-weight: 600; color: var(--card-foreground); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bm-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
    .bm-top h2 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
    .bm-sub { font-size: 12.5px; color: var(--muted-foreground); margin-top: 2px; }
    .bm-editor { display: none; background: var(--muted); border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin-bottom: 18px; }
    .bm-editor.open { display: block; }
    .bm-editor-row { display: grid; grid-template-columns: 1fr 1.4fr auto; gap: 8px; align-items: center; margin-top: 8px; }
    @media (max-width: 640px) { .bm-editor-row { grid-template-columns: 1fr; } }
    .bm-editor input { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--card-foreground); font-size: 13px; outline: none; }
    .bm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
    .bm-card { position: relative; display: flex; align-items: center; gap: 11px; padding: 12px 13px; background: var(--background); border: 1px solid var(--border); border-radius: 12px; cursor: pointer; text-align: left; color: var(--card-foreground); }
    .bm-card:hover { border-color: var(--primary); }
    .bm-ico { width: 34px; height: 34px; border-radius: 8px; background: var(--muted); display: grid; place-items: center; font-weight: 700; font-size: 14px; flex-shrink: 0; }
    .bm-info { min-width: 0; flex: 1; padding-right: 40px; }
    .bm-title { font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bm-host { font-size: 11.5px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
    .bm-acts { position: absolute; top: 6px; right: 6px; display: flex; gap: 2px; }
    .bm-act { width: 22px; height: 22px; padding: 0; border-radius: 6px; border: 0; background: transparent; color: var(--muted-foreground); font-size: 12px; display: grid; place-items: center; cursor: pointer; }
    .bm-act:hover { background: var(--muted); color: var(--card-foreground); }
    .bm-act.del:hover { color: var(--destructive); }
    #termStage { display: none; flex-direction: column; gap: 6px; width: 100%; height: 100%; min-height: 0; }
    #termWrap { flex: 1; width: 100%; min-height: 0; background: var(--card); border: 2px solid var(--border); border-radius: 12px; padding: 10px; overflow: hidden; }
    #termWrap.controlling { border-color: #22c55e; }
    #terminal { width: 100%; height: 100%; }
    #filesWrap { display: none; width: 100%; height: 100%; min-height: 0; grid-template-columns: minmax(260px, 380px) 1fr; gap: 12px; }
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
    .file-act.shared { color: #16a34a; font-weight: 700; }
    .share-badge { display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px; border-radius: 999px; font-size: 10.5px; font-weight: 600; background: color-mix(in oklch, #16a34a 15%, transparent); color: #16a34a; border: 1px solid color-mix(in oklch, #16a34a 35%, transparent); flex-shrink: 0; }
    #shareModal { display: none; position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,0.45); place-items: center; padding: 16px; }
    #shareModal .modal-card { width: min(440px, 100%); background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: 14px; padding: 20px; box-shadow: 0 20px 50px rgba(0,0,0,0.3); font-size: 13px; line-height: 1.5; }
    .share-exp-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 6px 0 14px; }
    .share-exp-btn { padding: 7px 6px; border-radius: 8px; border: 1px solid var(--border); background: var(--muted); color: var(--card-foreground); font-size: 12px; font-weight: 600; cursor: pointer; text-align: center; }
    .share-exp-btn.active { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); }
    .share-input { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--background); color: var(--card-foreground); font-size: 13px; margin: 6px 0 14px; outline: none; }
    .share-input:focus { border-color: var(--primary); }
    .preview-body { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 14px; display: flex; align-items: center; justify-content: center; }
    .preview-body img { max-width: 100%; max-height: calc(100vh - 148px); object-fit: contain; border: 1px solid var(--border); border-radius: 8px; box-shadow: none; }
    .preview-body video { max-width: 100%; max-height: calc(100vh - 148px); width: auto; height: auto; object-fit: contain; border-radius: 10px; background: #000; }
    .preview-body pre { width: 100%; height: 100%; margin: 0; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: var(--card-foreground); }
    .preview-empty { color: var(--muted-foreground); font-size: 13px; text-align: center; }
    .audio-card { width: min(460px, 100%); background: var(--muted); border: 1px solid var(--border); border-radius: 14px; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
    .audio-title { font-size: 15px; font-weight: 700; color: var(--card-foreground); word-break: break-word; }
    .audio-sub { font-size: 12px; color: var(--muted-foreground); }
    .audio-card audio { width: 100%; outline: none; }
    .audio-controls { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .audio-speeds, .audio-nav { display: flex; align-items: center; gap: 4px; }
    .audio-btn { padding: 4px 9px; border-radius: 7px; border: 1px solid var(--border); background: var(--card); color: var(--card-foreground); font-size: 11.5px; font-weight: 600; cursor: pointer; }
    .audio-btn.active { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); }
    .audio-btn:disabled { opacity: 0.4; cursor: default; }
    #mcpModal { display: none; position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,0.45); place-items: center; padding: 16px; }
    #mcpModal .modal-card { width: min(620px, 100%); max-height: 88vh; overflow: auto; background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: 14px; padding: 20px; box-shadow: 0 20px 50px rgba(0,0,0,0.3); font-size: 13px; line-height: 1.5; }
    #mcpModal pre { margin: 0 0 10px; padding: 10px 12px; background: var(--muted); border: 1px solid var(--border); border-radius: 10px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; color: var(--card-foreground); }
    #mcpModal code { background: var(--muted); color: var(--card-foreground); padding: 2px 6px; border-radius: 6px; font-size: 12px; }
    .mcp-clients { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 12px; }
    .mcp-pill { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--muted); color: var(--muted-foreground); font-size: 12px; font-weight: 600; cursor: pointer; }
    .mcp-pill.active { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); }
    .mcp-panel { display: none; }
    .mcp-panel.active { display: block; }
    .mcp-steps { margin: 6px 0 10px; padding-left: 18px; color: var(--muted-foreground); }
    .mcp-steps li { margin-bottom: 4px; }
  </style>
</head>
<body>
  <header>
    <a class="brand" href="/">${OPENBOXY_LOGO_SVG}<span>OpenBoxy</span></a>
    <div class="tabs">
      <button class="tab active" id="tabBrowser" type="button">Browser</button>
      <button class="tab" id="tabTerminal" type="button">Terminal</button>
      <button class="tab" id="tabFiles" type="button">Files</button>
    </div>
    <div id="navBtns" class="nav-btns">
      <button class="icon-btn" id="backBtn" type="button" title="Back" aria-label="Back">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <button class="icon-btn" id="refreshBtn" type="button" title="Reload page" aria-label="Reload page">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
      </button>
      <button class="icon-btn" id="forwardBtn" type="button" title="Forward" aria-label="Forward">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>
    <form id="navForm" class="url-bar">
      <button class="icon-btn" id="homeBtn" type="button" title="Bookmarks Home">&#8962;</button>
      <input id="urlInput" type="text" placeholder="https://example.com" />
      <button class="icon-btn" id="savePageBtn" type="button" title="Save current webpage to Files">&#10515;</button>
      <button class="go-btn" id="goBtn" type="submit" title="Go to URL">Go</button>
    </form>
    <div class="actions">
      <button class="take" id="controlBtn" type="button">Take Control</button>
      <span class="meta" id="status">Loading…</span>
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
    <div id="ctxMenu" role="menu"></div>
    <button type="button" id="fsExitBtn" title="Exit Full Screen">&#x2715; Exit Full Screen</button>
    <div id="browserStage">
      <div class="browser-tabs-row">
        <div id="browserTabsBar" class="browser-tabs-bar"></div>
        <button class="icon-btn" id="fullscreenBtn" type="button" title="Full Screen" aria-label="Full Screen" style="flex-shrink:0;border:1px solid var(--border);background:var(--card);">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
        </button>
      </div>
      <div id="browserWrap">
        <img id="screen" tabindex="0" draggable="false" alt="Live Browser View" />
        <div id="bookmarksOverlay">
          <div class="bm-wrap">
            <div id="homeStatusBar" class="home-status-bar">
              <div class="home-stat">
                <div class="home-stat-label" id="homeIpLabel">Exit IP &amp; Country</div>
                <div class="home-stat-val" id="homeExitIp">Checking…</div>
              </div>
              <div class="home-stat">
                <div class="home-stat-label" id="homeServerTzLabel">Server Date &amp; Time</div>
                <div class="home-stat-val" id="homeServerTime">--</div>
              </div>
              <div class="home-stat">
                <div class="home-stat-label" id="homeRemoteTzLabel">VPN Country Time</div>
                <div class="home-stat-val" id="homeRemoteTime">--</div>
              </div>
            </div>
            <div id="bmPluginsSection" style="display:none;margin-bottom:26px;">
              <div class="bm-top" style="margin-bottom:12px;">
                <div>
                  <h2>Plugins</h2>
                  <div class="bm-sub">Click a plugin to open it in Boxy's browser.</div>
                </div>
              </div>
              <div class="bm-grid" id="bmPluginsGrid"></div>
            </div>
            <div class="bm-top">
              <div>
                <h2>Bookmarks</h2>
                <div class="bm-sub">Click a bookmark to open it in the browser, or add, edit, and delete bookmarks.</div>
              </div>
              <button type="button" id="bmAddBtn">+ Add Bookmark</button>
            </div>
            <div class="bm-editor" id="bmEditor">
              <strong style="font-size:13px;" id="bmEditorTitle">Add Bookmark</strong>
              <input type="hidden" id="bmEditId" value="" />
              <div class="bm-editor-row">
                <input type="text" id="bmEditTitle" placeholder="Title (e.g. Hacker News)" />
                <input type="text" id="bmEditUrl" placeholder="https://news.ycombinator.com" />
                <div style="display:flex;gap:6px;">
                  <button type="button" id="bmSaveBtn">Save</button>
                  <button type="button" class="sec" id="bmCancelBtn">Cancel</button>
                </div>
              </div>
            </div>
            <div class="bm-grid" id="bmGrid"></div>
          </div>
        </div>
      </div>
    </div>
    <div id="termStage">
      <div class="browser-tabs-row">
        <div id="termTabsBar" class="browser-tabs-bar"></div>
      </div>
      <div id="termWrap"><div id="terminal"></div></div>
    </div>
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
          <div style="display:flex;gap:4px;flex-shrink:0;">
            <button id="previewListenBtn" class="sec" type="button" style="display:none;padding:4px 8px;font-size:11.5px;">&#127911; Listen</button>
            <button id="previewShareBtn" class="sec" type="button" style="display:none;padding:4px 8px;font-size:11.5px;">Share</button>
            <a id="previewDownload" href="#" style="display:none;text-decoration:none;"><button class="sec" type="button" style="padding:4px 8px;font-size:11.5px;">Download</button></a>
          </div>
        </div>
        <div id="previewTtsBar" style="display:none;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--border);background:var(--muted);flex-wrap:wrap;font-size:12px;">
          <audio id="previewTtsAudio" controls preload="none" style="height:30px;flex:1;min-width:200px;"></audio>
          <div class="audio-speeds" id="previewTtsSpeeds"></div>
          <select id="previewTtsVoice" style="padding:4px 7px;border-radius:7px;border:1px solid var(--border);background:var(--card);color:var(--card-foreground);font-size:11.5px;">
            <option value="auto">Auto Voice</option>
            <option value="en-US-EmmaMultilingualNeural">Emma (US)</option>
            <option value="en-US-AndrewMultilingualNeural">Andrew (US)</option>
            <option value="en-US-AriaNeural">Aria (US)</option>
            <option value="en-GB-SoniaNeural">Sonia (UK)</option>
            <option value="zh-CN-XiaoxiaoNeural">Xiaoxiao (中文)</option>
            <option value="zh-CN-YunxiNeural">Yunxi (中文)</option>
          </select>
          <span id="previewTtsStatus" style="color:var(--muted-foreground);font-size:11.5px;"></span>
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
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;padding:8px 10px;background:var(--muted);border:1px solid var(--border);border-radius:10px;">
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          <span style="color:var(--muted-foreground);font-size:12px;">Endpoint:</span> <code id="obxMcpUrl">${escapeHtml(mcpUrl)}</code>
        </div>
        <button type="button" class="sec" style="padding:3px 9px;font-size:11px;flex-shrink:0;" onclick="navigator.clipboard.writeText(document.getElementById('obxMcpUrl').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
      </div>

      <div class="mcp-clients" role="tablist">
        <button type="button" class="mcp-pill active" data-mcp-client="opencode">OpenCode</button>
        <button type="button" class="mcp-pill" data-mcp-client="claude-code">Claude Code</button>
        <button type="button" class="mcp-pill" data-mcp-client="codex">Codex</button>
        <button type="button" class="mcp-pill" data-mcp-client="gemini-cli">Gemini CLI</button>
        <button type="button" class="mcp-pill" data-mcp-client="cursor">Cursor</button>
        <button type="button" class="mcp-pill" data-mcp-client="vscode">VS Code</button>
        <button type="button" class="mcp-pill" data-mcp-client="openclaw">OpenClaw</button>
        <button type="button" class="mcp-pill" data-mcp-client="hermes">Hermes</button>
        <button type="button" class="mcp-pill" data-mcp-client="deepseek">DeepSeek Harness</button>
        <button type="button" class="mcp-pill" data-mcp-client="workbuddy">WorkBuddy</button>
        <button type="button" class="mcp-pill" data-mcp-client="chatgpt">ChatGPT</button>
        <button type="button" class="mcp-pill" data-mcp-client="claude">Claude</button>
        <button type="button" class="mcp-pill" data-mcp-client="gemini">Gemini</button>
      </div>

      <div class="mcp-panel active" data-mcp-panel="opencode">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span>Add to <code>~/.config/opencode/opencode.jsonc</code>:</span>
          <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxMcpJson').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
        </div>
        <pre id="obxMcpJson">${escapeHtml(opencodeJson)}</pre>
        <ol class="mcp-steps">
          <li>Run <code>/mcps</code> in OpenCode, select <strong>${escapeHtml(mcpName)}</strong>, and click Sign in.</li>
          <li>Approve with your API token (user <code>@${escapeHtml(userId)}</code>).</li>
        </ol>
      </div>

      <div class="mcp-panel" data-mcp-panel="claude-code">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span>Run in your terminal:</span>
          <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxClaudeCodeCmd').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
        </div>
        <pre id="obxClaudeCodeCmd">claude mcp add --transport http ${escapeHtml(mcpName)} ${escapeHtml(mcpUrl)}</pre>
        <ol class="mcp-steps">
          <li>In Claude Code run <code>/mcp</code> (or <code>claude mcp login ${escapeHtml(mcpName)}</code>) and select <strong>Authenticate</strong>.</li>
          <li>Sign in with your API token in the browser popup.</li>
        </ol>
      </div>

      <div class="mcp-panel" data-mcp-panel="codex">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span>Run in your terminal:</span>
          <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxCodexCmd').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
        </div>
        <pre id="obxCodexCmd">codex mcp add ${escapeHtml(mcpName)} --url ${escapeHtml(mcpUrl)}
codex mcp login ${escapeHtml(mcpName)}</pre>
        <div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0 4px;">
          <span style="color:var(--muted-foreground);">Or add to <code>~/.codex/config.toml</code>:</span>
          <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxCodexToml').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
        </div>
        <pre id="obxCodexToml">${escapeHtml(codexToml)}</pre>
      </div>

      <div class="mcp-panel" data-mcp-panel="gemini-cli">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span>Run in your terminal:</span>
          <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxGeminiCliCmd').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
        </div>
        <pre id="obxGeminiCliCmd">gemini mcp add --transport http --scope user ${escapeHtml(mcpName)} ${escapeHtml(mcpUrl)}</pre>
        <div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0 4px;">
          <span style="color:var(--muted-foreground);">Or add to <code>~/.gemini/settings.json</code>:</span>
          <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxGeminiCliJson').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
        </div>
        <pre id="obxGeminiCliJson">${escapeHtml(geminiCliJson)}</pre>
        <div style="color:var(--muted-foreground);font-size:12px;">Then run <code>/mcp auth ${escapeHtml(mcpName)}</code> inside Gemini CLI and sign in with your API token.</div>
      </div>

      <div class="mcp-panel" data-mcp-panel="cursor">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span>Add to <code>~/.cursor/mcp.json</code> (or <strong>Settings &rarr; Tools &amp; MCP</strong>):</span>
          <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxCursorJson').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
        </div>
        <pre id="obxCursorJson">${escapeHtml(cursorJson)}</pre>
        <div style="color:var(--muted-foreground);font-size:12px;">Click <strong>Needs login</strong> next to <strong>${escapeHtml(mcpName)}</strong> in Cursor and approve with your API token.</div>
      </div>

      <div class="mcp-panel" data-mcp-panel="openclaw">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span>Run via CLI (or Control UI &rarr; <strong>Settings &rarr; MCP</strong>):</span>
          <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxOpenClawCmd').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
        </div>
        <pre id="obxOpenClawCmd">openclaw mcp add ${escapeHtml(mcpName)} --transport http --url ${escapeHtml(mcpUrl)}</pre>
        <div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0 4px;">
          <span style="color:var(--muted-foreground);">Or add to <code>~/.openclaw/openclaw.json</code>:</span>
          <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxOpenClawJson').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
        </div>
        <pre id="obxOpenClawJson">${escapeHtml(openclawJson)}</pre>
      </div>

      <div class="mcp-panel" data-mcp-panel="chatgpt">
        <ol class="mcp-steps">
          <li>Open ChatGPT &rarr; <strong>Settings &rarr; Apps / Connectors</strong> (enable <em>Developer mode</em> if shown).</li>
          <li>Click <strong>Create / Add custom MCP server</strong>.</li>
          <li>Name: <code>${escapeHtml(mcpName)}</code> · MCP Server URL: <code>${escapeHtml(mcpUrl)}</code> · Authentication: <strong>OAuth</strong>.</li>
          <li>Click <strong>Create</strong> and sign in with your API token on the OAuth prompt.</li>
        </ol>
      </div>

      <div class="mcp-panel" data-mcp-panel="claude">
        <ol class="mcp-steps">
          <li>Open Claude (Web or Desktop) &rarr; <strong>Settings &rarr; Connectors</strong>.</li>
          <li>Click <strong>Add custom connector</strong>.</li>
          <li>Name: <code>${escapeHtml(mcpName)}</code> · Remote MCP server URL: <code>${escapeHtml(mcpUrl)}</code>.</li>
          <li>Click <strong>Connect</strong> and approve OAuth with your API token.</li>
        </ol>
      </div>

      <div class="mcp-panel" data-mcp-panel="gemini">
        <ol class="mcp-steps">
          <li>Open <code>gemini.google.com</code> &rarr; <strong>Settings &rarr; Connected Apps</strong>.</li>
          <li>Select <strong>Add custom app / MCP Server URL</strong>.</li>
          <li>Paste <code>${escapeHtml(mcpUrl)}</code> and complete OAuth sign-in with your API token.</li>
        </ol>
      </div>

      <div class="mcp-panel" data-mcp-panel="vscode">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span>Add to <code>.vscode/mcp.json</code> (or Command Palette &rarr; <strong>MCP: Add Server</strong> &rarr; <strong>HTTP</strong>):</span>
          <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxVscodeJson').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
        </div>
        <pre id="obxVscodeJson">${escapeHtml(vscodeJson)}</pre>
        <div style="color:var(--muted-foreground);font-size:12px;">VS Code discovers OAuth automatically and opens your browser to sign in with your API token.</div>
      </div>

      <div class="mcp-panel" data-mcp-panel="hermes">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span>Add to <code>~/.hermes/config.yaml</code> (and set <code>OPENBOXY_MCP_TOKEN</code> in <code>~/.hermes/.env</code>):</span>
          <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxHermesYaml').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
        </div>
        <pre id="obxHermesYaml">${escapeHtml(hermesYaml)}</pre>
        <div style="color:var(--muted-foreground);font-size:12px;">Restart <code>hermes chat</code> to load the remote tools.</div>
      </div>

      <div class="mcp-panel" data-mcp-panel="deepseek">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span>Add to your DeepSeek Harness config (with <code>OPENBOXY_MCP_TOKEN</code> set in env):</span>
          <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxDeepseekYaml').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
        </div>
        <pre id="obxDeepseekYaml">${escapeHtml(deepseekYaml)}</pre>
      </div>

      <div class="mcp-panel" data-mcp-panel="workbuddy">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span>Add to <code>~/.codebuddy/.mcp.json</code> (or <strong>Plugins &rarr; MCP Server &rarr; Configure MCP</strong>):</span>
          <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxWorkbuddyJson').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
        </div>
        <pre id="obxWorkbuddyJson">${escapeHtml(workbuddyJson)}</pre>
        <div style="color:var(--muted-foreground);font-size:12px;">Replace <code>YOUR_API_TOKEN</code> with your API access token.</div>
      </div>

      <div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="font-size:12px;"><strong>Or paste this prompt to any AI coding agent:</strong></span>
          <button type="button" class="sec" style="padding:3px 9px;font-size:11px;" onclick="navigator.clipboard.writeText(document.getElementById('obxAgentPrompt').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
        </div>
        <pre id="obxAgentPrompt" style="margin-bottom:0;">${escapeHtml(agentPrompt)}</pre>
      </div>
    </div>
  </div>
  <div id="shareModal" onclick="if(event.target===this)this.style.display='none';">
    <div class="modal-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="font-size:15px;">Share File</strong>
        <button type="button" class="sec" style="padding:4px 9px;" onclick="document.getElementById('shareModal').style.display='none';">&times;</button>
      </div>
      <div id="shareModalPath" style="font-size:12px;color:var(--muted-foreground);margin-bottom:12px;word-break:break-all;"></div>
      <div id="shareLinkBox" style="display:none;margin-bottom:14px;padding:10px;background:var(--muted);border:1px solid var(--border);border-radius:10px;">
        <div style="font-size:11.5px;color:var(--muted-foreground);margin-bottom:4px;" id="shareStatusMeta">Active Share Link</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <input id="shareUrlOutput" type="text" readonly style="flex:1;padding:6px 8px;border-radius:7px;border:1px solid var(--border);background:var(--card);color:var(--card-foreground);font-size:12px;outline:none;" />
          <button type="button" id="shareCopyBtn" style="padding:6px 10px;font-size:12px;">Copy</button>
        </div>
      </div>
      <div style="font-weight:600;font-size:12px;">Expiration</div>
      <div class="share-exp-grid" id="shareExpGrid">
        <button type="button" class="share-exp-btn" data-exp="1d">1 Day</button>
        <button type="button" class="share-exp-btn active" data-exp="1w">1 Week</button>
        <button type="button" class="share-exp-btn" data-exp="1m">1 Month</button>
        <button type="button" class="share-exp-btn" data-exp="forever">Forever</button>
      </div>
      <label for="sharePasswordInput" style="font-weight:600;font-size:12px;display:block;">Password <span id="sharePwHint" style="font-weight:400;color:var(--muted-foreground);">(optional)</span></label>
      <input id="sharePasswordInput" class="share-input" type="password" autocomplete="new-password" placeholder="Leave blank for no password" />
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <button type="button" id="shareRemoveBtn" class="sec" style="display:none;color:var(--destructive);border-color:color-mix(in oklch, var(--destructive) 40%, var(--border));">Remove Share</button>
        <div style="display:flex;gap:6px;margin-left:auto;">
          <button type="button" class="sec" onclick="document.getElementById('shareModal').style.display='none';">Close</button>
          <button type="button" id="shareSaveBtn">Create Share Link</button>
        </div>
      </div>
    </div>
  </div>
  <div id="fileChooserModal" style="display:none;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);place-items:center;padding:16px;">
    <div class="modal-card" style="width:min(420px,100%);background:var(--card);color:var(--card-foreground);border:1px solid var(--border);border-radius:14px;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,0.3);font-size:13px;line-height:1.5;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="font-size:15px;">Upload File to Browser</strong>
        <button type="button" id="fcCloseBtn" class="sec" style="padding:4px 9px;">&times;</button>
      </div>
      <p style="margin:0 0 14px;color:var(--muted-foreground);">The webpage requested a file upload. Choose a file from your computer to send it to the browser.</p>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button type="button" id="fcCancelBtn" class="sec">Cancel</button>
        <label style="display:inline-flex;align-items:center;padding:7px 14px;border-radius:9px;background:var(--primary);color:var(--primary-foreground);font-weight:600;font-size:12.5px;cursor:pointer;">
          Choose File
          <input id="fcFileInput" type="file" style="display:none;" />
        </label>
      </div>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script>
    const browserWrap = document.getElementById("browserWrap");
    const browserStage = document.getElementById("browserStage");
    const browserTabsBar = document.getElementById("browserTabsBar");
    const img = document.getElementById("screen");
    const termStage = document.getElementById("termStage");
    const termTabsBar = document.getElementById("termTabsBar");
    const termWrap = document.getElementById("termWrap");
    const termEl = document.getElementById("terminal");
    const navForm = document.getElementById("navForm");
    const homeBtn = document.getElementById("homeBtn");
    const urlInput = document.getElementById("urlInput");
    const bookmarksOverlay = document.getElementById("bookmarksOverlay");
    const bmAddBtn = document.getElementById("bmAddBtn");
    const bmEditor = document.getElementById("bmEditor");
    const bmEditorTitle = document.getElementById("bmEditorTitle");
    const bmEditId = document.getElementById("bmEditId");
    const bmEditTitle = document.getElementById("bmEditTitle");
    const bmEditUrl = document.getElementById("bmEditUrl");
    const bmSaveBtn = document.getElementById("bmSaveBtn");
    const bmCancelBtn = document.getElementById("bmCancelBtn");
    const bmGrid = document.getElementById("bmGrid");
    const bmPluginsSection = document.getElementById("bmPluginsSection");
    const bmPluginsGrid = document.getElementById("bmPluginsGrid");
    let bookmarksList = [];
    let pluginLinksList = [];
    let bookmarksLoaded = false;
    const controlBtn = document.getElementById("controlBtn");
    const fullscreenBtn = document.getElementById("fullscreenBtn");
    const fsExitBtn = document.getElementById("fsExitBtn");
    const savePageBtn = document.getElementById("savePageBtn");
    const navBtns = document.getElementById("navBtns");
    const backBtn = document.getElementById("backBtn");
    const refreshBtn = document.getElementById("refreshBtn");
    const forwardBtn = document.getElementById("forwardBtn");
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
    const previewListenBtn = document.getElementById("previewListenBtn");
    const previewTtsBar = document.getElementById("previewTtsBar");
    const previewTtsAudio = document.getElementById("previewTtsAudio");
    const previewTtsSpeeds = document.getElementById("previewTtsSpeeds");
    const previewTtsVoice = document.getElementById("previewTtsVoice");
    const previewTtsStatus = document.getElementById("previewTtsStatus");
    const previewShareBtn = document.getElementById("previewShareBtn");
    const previewDownload = document.getElementById("previewDownload");
    const shareModal = document.getElementById("shareModal");
    const shareModalPath = document.getElementById("shareModalPath");
    const shareLinkBox = document.getElementById("shareLinkBox");
    const shareStatusMeta = document.getElementById("shareStatusMeta");
    const shareUrlOutput = document.getElementById("shareUrlOutput");
    const shareCopyBtn = document.getElementById("shareCopyBtn");
    const shareExpGrid = document.getElementById("shareExpGrid");
    const sharePasswordInput = document.getElementById("sharePasswordInput");
    const sharePwHint = document.getElementById("sharePwHint");
    const shareRemoveBtn = document.getElementById("shareRemoveBtn");
    const shareSaveBtn = document.getElementById("shareSaveBtn");
    let currentShareTarget = "";
    let currentShareExp = "1w";
    let currentShareInfo = null;
    let fileSharesByPath = {};
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

    const ctxMenu = document.getElementById("ctxMenu");
    function closeCtxMenu() {
      ctxMenu.classList.remove("open");
      ctxMenu.innerHTML = "";
    }
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
      if (!ctxMenu.contains(e.target)) closeCtxMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeMenu();
        closeCtxMenu();
        mcpModal.style.display = "none";
        shareModal.style.display = "none";
        if (document.body.classList.contains("obx-fs") && !controlling) {
          exitFullScreenMode();
        }
      }
    });

    mcpSetupBtn.addEventListener("click", () => {
      closeMenu();
      mcpModal.style.display = mcpModal.style.display === "grid" ? "none" : "grid";
    });
    document.querySelectorAll("[data-mcp-client]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-mcp-client");
        document.querySelectorAll("[data-mcp-client]").forEach((b) => b.classList.toggle("active", b === btn));
        document.querySelectorAll("[data-mcp-panel]").forEach((p) => p.classList.toggle("active", p.getAttribute("data-mcp-panel") === key));
      });
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
        const isHome = data.url === "boxy://home" || data.url === "boxy://bookmarks";
        bookmarksOverlay.style.display = isHome ? "block" : "none";
        if (isHome) {
          if (!bookmarksLoaded) loadBookmarks();
          if (Date.now() - lastNetworkStatusAt > 10000) loadNetworkStatus();
        }
        if (Array.isArray(data.tabs)) {
          renderBrowserTabs(data.tabs);
        }
        if (data.fileChooser && data.fileChooser.id !== lastHandledFcId) {
          openFileChooserModal(data.fileChooser);
        }
        statusEl.textContent = new Date().toLocaleTimeString();
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

    let currentTermTabId = "";

    function renderTermTabs(tabs, activeId) {
      if (activeId) currentTermTabId = activeId;
      termTabsBar.innerHTML = "";
      for (const t of tabs || []) {
        const el = document.createElement("div");
        el.className = t.active ? "btab active" : "btab";
        el.title = t.title || "Terminal";
        const titleSpan = document.createElement("span");
        titleSpan.className = "btab-title";
        titleSpan.textContent = t.title || "Terminal";
        el.appendChild(titleSpan);
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "btab-close";
        closeBtn.textContent = "×";
        closeBtn.title = "Close terminal tab";
        closeBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          await postTermTabAction("/view/terminal/tabs/close", { id: t.id });
        });
        el.appendChild(closeBtn);
        el.addEventListener("click", async () => {
          if (!t.active) await postTermTabAction("/view/terminal/tabs/select", { id: t.id });
        });
        termTabsBar.appendChild(el);
      }
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btab-add";
      addBtn.textContent = "+";
      addBtn.title = "New terminal tab";
      addBtn.addEventListener("click", async () => {
        await postTermTabAction("/view/terminal/tabs/new", {});
      });
      termTabsBar.appendChild(addBtn);

      const piBtn = document.createElement("button");
      piBtn.type = "button";
      piBtn.className = "btab";
      piBtn.style.cssText = "font-weight:600;color:var(--card-foreground);background:var(--card);";
      piBtn.textContent = "+ Pi";
      piBtn.title = "Open Pi AI agent in a new terminal tab";
      piBtn.addEventListener("click", async () => {
        await postTermTabAction("/view/terminal/tabs/new", { title: "Pi Agent", initialInput: "pi\\r" });
      });
      termTabsBar.appendChild(piBtn);
    }

    async function loadTerminalTabs() {
      try {
        const res = await fetch("/view/terminal/tabs");
        if (!res.ok) return;
        const data = await res.json();
        renderTermTabs(data.tabs || [], data.activeId || "");
        connectTerminal(data.activeId || "");
      } catch {}
    }

    async function postTermTabAction(endpoint, payload) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload || {}),
        });
        if (!res.ok) return;
        const data = await res.json();
        renderTermTabs(data.tabs || [], data.activeId || "");
        connectTerminal(data.activeId || "", true);
        if (term) term.focus();
      } catch {}
    }

    function connectTerminal(targetTabId, forceReconnect = false) {
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
      const desiredId = targetTabId || currentTermTabId || "";
      setTimeout(() => {
        if (fitAddon) fitAddon.fit();
      }, 20);
      if (
        !forceReconnect &&
        termWs &&
        (termWs.readyState === WebSocket.OPEN || termWs.readyState === WebSocket.CONNECTING) &&
        (!desiredId || termWs._tabId === desiredId)
      ) {
        return;
      }
      if (termWs) {
        try {
          termWs.onclose = null;
          termWs.close();
        } catch {}
        termWs = null;
      }
      term.reset();
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const q = desiredId ? ("?id=" + encodeURIComponent(desiredId)) : "";
      const ws = new WebSocket(proto + "//" + location.host + "/view/terminal" + q);
      ws._tabId = desiredId;
      ws.binaryType = "arraybuffer";
      termWs = ws;
      ws.onopen = () => {
        if (fitAddon) fitAddon.fit();
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        statusEl.textContent = new Date().toLocaleTimeString();
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === "error") {
              term.writeln("\\r\\n[Error: " + (msg.error || msg.message || "Unknown error") + "]");
            } else if (msg.type === "tabs" && Array.isArray(msg.tabs)) {
              const prevActive = currentTermTabId;
              renderTermTabs(msg.tabs, msg.activeId || "");
              if (msg.activeId && msg.activeId !== prevActive) {
                connectTerminal(msg.activeId, true);
              }
            }
          } catch {}
          return;
        }
        term.write(new Uint8Array(e.data));
      };
      ws.onclose = () => {
        if (termWs === ws) {
          statusEl.textContent = "Terminal disconnected";
        }
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

    const AUDIO_EXTS = ["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"];
    const VIDEO_EXTS = ["mp4", "webm", "mov"];
    let currentAudioList = [];

    function setShareExpUI(exp) {
      currentShareExp = exp;
      shareExpGrid.querySelectorAll("[data-exp]").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-exp") === exp);
      });
    }
    shareExpGrid.querySelectorAll("[data-exp]").forEach((b) => {
      b.addEventListener("click", () => setShareExpUI(b.getAttribute("data-exp") || "1w"));
    });
    shareCopyBtn.addEventListener("click", () => {
      if (!shareUrlOutput.value) return;
      navigator.clipboard.writeText(shareUrlOutput.value);
      shareCopyBtn.textContent = "Copied!";
      setTimeout(() => { shareCopyBtn.textContent = "Copy"; }, 1500);
    });

    function openShareModal(relPath, shareInfo) {
      currentShareTarget = relPath;
      currentShareInfo = shareInfo || fileSharesByPath[relPath] || null;
      shareModalPath.textContent = relPath;
      sharePasswordInput.value = "";
      setShareExpUI("1w");
      if (currentShareInfo) {
        shareLinkBox.style.display = "block";
        shareUrlOutput.value = currentShareInfo.url;
        const expText = currentShareInfo.expiresAt
          ? "Expires " + new Date(currentShareInfo.expiresAt).toLocaleDateString()
          : "Never expires";
        shareStatusMeta.textContent = expText + (currentShareInfo.hasPassword ? " · Password protected" : " · No password");
        sharePwHint.textContent = currentShareInfo.hasPassword
          ? "(currently set — leave blank to keep, or enter new)"
          : "(optional)";
        shareRemoveBtn.style.display = "inline-block";
        shareSaveBtn.textContent = "Update Share";
      } else {
        shareLinkBox.style.display = "none";
        shareUrlOutput.value = "";
        sharePwHint.textContent = "(optional)";
        shareRemoveBtn.style.display = "none";
        shareSaveBtn.textContent = "Create Share Link";
      }
      shareModal.style.display = "grid";
    }

    shareSaveBtn.addEventListener("click", async () => {
      if (!currentShareTarget) return;
      const pw = sharePasswordInput.value.trim();
      const keepExistingPassword = Boolean(currentShareInfo && currentShareInfo.hasPassword && !pw);
      shareSaveBtn.disabled = true;
      try {
        const res = await fetch("/api/shares", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: currentShareTarget,
            expiresIn: currentShareExp,
            password: pw || null,
            keepExistingPassword,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        fileSharesByPath[currentShareTarget] = data.share;
        openShareModal(currentShareTarget, data.share);
        loadFiles(currentDir, true);
      } catch (err) {
        alert("Failed to save share: " + (err.message || err));
      } finally {
        shareSaveBtn.disabled = false;
      }
    });

    shareRemoveBtn.addEventListener("click", async () => {
      if (!currentShareTarget) return;
      shareRemoveBtn.disabled = true;
      try {
        const res = await fetch("/api/shares?path=" + encodeURIComponent(currentShareTarget), { method: "DELETE" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        delete fileSharesByPath[currentShareTarget];
        currentShareInfo = null;
        shareModal.style.display = "none";
        loadFiles(currentDir, true);
      } catch (err) {
        alert("Failed to remove share: " + (err.message || err));
      } finally {
        shareRemoveBtn.disabled = false;
      }
    });

    previewShareBtn.addEventListener("click", () => {
      if (selectedFile) openShareModal(selectedFile, fileSharesByPath[selectedFile] || null);
    });

    for (const rate of [1, 1.25, 1.5, 2]) {
      const sb = document.createElement("button");
      sb.type = "button";
      sb.className = "audio-btn" + (rate === 1 ? " active" : "");
      sb.textContent = rate + "x";
      sb.onclick = () => {
        previewTtsAudio.playbackRate = rate;
        previewTtsSpeeds.querySelectorAll(".audio-btn").forEach((b) => b.classList.remove("active"));
        sb.classList.add("active");
      };
      previewTtsSpeeds.appendChild(sb);
    }

    function startPreviewTts() {
      if (!selectedFile) return;
      const v = previewTtsVoice.value || "auto";
      previewTtsStatus.textContent = "Generating audio…";
      previewTtsAudio.src =
        "/api/files/tts?path=" + encodeURIComponent(selectedFile) + "&voice=" + encodeURIComponent(v);
      previewTtsAudio.play().catch(() => {});
    }

    previewTtsAudio.addEventListener("canplay", () => {
      previewTtsStatus.textContent = "";
    });
    previewTtsAudio.addEventListener("error", () => {
      previewTtsStatus.textContent = "TTS failed";
    });
    previewTtsVoice.addEventListener("change", () => {
      if (previewTtsBar.style.display === "flex") startPreviewTts();
    });
    previewListenBtn.addEventListener("click", () => {
      const open = previewTtsBar.style.display === "flex";
      if (open) {
        previewTtsAudio.pause();
        previewTtsBar.style.display = "none";
      } else {
        previewTtsBar.style.display = "flex";
        if (!previewTtsAudio.getAttribute("src")) startPreviewTts();
        else previewTtsAudio.play().catch(() => {});
      }
    });

    async function previewFile(relPath) {
      selectedFile = relPath;
      previewTitle.textContent = relPath;
      const rawUrl = "/api/files/raw?path=" + encodeURIComponent(relPath);
      previewDownload.href = rawUrl + "&download=1";
      previewDownload.style.display = "inline-block";
      previewShareBtn.style.display = "inline-block";
      const ext = (relPath.split(".").pop() || "").toLowerCase();
      previewTtsAudio.pause();
      previewTtsAudio.removeAttribute("src");
      previewTtsBar.style.display = "none";
      previewTtsStatus.textContent = "";
      previewListenBtn.style.display = ["html", "htm", "md", "txt"].includes(ext) ? "inline-block" : "none";
      if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) {
        previewBody.innerHTML = "";
        const im = document.createElement("img");
        im.src = rawUrl + "&t=" + Date.now();
        im.alt = relPath;
        previewBody.appendChild(im);
      } else if (AUDIO_EXTS.includes(ext)) {
        previewBody.innerHTML = "";
        const card = document.createElement("div");
        card.className = "audio-card";
        const title = document.createElement("div");
        title.className = "audio-title";
        title.textContent = "🎵 " + (relPath.split("/").pop() || relPath);
        const sub = document.createElement("div");
        sub.className = "audio-sub";
        sub.textContent = relPath;
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.autoplay = true;
        audio.preload = "metadata";
        audio.src = rawUrl;
        const controls = document.createElement("div");
        controls.className = "audio-controls";
        const speeds = document.createElement("div");
        speeds.className = "audio-speeds";
        for (const rate of [1, 1.25, 1.5, 2]) {
          const sb = document.createElement("button");
          sb.type = "button";
          sb.className = "audio-btn" + (rate === 1 ? " active" : "");
          sb.textContent = rate + "x";
          sb.onclick = () => {
            audio.playbackRate = rate;
            for (const b of speeds.querySelectorAll(".audio-btn")) b.classList.remove("active");
            sb.classList.add("active");
          };
          speeds.appendChild(sb);
        }
        const nav = document.createElement("div");
        nav.className = "audio-nav";
        const idx = currentAudioList.indexOf(relPath);
        const prevBtn = document.createElement("button");
        prevBtn.type = "button";
        prevBtn.className = "audio-btn";
        prevBtn.textContent = "Prev";
        prevBtn.disabled = idx <= 0;
        prevBtn.onclick = () => { if (idx > 0) previewFile(currentAudioList[idx - 1]); };
        const nextBtn = document.createElement("button");
        nextBtn.type = "button";
        nextBtn.className = "audio-btn";
        nextBtn.textContent = "Next";
        nextBtn.disabled = idx < 0 || idx >= currentAudioList.length - 1;
        nextBtn.onclick = () => { if (idx >= 0 && idx < currentAudioList.length - 1) previewFile(currentAudioList[idx + 1]); };
        audio.addEventListener("ended", () => {
          if (idx >= 0 && idx < currentAudioList.length - 1) previewFile(currentAudioList[idx + 1]);
        });
        nav.append(prevBtn, nextBtn);
        controls.append(speeds, nav);
        card.append(title, sub, audio, controls);
        previewBody.appendChild(card);
      } else if (VIDEO_EXTS.includes(ext)) {
        previewBody.innerHTML = "";
        const vid = document.createElement("video");
        vid.controls = true;
        vid.preload = "metadata";
        vid.src = rawUrl;
        previewBody.appendChild(vid);
      } else if (ext === "pdf") {
        previewBody.innerHTML = "";
        const fr = document.createElement("iframe");
        fr.src = rawUrl;
        fr.style.cssText = "width:100%;height:100%;border:0;border-radius:8px;background:#fff;";
        previewBody.appendChild(fr);
      } else if (ext === "html" || ext === "htm") {
        previewBody.innerHTML = '<div class="preview-empty">Loading…</div>';
        try {
          const res = await fetch(rawUrl);
          if (!res.ok) throw new Error("HTTP " + res.status);
          const htmlText = await res.text();
          previewBody.innerHTML = "";
          const fr = document.createElement("iframe");
          fr.setAttribute("sandbox", "");
          fr.srcdoc = htmlText;
          fr.style.cssText = "width:100%;height:100%;border:0;border-radius:8px;background:#fff;";
          previewBody.appendChild(fr);
        } catch (err) {
          previewBody.innerHTML = '<div class="preview-empty">Failed to load: ' + (err.message || err) + "</div>";
        }
      } else if (["txt", "md", "json", "log", "csv", "ts", "tsx", "js", "jsx", "py", "sh", "yml", "yaml", "toml", "css", "xml", "env"].includes(ext) || !relPath.includes(".")) {
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
        currentAudioList = (data.entries || [])
          .filter((e) => e.type === "file" && AUDIO_EXTS.includes((e.name.split(".").pop() || "").toLowerCase()))
          .map((e) => (currentDir === "." ? e.name : currentDir + "/" + e.name));
        if (!data.entries || data.entries.length === 0) {
          filesList.innerHTML = '<div class="preview-empty" style="padding:24px;">Empty folder</div>';
        } else {
          for (const entry of data.entries) {
            const rel = currentDir === "." ? entry.name : currentDir + "/" + entry.name;
            if (entry.share) fileSharesByPath[rel] = entry.share;
            else delete fileSharesByPath[rel];
            const row = document.createElement("div");
            row.className = "file-row" + (selectedFile === rel ? " active" : "");
            const left = document.createElement("div");
            left.className = "file-name";
            const entryExt = (entry.name.split(".").pop() || "").toLowerCase();
            const icon = entry.type === "dir" ? "📁 " : AUDIO_EXTS.includes(entryExt) ? "🎵 " : VIDEO_EXTS.includes(entryExt) ? "🎬 " : "📄 ";
            const nameSpan = document.createElement("span");
            nameSpan.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
            nameSpan.textContent = icon + entry.name;
            left.appendChild(nameSpan);
            if (entry.share) {
              const badge = document.createElement("span");
              badge.className = "share-badge";
              badge.textContent = (entry.share.hasPassword ? "🔒 " : "🔗 ") + "Shared";
              badge.title = entry.share.url;
              badge.onclick = (e) => {
                e.stopPropagation();
                openShareModal(rel, entry.share);
              };
              left.appendChild(badge);
            }
            const right = document.createElement("div");
            right.className = "file-meta";
            if (entry.type === "file") {
              const sz = document.createElement("span");
              sz.textContent = formatBytes(entry.size);
              right.appendChild(sz);
              const shBtn = document.createElement("button");
              shBtn.type = "button";
              shBtn.className = "file-act" + (entry.share ? " shared" : "");
              shBtn.textContent = "🔗";
              shBtn.title = entry.share ? "Manage share (" + entry.share.url + ")" : "Share file";
              shBtn.onclick = (e) => {
                e.stopPropagation();
                openShareModal(rel, entry.share || null);
              };
              right.appendChild(shBtn);
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
                previewShareBtn.style.display = "none";
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
        if (!skipTitle) statusEl.textContent = new Date().toLocaleTimeString();
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

    let lastTabsKey = "";
    function renderBrowserTabs(tabs) {
      const key = JSON.stringify(tabs);
      if (key === lastTabsKey) return;
      lastTabsKey = key;
      browserTabsBar.innerHTML = "";
      for (const t of tabs) {
        const el = document.createElement("div");
        el.className = t.active ? "btab active" : "btab";
        el.title = t.url || t.title || "New Tab";
        const titleSpan = document.createElement("span");
        titleSpan.className = "btab-title";
        titleSpan.textContent = t.title || t.url || "New Tab";
        el.appendChild(titleSpan);
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "btab-close";
        closeBtn.textContent = "×";
        closeBtn.title = "Close tab";
        closeBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          await postTabAction("/view/tabs/close", { index: t.index });
        });
        el.appendChild(closeBtn);
        el.addEventListener("click", async () => {
          if (!t.active) await postTabAction("/view/tabs/select", { index: t.index });
        });
        browserTabsBar.appendChild(el);
      }
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btab-add";
      addBtn.textContent = "+";
      addBtn.title = "New tab";
      addBtn.addEventListener("click", async () => {
        await postTabAction("/view/tabs/new", {});
      });
      browserTabsBar.appendChild(addBtn);
    }

    async function postTabAction(endpoint, payload) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload || {}),
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.tabs)) renderBrowserTabs(data.tabs);
        }
        await refresh();
      } catch {}
    }

    function setTab(tab) {
      activeTab = tab;
      tabBrowser.className = tab === "browser" ? "tab active" : "tab";
      tabTerminal.className = tab === "terminal" ? "tab active" : "tab";
      tabFiles.className = tab === "files" ? "tab active" : "tab";
      browserStage.style.display = tab === "browser" ? "flex" : "none";
      browserWrap.style.display = tab === "browser" ? "flex" : "none";
      navBtns.style.display = tab === "browser" ? "flex" : "none";
      navForm.style.display = tab === "browser" ? "flex" : "none";
      fullscreenBtn.style.display = tab === "browser" ? "inline-block" : "none";
      if (tab !== "browser" && document.body.classList.contains("obx-fs")) {
        exitFullScreenMode();
      }
      controlBtn.style.display = tab === "files" ? "none" : "inline-block";
      termStage.style.display = tab === "terminal" ? "flex" : "none";
      filesWrap.style.display = tab === "files" ? "grid" : "none";
      if (tab === "terminal") {
        void loadTerminalTabs().then(() => {
          if (term) term.focus();
        });
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

    function enterFullScreenMode() {
      document.body.classList.add("obx-fs");
      const el = document.documentElement;
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => {});
      }
    }

    function exitFullScreenMode() {
      document.body.classList.remove("obx-fs");
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    }

    fullscreenBtn.addEventListener("click", () => {
      if (document.body.classList.contains("obx-fs")) exitFullScreenMode();
      else enterFullScreenMode();
    });
    fsExitBtn.addEventListener("click", exitFullScreenMode);
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement) {
        document.body.classList.remove("obx-fs");
      }
    });

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
        else statusEl.textContent = new Date().toLocaleTimeString();
      } catch (err) {
        statusEl.textContent = "Error: " + (err.message || err);
      }
    });

    function toRemoteCoords(e) {
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height || !img.naturalWidth || !img.naturalHeight) return null;
      return {
        x: Math.round((e.clientX - rect.left) * (img.naturalWidth / rect.width)),
        y: Math.round((e.clientY - rect.top) * (img.naturalHeight / rect.height)),
      };
    }

    let dragStart = null;
    img.addEventListener("pointerdown", (e) => {
      if (!controlling || e.button !== 0 || e.pointerType === "touch") return;
      img.focus();
      const pt = toRemoteCoords(e);
      if (!pt) return;
      dragStart = pt;
      try { img.setPointerCapture(e.pointerId); } catch {}
    });

    img.addEventListener("pointerup", async (e) => {
      if (!controlling || !dragStart || e.pointerType === "touch") return;
      const start = dragStart;
      dragStart = null;
      try { img.releasePointerCapture(e.pointerId); } catch {}
      const end = toRemoteCoords(e) || start;
      const dist = Math.hypot(end.x - start.x, end.y - start.y);
      try {
        if (dist >= 6) {
          await sendAction("/view/drag", { fromX: start.x, fromY: start.y, toX: end.x, toY: end.y });
        } else {
          await sendAction("/view/click", { x: end.x, y: end.y });
        }
        setTimeout(refresh, 150);
      } catch (err) {
        statusEl.textContent = "Error: " + (err.message || err);
      }
    });

    img.addEventListener("pointercancel", () => {
      dragStart = null;
    });

    async function pasteRemoteText(text) {
      if (!text) return;
      await sendAction("/view/type", { text });
      setTimeout(refresh, 150);
    }

    async function copyToLocalClipboard(text) {
      if (!text) return false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {}
      }
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {}
      ta.remove();
      img.focus();
      return ok;
    }

    async function copyRemoteSelection() {
      const res = await fetch("/view/selection");
      if (!res.ok) return "";
      const data = await res.json();
      const text = (data && data.text) || "";
      if (text) {
        await copyToLocalClipboard(text);
        statusEl.textContent = "Copied!";
      } else {
        statusEl.textContent = "Nothing selected";
      }
      return text;
    }

    function addCtxItem(label, onClick) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "menu-item";
      btn.textContent = label;
      btn.onclick = async () => {
        closeCtxMenu();
        await onClick();
      };
      ctxMenu.appendChild(btn);
    }

    img.addEventListener("contextmenu", async (e) => {
      if (!controlling) return;
      e.preventDefault();
      img.focus();
      const pt = toRemoteCoords(e);
      if (!pt) return;
      closeCtxMenu();
      let info = { selection: "", linkUrl: null, isEditable: false, elementText: "" };
      try {
        info = await sendAction("/view/context", pt);
        setTimeout(refresh, 150);
      } catch (err) {
        statusEl.textContent = "Error: " + (err.message || err);
      }
      if (info.selection) {
        addCtxItem("Copy", async () => {
          await copyToLocalClipboard(info.selection);
          statusEl.textContent = "Copied!";
        });
      } else if (info.elementText) {
        addCtxItem("Copy Text", async () => {
          await copyToLocalClipboard(info.elementText);
          statusEl.textContent = "Copied!";
        });
      }
      if (info.linkUrl) {
        addCtxItem("Copy Link Address", async () => {
          await copyToLocalClipboard(info.linkUrl);
          statusEl.textContent = "Link copied!";
        });
        addCtxItem("Open Link in New Tab", async () => {
          await sendAction("/view/tabs/new", { url: info.linkUrl });
          await refresh();
        });
      }
      if (info.isEditable && navigator.clipboard && navigator.clipboard.readText) {
        addCtxItem("Paste", async () => {
          try {
            const text = await navigator.clipboard.readText();
            await pasteRemoteText(text);
          } catch (err) {
            statusEl.textContent = "Clipboard error: " + (err.message || err);
          }
        });
      }
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      ctxMenu.appendChild(sep);
      addCtxItem("Back", async () => { await sendAction("/view/back", {}); await refresh(); });
      addCtxItem("Forward", async () => { await sendAction("/view/forward", {}); await refresh(); });
      addCtxItem("Reload", async () => { await sendAction("/view/reload", {}); await refresh(); });

      ctxMenu.classList.add("open");
      const mw = ctxMenu.offsetWidth || 190;
      const mh = ctxMenu.offsetHeight || 160;
      const left = Math.min(e.clientX, window.innerWidth - mw - 8);
      const top = Math.min(e.clientY, window.innerHeight - mh - 8);
      ctxMenu.style.left = Math.max(8, left) + "px";
      ctxMenu.style.top = Math.max(8, top) + "px";
    });

    img.addEventListener("keydown", async (e) => {
      if (!controlling) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "v") {
          if (navigator.clipboard && navigator.clipboard.readText) {
            e.preventDefault();
            try {
              const text = await navigator.clipboard.readText();
              await pasteRemoteText(text);
            } catch (err) {
              statusEl.textContent = "Clipboard error: " + (err.message || err);
            }
          }
          return;
        }
        if (k === "c") {
          e.preventDefault();
          try {
            await copyRemoteSelection();
            await sendAction("/view/key", { key: "Control+c" }).catch(() => {});
          } catch (err) {
            statusEl.textContent = "Copy error: " + (err.message || err);
          }
          return;
        }
        if (k === "x") {
          e.preventDefault();
          try {
            await copyRemoteSelection();
            await sendAction("/view/key", { key: "Control+x" });
            setTimeout(refresh, 150);
          } catch (err) {
            statusEl.textContent = "Cut error: " + (err.message || err);
          }
          return;
        }
        if (k === "a") {
          e.preventDefault();
          try {
            await sendAction("/view/key", { key: "Control+a" });
            setTimeout(refresh, 150);
          } catch (err) {
            statusEl.textContent = "Error: " + (err.message || err);
          }
          return;
        }
      }
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

    document.addEventListener("paste", async (e) => {
      if (!controlling || activeTab !== "browser") return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      const text = e.clipboardData && e.clipboardData.getData("text");
      if (!text) return;
      e.preventDefault();
      try {
        await pasteRemoteText(text);
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

    let touchLastY = null;
    let touchTap = null;
    img.addEventListener("touchstart", (e) => {
      if (!controlling || e.touches.length !== 1) return;
      const t = e.touches[0];
      touchLastY = t.clientY;
      touchTap = { pt: toRemoteCoords(t), moved: false };
    }, { passive: true });
    img.addEventListener("touchmove", (e) => {
      if (!controlling || touchLastY === null || e.touches.length !== 1) return;
      const dy = touchLastY - e.touches[0].clientY;
      touchLastY = e.touches[0].clientY;
      if (Math.abs(dy) < 4) return;
      if (touchTap) touchTap.moved = true;
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
    img.addEventListener("touchend", async () => {
      touchLastY = null;
      const tap = touchTap;
      touchTap = null;
      if (controlling && tap && !tap.moved && tap.pt) {
        await sendAction("/view/click", tap.pt).catch(() => {});
        setTimeout(refresh, 150);
      }
    });

    function getBmHost(u) {
      try { return new URL(u).hostname.replace(/^www\\./, ""); } catch { return u; }
    }

    function openBmEditor(item) {
      bmEditor.classList.add("open");
      if (item) {
        bmEditorTitle.textContent = "Edit Bookmark";
        bmEditId.value = item.id;
        bmEditTitle.value = item.title;
        bmEditUrl.value = item.url;
      } else {
        bmEditorTitle.textContent = "Add Bookmark";
        bmEditId.value = "";
        bmEditTitle.value = "";
        bmEditUrl.value = "";
      }
      bmEditTitle.focus();
    }

    function closeBmEditor() {
      bmEditor.classList.remove("open");
      bmEditId.value = "";
      bmEditTitle.value = "";
      bmEditUrl.value = "";
    }

    bmAddBtn.addEventListener("click", () => openBmEditor(null));
    bmCancelBtn.addEventListener("click", closeBmEditor);

    function renderPluginsOverlay() {
      bmPluginsGrid.innerHTML = "";
      if (!pluginLinksList || pluginLinksList.length === 0) {
        bmPluginsSection.style.display = "none";
        return;
      }
      bmPluginsSection.style.display = "block";
      for (const p of pluginLinksList) {
        const card = document.createElement("div");
        card.className = "bm-card";
        const ico = document.createElement("div");
        ico.className = "bm-ico";
        ico.textContent = p.icon || (p.title || "?").trim().charAt(0).toUpperCase();
        const info = document.createElement("div");
        info.className = "bm-info";
        info.style.paddingRight = "0";
        const t = document.createElement("div");
        t.className = "bm-title";
        t.textContent = p.title || p.name;
        const h = document.createElement("div");
        h.className = "bm-host";
        h.textContent = p.subtitle || p.url;
        info.append(t, h);
        card.append(ico, info);
        card.onclick = async () => {
          bookmarksOverlay.style.display = "none";
          urlInput.value = p.url;
          statusEl.textContent = "Navigating…";
          await sendAction("/view/navigate", { url: p.url });
          await refresh();
        };
        bmPluginsGrid.appendChild(card);
      }
    }

    function renderBookmarksOverlay() {
      bmGrid.innerHTML = "";
      if (!bookmarksList || bookmarksList.length === 0) {
        bmGrid.innerHTML = '<div class="preview-empty" style="grid-column:1/-1;padding:36px;">No bookmarks yet — click <strong>+ Add Bookmark</strong> above.</div>';
        return;
      }
      for (const b of bookmarksList) {
        const card = document.createElement("div");
        card.className = "bm-card";
        const host = getBmHost(b.url);
        const ico = document.createElement("div");
        ico.className = "bm-ico";
        ico.textContent = (b.title || host || "?").trim().charAt(0).toUpperCase();
        const info = document.createElement("div");
        info.className = "bm-info";
        const t = document.createElement("div");
        t.className = "bm-title";
        t.textContent = b.title || host;
        const h = document.createElement("div");
        h.className = "bm-host";
        h.textContent = host;
        info.append(t, h);

        const acts = document.createElement("div");
        acts.className = "bm-acts";
        const ed = document.createElement("button");
        ed.type = "button";
        ed.className = "bm-act";
        ed.title = "Edit";
        ed.textContent = "✎";
        ed.onclick = (ev) => {
          ev.stopPropagation();
          openBmEditor(b);
        };
        const del = document.createElement("button");
        del.type = "button";
        del.className = "bm-act del";
        del.title = "Delete";
        del.textContent = "×";
        del.onclick = async (ev) => {
          ev.stopPropagation();
          const res = await fetch("/bookmarks/api?id=" + encodeURIComponent(b.id), { method: "DELETE" });
          if (res.ok) {
            const data = await res.json();
            bookmarksList = data.bookmarks || [];
            renderBookmarksOverlay();
            sendAction("/view/navigate", { url: "boxy://home" }).catch(() => {});
          }
        };
        acts.append(ed, del);
        card.append(ico, info, acts);
        card.onclick = async () => {
          bookmarksOverlay.style.display = "none";
          urlInput.value = b.url;
          statusEl.textContent = "Navigating…";
          await sendAction("/view/navigate", { url: b.url });
          await refresh();
        };
        bmGrid.appendChild(card);
      }
    }

    const homeIpLabel = document.getElementById("homeIpLabel");
    const homeExitIp = document.getElementById("homeExitIp");
    const homeServerTzLabel = document.getElementById("homeServerTzLabel");
    const homeServerTime = document.getElementById("homeServerTime");
    const homeRemoteTzLabel = document.getElementById("homeRemoteTzLabel");
    const homeRemoteTime = document.getElementById("homeRemoteTime");
    let netStatusData = null;
    let netServerOffsetMs = 0;
    let lastNetworkStatusAt = 0;

    function formatTzDateTime(ms, timeZone) {
      try {
        return new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(new Date(ms));
      } catch {
        return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
      }
    }

    function updateHomeClocks() {
      if (bookmarksOverlay.style.display !== "block" || !netStatusData) return;
      const now = Date.now() + netServerOffsetMs;
      homeServerTime.textContent = formatTzDateTime(now, netStatusData.serverTimezone || "UTC");
      if (netStatusData.remoteTimezone) {
        homeRemoteTime.textContent = formatTzDateTime(now, netStatusData.remoteTimezone);
      } else {
        homeRemoteTime.textContent = "Direct (Same as server)";
      }
    }

    setInterval(updateHomeClocks, 1000);

    async function loadNetworkStatus(force = false) {
      lastNetworkStatusAt = Date.now();
      try {
        const res = await fetch("/bookmarks/status" + (force ? "?refresh=1" : ""));
        if (!res.ok) return;
        netStatusData = await res.json();
        netServerOffsetMs = (netStatusData.serverNowMs || Date.now()) - Date.now();
        const modeTag = netStatusData.activeCountry ? ("VPN: " + netStatusData.activeCountry) : "Direct";
        homeIpLabel.textContent = "Exit IP & Country (" + modeTag + ")";
        const parts = [netStatusData.ip, netStatusData.country, netStatusData.city].filter(Boolean);
        homeExitIp.textContent = parts.length ? parts.join(" · ") : "Unavailable";
        homeServerTzLabel.textContent = "Server Time (" + (netStatusData.serverTimezone || "UTC") + ")";
        homeRemoteTzLabel.textContent = netStatusData.activeCountry
          ? ("Remote Time (" + (netStatusData.remoteTimezone || netStatusData.activeCountry) + ")")
          : "Remote Country Time";
        updateHomeClocks();
      } catch {}
    }

    async function loadBookmarks() {
      try {
        const res = await fetch("/bookmarks/api");
        if (res.ok) {
          const data = await res.json();
          bookmarksList = data.bookmarks || [];
          pluginLinksList = data.plugins || [];
          bookmarksLoaded = true;
          renderPluginsOverlay();
          renderBookmarksOverlay();
        }
      } catch {}
    }

    bmSaveBtn.addEventListener("click", async () => {
      const u = bmEditUrl.value.trim();
      if (!u) return;
      const res = await fetch("/bookmarks/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: bmEditId.value || undefined,
          title: bmEditTitle.value.trim(),
          url: u,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        bookmarksList = data.bookmarks || [];
        closeBmEditor();
        renderBookmarksOverlay();
        sendAction("/view/navigate", { url: "boxy://home" }).catch(() => {});
      }
    });

    homeBtn.addEventListener("click", async () => {
      urlInput.value = "boxy://home";
      statusEl.textContent = "Opening Home…";
      await loadBookmarks();
      bookmarksOverlay.style.display = "block";
      await sendAction("/view/navigate", { url: "boxy://home" });
      await refresh();
    });

    async function submitNavigation() {
      let target = urlInput.value.trim();
      if (!target) return;
      const isHomeTarget =
        target === "boxy://home" || target === "home" || target === "boxy://bookmarks" || target === "bookmarks";
      if (!isHomeTarget && !/^(https?|chrome-extension):\\/\\//i.test(target)) {
        target = "https://" + target;
      }
      urlInput.blur();
      if (isHomeTarget) {
        await loadBookmarks();
        bookmarksOverlay.style.display = "block";
      } else {
        bookmarksOverlay.style.display = "none";
      }
      statusEl.textContent = "Navigating…";
      await sendAction("/view/navigate", { url: target });
      await refresh();
    }

    navForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await submitNavigation();
    });

    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void submitNavigation();
      }
    });

    const fileChooserModal = document.getElementById("fileChooserModal");
    const fcFileInput = document.getElementById("fcFileInput");
    const fcCancelBtn = document.getElementById("fcCancelBtn");
    const fcCloseBtn = document.getElementById("fcCloseBtn");
    let lastHandledFcId = 0;

    function openFileChooserModal(fc) {
      lastHandledFcId = fc.id;
      fcFileInput.multiple = Boolean(fc.multiple);
      fcFileInput.value = "";
      fileChooserModal.style.display = "grid";
    }

    async function cancelFileChooser() {
      fileChooserModal.style.display = "none";
      await fetch("/view/filechooser/cancel", { method: "POST" }).catch(() => {});
    }

    fcCancelBtn.addEventListener("click", cancelFileChooser);
    fcCloseBtn.addEventListener("click", cancelFileChooser);

    fcFileInput.addEventListener("change", async () => {
      if (!fcFileInput.files || fcFileInput.files.length === 0) return;
      const fd = new FormData();
      for (const f of fcFileInput.files) fd.append("file", f);
      statusEl.textContent = "Uploading to browser…";
      fileChooserModal.style.display = "none";
      try {
        const res = await fetch("/view/filechooser", { method: "POST", body: fd });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || ("HTTP " + res.status));
        }
        setTimeout(refresh, 200);
      } catch (err) {
        statusEl.textContent = "Upload failed: " + (err.message || err);
      } finally {
        fcFileInput.value = "";
      }
    });

    savePageBtn.addEventListener("click", async () => {
      savePageBtn.disabled = true;
      showSaveNotice("Downloading webpage…", "Saving current page and images to Files…", null, false);
      try {
        const saved = await sendAction("/view/save-page", {});
        showSaveNotice(
          "Download complete!",
          "Saved to Files → " + saved.path,
          saved.path,
          false
        );
      } catch (err) {
        showSaveNotice("Download failed", err.message || String(err), null, true);
      } finally {
        savePageBtn.disabled = false;
      }
    });

    let saveNoticeTimer = null;
    function showSaveNotice(title, message, savedPath, isError) {
      let box = document.getElementById("saveNoticeBox");
      if (!box) {
        box = document.createElement("div");
        box.id = "saveNoticeBox";
        box.style.cssText =
          "position:fixed;top:60px;right:16px;z-index:99998;width:min(380px,calc(100vw - 32px));background:var(--card);color:var(--card-foreground);border:1px solid var(--border);border-radius:12px;padding:14px 16px;box-shadow:0 14px 36px rgba(0,0,0,.22);font-size:13px;line-height:1.45;";
        document.body.appendChild(box);
      }
      if (saveNoticeTimer) {
        clearTimeout(saveNoticeTimer);
        saveNoticeTimer = null;
      }
      box.style.borderColor = isError ? "var(--destructive)" : "#16a34a";
      box.innerHTML = "";

      const head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;";
      const strong = document.createElement("strong");
      strong.style.fontSize = "13.5px";
      strong.textContent = (isError ? "⚠️ " : savedPath ? "✅ " : "⏳ ") + title;
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "sec";
      closeBtn.style.cssText = "padding:2px 7px;font-size:12px;";
      closeBtn.textContent = "×";
      closeBtn.onclick = () => { box.style.display = "none"; };
      head.append(strong, closeBtn);

      const msg = document.createElement("div");
      msg.style.cssText = "color:var(--muted-foreground);font-size:12.5px;word-break:break-all;";
      msg.textContent = message;
      box.append(head, msg);

      if (savedPath) {
        const actions = document.createElement("div");
        actions.style.cssText = "margin-top:10px;display:flex;justify-content:flex-end;gap:6px;";
        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.style.cssText = "padding:5px 11px;font-size:12px;";
        openBtn.textContent = "Open in Files";
        openBtn.onclick = async () => {
          box.style.display = "none";
          const dir = savedPath.includes("/") ? savedPath.slice(0, savedPath.lastIndexOf("/")) : ".";
          currentDir = dir;
          setTab("files");
          await loadFiles(dir);
          await previewFile(savedPath);
        };
        actions.appendChild(openBtn);
        box.appendChild(actions);
      }

      box.style.display = "block";
      if (savedPath || isError) {
        saveNoticeTimer = setTimeout(() => {
          box.style.display = "none";
        }, 10000);
      }
    }

    backBtn.addEventListener("click", async () => {
      statusEl.textContent = "Back…";
      try {
        await sendAction("/view/back", {});
        await refresh();
      } catch (err) {
        statusEl.textContent = "Back failed: " + (err.message || err);
      }
    });

    forwardBtn.addEventListener("click", async () => {
      statusEl.textContent = "Forward…";
      try {
        await sendAction("/view/forward", {});
        await refresh();
      } catch (err) {
        statusEl.textContent = "Forward failed: " + (err.message || err);
      }
    });

    refreshBtn.addEventListener("click", async () => {
      statusEl.textContent = "Reloading…";
      try {
        await sendAction("/view/reload", {});
        await refresh();
      } catch (err) {
        statusEl.textContent = "Reload failed: " + (err.message || err);
      }
    });
    setTab(${JSON.stringify(initialTab)});
    syncControl().then(() => { if (activeTab === "browser") refresh(); });
    setInterval(() => {
      syncControl();
      refresh();
      if (activeTab === "files" || activeTab === "terminal") statusEl.textContent = new Date().toLocaleTimeString();
    }, 1500);
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
      const updated = res.contents.replace(old_text, () => new_text);
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

  server.registerTool(
    "share",
    {
      description:
        "Create a public share link (https://<boxy>/s/xXx) for a workspace file or a web URL, with an optional password and expiration (1d, 1w, 1m, forever; default 1w). If target is an http(s) URL, Boxy saves the URL (or web article with images) into the workspace first and then shares it.",
      inputSchema: {
        target: z
          .string()
          .min(1)
          .describe("Workspace file path (e.g. 'articles/post.html' or 'downloads/metube/song.mp3') OR an http(s):// URL to save and share"),
        password: z
          .string()
          .optional()
          .describe("Optional password required to open the shared link"),
        expires_in: z
          .enum(["1d", "1w", "1m", "forever"])
          .optional()
          .describe("Share expiration length: '1d' (1 day), '1w' (1 week, default), '1m' (1 month), or 'forever'"),
      },
    },
    async ({ target, password, expires_in }) => {
      const base = PUBLIC_URL || `http://127.0.0.1:${PORT}`;
      let relPath = target.trim();
      if (/^https?:\/\//i.test(relPath)) {
        relPath = await saveUrlToWorkspaceForShare(sandbox, userId, relPath);
      }
      const fileInfo = await sandbox.resolveFileForRead(userId, relPath);
      const info = shares.createOrUpdate({
        userId,
        path: fileInfo.path,
        expiresIn: expires_in || "1w",
        password: password || null,
        publicOrigin: base,
      });
      return textResult({
        shareUrl: info.url,
        path: info.path,
        expiresAt: info.expiresAt ? new Date(info.expiresAt).toISOString() : null,
        hasPassword: info.hasPassword,
        filesUrl: `${base}/view/files`,
      });
    },
  );

  registerPluginTools(loadedPlugins, {
    server,
    userId,
    sandbox,
    publicUrl: PUBLIC_URL || `http://127.0.0.1:${PORT}`,
    textResult,
  });

  return server;
}

const MAX_TERM_SCROLLBACK_BYTES = 64 * 1024;

type TerminalClient = {
  sendBinary: (data: Uint8Array) => unknown;
  send: (data: string) => unknown;
};

type TerminalSession = {
  id: string;
  title: string;
  proc: ReturnType<typeof Bun.spawn>;
  scrollback: Uint8Array[];
  scrollbackBytes: number;
  clients: Set<TerminalClient>;
};

type UserTerminalState = {
  seq: number;
  activeId: string;
  tabs: TerminalSession[];
};

const userTerminals = new Map<string, UserTerminalState>();

function createTerminalTab(
  userId: string,
  opts?: { title?: string; initialInput?: string },
): TerminalSession {
  let state = userTerminals.get(userId);
  if (!state) {
    state = { seq: 0, activeId: "", tabs: [] };
    userTerminals.set(userId, state);
  }
  state.seq += 1;
  const id = `t_${state.seq}_${Date.now().toString(36)}`;
  let title = (opts?.title || "").trim();
  if (!title) {
    const usedNums = new Set<number>();
    for (const t of state.tabs) {
      const m = /^Terminal (\d+)$/.exec(t.title);
      if (m) usedNums.add(Number(m[1]));
    }
    let n = 1;
    while (usedNums.has(n)) n += 1;
    title = `Terminal ${n}`;
  }
  const { workspaceDir, homeDir } = sandbox.getPathsSync(userId);

  const session: TerminalSession = {
    id,
    title,
    proc: null as unknown as ReturnType<typeof Bun.spawn>,
    scrollback: [],
    scrollbackBytes: 0,
    clients: new Set(),
  };

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
        const chunk = new Uint8Array(data);
        session.scrollback.push(chunk);
        session.scrollbackBytes += chunk.byteLength;
        while (session.scrollbackBytes > MAX_TERM_SCROLLBACK_BYTES && session.scrollback.length > 1) {
          const removed = session.scrollback.shift()!;
          session.scrollbackBytes -= removed.byteLength;
        }
        for (const c of session.clients) {
          try {
            c.sendBinary(chunk);
          } catch {}
        }
      },
      exit() {
        const st = userTerminals.get(userId);
        if (!st) return;
        st.tabs = st.tabs.filter((t) => t.id !== session.id);
        if (st.tabs.length === 0) {
          createTerminalTab(userId);
        } else if (st.activeId === session.id) {
          st.activeId = st.tabs[st.tabs.length - 1]!.id;
        }
        const payload = JSON.stringify({ type: "tabs", ...serializeTerminalTabs(userId) });
        for (const c of session.clients) {
          try {
            c.send(payload);
          } catch {}
        }
        for (const t of st.tabs) {
          for (const c of t.clients) {
            try {
              c.send(payload);
            } catch {}
          }
        }
      },
    },
  });

  session.proc = proc;
  state.tabs.push(session);
  state.activeId = session.id;

  if (opts?.initialInput) {
    const input = opts.initialInput;
    setTimeout(() => {
      try {
        proc.terminal?.write(input);
      } catch {}
    }, 120);
  }

  return session;
}

function getOrCreateUserTerminals(userId: string): UserTerminalState {
  let state = userTerminals.get(userId);
  if (!state) {
    state = { seq: 0, activeId: "", tabs: [] };
    userTerminals.set(userId, state);
  }
  if (state.tabs.length === 0) {
    createTerminalTab(userId);
  }
  if (!state.tabs.some((t) => t.id === state.activeId)) {
    state.activeId = state.tabs[state.tabs.length - 1]!.id;
  }
  return state;
}

function serializeTerminalTabs(userId: string): {
  activeId: string;
  tabs: Array<{ id: string; title: string; active: boolean }>;
} {
  const state = getOrCreateUserTerminals(userId);
  return {
    activeId: state.activeId,
    tabs: state.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      active: t.id === state.activeId,
    })),
  };
}

type TerminalSocketData = {
  userId: string;
  tabId?: string;
  session?: TerminalSession;
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

    if (req.method === "GET" && (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico")) {
      return new Response(OPENBOXY_FAVICON_SVG, {
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        },
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

    if (url.pathname.startsWith("/s/")) {
      const rest = url.pathname.slice(3);
      const slashIdx = rest.indexOf("/");
      const shareId = decodeURIComponent(slashIdx === -1 ? rest : rest.slice(0, slashIdx));
      const subPath = slashIdx === -1 ? "" : rest.slice(slashIdx);
      const rec = shareId ? shares.getShare(shareId) : null;
      if (!rec) {
        return renderShareNotFoundPage(OPENBOXY_THEME_HEAD);
      }
      let fileInfo: { path: string; fullPath: string; size: number };
      try {
        fileInfo = await sandbox.resolveFileForRead(rec.userId, rec.path);
      } catch {
        return renderShareNotFoundPage(OPENBOXY_THEME_HEAD);
      }
      const filename = fileInfo.path.split("/").pop() || "file";
      const cookieName = `obx_sh_${rec.id}`;
      const unlocked = shares.verifyUnlockCookie(rec, readCookie(req, cookieName));

      if (req.method === "POST" && subPath === "") {
        const form = await req.formData().catch(() => null);
        const pw = String(form?.get("password") || "");
        if (!shares.verifyPassword(rec, pw)) {
          return renderSharePasswordPage(OPENBOXY_THEME_HEAD, rec.id, filename, "Incorrect password.");
        }
        const isSecure = publicOrigin(req).startsWith("https://");
        const sig = encodeURIComponent(shares.signUnlockCookie(rec));
        return new Response(null, {
          status: 303,
          headers: {
            Location: `/s/${encodeURIComponent(rec.id)}`,
            "Set-Cookie": `${cookieName}=${sig}; Path=/s/${encodeURIComponent(rec.id)}; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}${isSecure ? "; Secure" : ""}`,
          },
        });
      }

      if (!unlocked) {
        if (subPath === "/raw" || subPath === "/tts") return new Response("Unauthorized", { status: 401 });
        return renderSharePasswordPage(OPENBOXY_THEME_HEAD, rec.id, filename);
      }

      if (req.method === "GET" && subPath === "/tts") {
        try {
          const ext = (filename.split(".").pop() || "").toLowerCase();
          const voice = url.searchParams.get("voice") || "auto";
          const dataDir = path.resolve(process.env.DATA_DIR || "/data");
          const mp3Path = await getOrSynthesizeArticleAudio({
            dataDir,
            userId: rec.userId,
            fullPath: fileInfo.fullPath,
            ext,
            voice,
          });
          return serveAudioFileWithRange(req, mp3Path);
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
        }
      }

      if (req.method === "GET" && subPath === "") {
        shares.recordView(rec.id);
        return renderShareViewerPage({
          themeHead: OPENBOXY_THEME_HEAD,
          rec,
          filename,
          size: fileInfo.size,
        });
      }

      if (req.method === "GET" && subPath === "/raw") {
        const download = url.searchParams.get("download") === "1";
        const ext = (filename.split(".").pop() || "").toLowerCase();
        const mimeMap: Record<string, string> = {
          mp3: "audio/mpeg",
          m4a: "audio/mp4",
          aac: "audio/aac",
          wav: "audio/wav",
          ogg: "audio/ogg",
          opus: "audio/opus",
          flac: "audio/flac",
          mp4: "video/mp4",
          webm: "video/webm",
          mov: "video/quicktime",
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
          htm: "text/plain; charset=utf-8",
        };
        const contentType = mimeMap[ext] || "application/octet-stream";
        const total = fileInfo.size;
        const fileHandle = Bun.file(fileInfo.fullPath);
        const rangeHeader = req.headers.get("range");
        if (rangeHeader && !download) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
          if (m && (m[1] || m[2])) {
            const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
            const end = m[1] && m[2] ? Math.min(total - 1, Number(m[2])) : total - 1;
            if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && end < total) {
              return new Response(fileHandle.slice(start, end + 1), {
                status: 206,
                headers: {
                  "Content-Type": contentType,
                  "Content-Length": String(end - start + 1),
                  "Content-Range": `bytes ${start}-${end}/${total}`,
                  "Accept-Ranges": "bytes",
                  "Content-Disposition": contentDisposition("inline", filename),
                  "Content-Security-Policy": "sandbox",
                },
              });
            }
            return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
          }
        }
        return new Response(fileHandle, {
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(total),
            "Accept-Ranges": "bytes",
            "Content-Disposition": contentDisposition(download ? "attachment" : "inline", filename),
            "Content-Security-Policy": "sandbox",
          },
        });
      }

      return renderShareNotFoundPage(OPENBOXY_THEME_HEAD);
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
      if (registeredClients.size >= 1000) {
        const oldest = registeredClients.keys().next().value;
        if (oldest) registeredClients.delete(oldest);
      }
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
      const now = Date.now();
      for (const [k, v] of authCodes.entries()) {
        if (v.expiresAt < now) authCodes.delete(k);
      }
      const code = randomBytes(24).toString("base64url");
      authCodes.set(code, {
        clientId,
        userId,
        redirectUri,
        codeChallenge,
        expiresAt: now + 5 * 60_000,
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
      const isLocalLoopback =
        (url.hostname === "127.0.0.1" || url.hostname === "localhost") && !req.headers.get("x-forwarded-for");
      const userId =
        authorized(req) || (isLocalLoopback ? sanitizeUserId(url.searchParams.get("user") || DEFAULT_USER_ID) : null);
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

    if (url.pathname === "/bookmarks" || url.pathname === "/bookmarks/api" || url.pathname === "/bookmarks/status") {
      const isLocalLoopback =
        (url.hostname === "127.0.0.1" || url.hostname === "localhost") && !req.headers.get("x-forwarded-for");
      const bmUserId = uiAuthorized(req) || (isLocalLoopback ? sanitizeUserId(url.searchParams.get("user") || DEFAULT_USER_ID) : null);
      if (!bmUserId) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (req.method === "GET" && url.pathname === "/bookmarks") {
        return renderBookmarksPage(bmUserId, getPluginHomeLinks(loadedPlugins, bmUserId));
      }
      if (req.method === "GET" && url.pathname === "/bookmarks/api") {
        return Response.json({
          bookmarks: listBookmarks(bmUserId),
          plugins: getPluginHomeLinks(loadedPlugins, bmUserId),
        });
      }
      if (req.method === "GET" && url.pathname === "/bookmarks/status") {
        const force = url.searchParams.get("refresh") === "1";
        return Response.json(await getHomeNetworkStatus(loadedPlugins, force));
      }
      if (req.method === "POST" && url.pathname === "/bookmarks/api") {
        try {
          const body = (await req.json().catch(() => ({}))) as { id?: string; title?: string; url?: string };
          if (!body.url) return Response.json({ error: "url is required" }, { status: 400 });
          const bookmarks = upsertBookmark(bmUserId, { id: body.id, title: body.title, url: body.url });
          return Response.json({ bookmarks });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
        }
      }
      if (req.method === "DELETE" && url.pathname === "/bookmarks/api") {
        const id = (url.searchParams.get("id") || "").trim();
        if (!id) return Response.json({ error: "id is required" }, { status: 400 });
        const bookmarks = deleteBookmark(bmUserId, id);
        return Response.json({ bookmarks });
      }
    }

    if (url.pathname.startsWith("/p/")) {
      const rest = url.pathname.slice(3);
      const slash = rest.indexOf("/");
      const pluginName = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
      const isLocalLoopback =
        (url.hostname === "127.0.0.1" || url.hostname === "localhost") && !req.headers.get("x-forwarded-for");
      const pUserId = uiAuthorized(req) || (isLocalLoopback ? DEFAULT_USER_ID : null);
      if (!pUserId) {
        if (req.method === "GET" && (req.headers.get("accept") || "").includes("text/html")) {
          return new Response(null, {
            status: 302,
            headers: { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` },
          });
        }
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const res = await handlePluginHttp(loadedPlugins, {
        pluginName,
        req,
        url,
        userId: pUserId,
        publicOrigin: publicOrigin(req),
        sandbox,
      });
      if (res) return res;
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
      const reqTabId = (url.searchParams.get("id") || "").trim() || undefined;
      const upgraded = srv.upgrade(req, { data: { userId: uiUserId, tabId: reqTabId } });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    if (req.method === "GET" && url.pathname === "/view/terminal/tabs") {
      return Response.json(serializeTerminalTabs(uiUserId));
    }

    if (req.method === "POST" && url.pathname === "/view/terminal/tabs/new") {
      const body = (await req.json().catch(() => ({}))) as { title?: string; initialInput?: string };
      createTerminalTab(uiUserId, { title: body.title, initialInput: body.initialInput });
      return Response.json(serializeTerminalTabs(uiUserId));
    }

    if (req.method === "POST" && url.pathname === "/view/terminal/tabs/select") {
      const body = (await req.json().catch(() => ({}))) as { id?: string };
      const state = getOrCreateUserTerminals(uiUserId);
      if (body.id && state.tabs.some((t) => t.id === body.id)) {
        state.activeId = body.id;
      }
      return Response.json(serializeTerminalTabs(uiUserId));
    }

    if (req.method === "POST" && url.pathname === "/view/terminal/tabs/close") {
      const body = (await req.json().catch(() => ({}))) as { id?: string };
      const state = getOrCreateUserTerminals(uiUserId);
      const target = state.tabs.find((t) => t.id === body.id);
      if (target) {
        state.tabs = state.tabs.filter((t) => t.id !== target.id);
        try {
          target.proc.kill();
        } catch {}
      }
      if (state.tabs.length === 0) {
        createTerminalTab(uiUserId);
      } else if (!state.tabs.some((t) => t.id === state.activeId)) {
        state.activeId = state.tabs[state.tabs.length - 1]!.id;
      }
      return Response.json(serializeTerminalTabs(uiUserId));
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
        const listing = await sandbox.listDir(uiUserId, dirPath);
        const origin = publicOrigin(req);
        const userShares = shares.listForUser(uiUserId, origin);
        const entries = listing.entries.map((entry) => {
          const rel = listing.path === "." ? entry.name : `${listing.path}/${entry.name}`;
          return {
            ...entry,
            share: entry.type === "file" ? userShares.get(rel) || null : null,
          };
        });
        return Response.json({ path: listing.path, entries });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/files/tts") {
      try {
        const target = url.searchParams.get("path") || "";
        const voice = url.searchParams.get("voice") || "auto";
        const fileInfo = await sandbox.resolveFileForRead(uiUserId, target);
        const ext = (fileInfo.path.split(".").pop() || "").toLowerCase();
        const dataDir = path.resolve(process.env.DATA_DIR || "/data");
        const mp3Path = await getOrSynthesizeArticleAudio({
          dataDir,
          userId: uiUserId,
          fullPath: fileInfo.fullPath,
          ext,
          voice,
        });
        return serveAudioFileWithRange(req, mp3Path);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }

    if (req.method === "DELETE" && url.pathname === "/api/files") {
      try {
        const target = url.searchParams.get("path") || "";
        const deleted = await sandbox.deletePath(uiUserId, target);
        shares.removeByPath(uiUserId, deleted.deleted);
        return Response.json(deleted);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/shares") {
      try {
        const body = (await req.json().catch(() => ({}))) as {
          path?: string;
          expiresIn?: ShareExpiryOption;
          password?: string | null;
          keepExistingPassword?: boolean;
        };
        const targetPath = (body.path || "").trim();
        if (!targetPath) return Response.json({ error: "path is required" }, { status: 400 });
        const fileInfo = await sandbox.resolveFileForRead(uiUserId, targetPath);
        const exp: ShareExpiryOption =
          body.expiresIn && ["1d", "1w", "1m", "forever"].includes(body.expiresIn) ? body.expiresIn : "1w";
        const share = shares.createOrUpdate({
          userId: uiUserId,
          path: fileInfo.path,
          expiresIn: exp,
          password: body.password ?? null,
          keepExistingPassword: body.keepExistingPassword === true,
          publicOrigin: publicOrigin(req),
        });
        return Response.json({ share });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }

    if (req.method === "DELETE" && url.pathname === "/api/shares") {
      try {
        const target = (url.searchParams.get("path") || "").trim();
        if (!target) return Response.json({ error: "path is required" }, { status: 400 });
        const removed = shares.removeByPath(uiUserId, target);
        return Response.json({ removed });
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
        const { path: relPath, fullPath, size: total } = await sandbox.resolveFileForRead(uiUserId, filePath);
        const ext = (relPath.split(".").pop() || "").toLowerCase();
        const mimeMap: Record<string, string> = {
          mp3: "audio/mpeg",
          m4a: "audio/mp4",
          aac: "audio/aac",
          wav: "audio/wav",
          ogg: "audio/ogg",
          opus: "audio/opus",
          flac: "audio/flac",
          mp4: "video/mp4",
          webm: "video/webm",
          mov: "video/quicktime",
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
        const fileHandle = Bun.file(fullPath);
        const rangeHeader = req.headers.get("range");
        if (rangeHeader && !download) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
          if (m && (m[1] || m[2])) {
            const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
            const end = m[1] && m[2] ? Math.min(total - 1, Number(m[2])) : total - 1;
            if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && end < total) {
              const slice = fileHandle.slice(start, end + 1);
              return new Response(slice, {
                status: 206,
                headers: {
                  "Content-Type": contentType,
                  "Content-Length": String(end - start + 1),
                  "Content-Range": `bytes ${start}-${end}/${total}`,
                  "Accept-Ranges": "bytes",
                  "Content-Disposition": contentDisposition("inline", filename),
                  "Content-Security-Policy": "sandbox",
                },
              });
            }
            return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
          }
        }
        return new Response(fileHandle, {
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(total),
            "Accept-Ranges": "bytes",
            "Content-Disposition": contentDisposition(download ? "attachment" : "inline", filename),
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

    if (req.method === "GET" && url.pathname === "/view/tabs") {
      try {
        return Response.json(await sandbox.listTabs(uiUserId));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/tabs/new") {
      const body = (await req.json().catch(() => ({}))) as { url?: string };
      try {
        return Response.json(await sandbox.newTab(uiUserId, body.url));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/tabs/select") {
      const body = (await req.json().catch(() => ({}))) as { index?: number };
      if (typeof body.index !== "number") return Response.json({ error: "index is required" }, { status: 400 });
      try {
        return Response.json(await sandbox.selectTab(uiUserId, body.index));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/tabs/close") {
      const body = (await req.json().catch(() => ({}))) as { index?: number };
      if (typeof body.index !== "number") return Response.json({ error: "index is required" }, { status: 400 });
      try {
        return Response.json(await sandbox.closeTab(uiUserId, body.index));
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
        return Response.json(await sandbox.navigate(uiUserId, body.url, true));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/back") {
      try {
        return Response.json(await sandbox.goBack(uiUserId, true));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/forward") {
      try {
        return Response.json(await sandbox.goForward(uiUserId, true));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/reload") {
      try {
        return Response.json(await sandbox.reload(uiUserId, true));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/save-page") {
      try {
        return Response.json(await sandbox.saveCurrentPage(uiUserId));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/filechooser") {
      try {
        const form = await req.formData();
        const files: Array<{ name: string; mimeType: string; buffer: Buffer }> = [];
        for (const val of form.getAll("file")) {
          if (val instanceof File) {
            files.push({
              name: val.name || "upload.bin",
              mimeType: val.type || "application/octet-stream",
              buffer: Buffer.from(await val.arrayBuffer()),
            });
          }
        }
        if (files.length === 0) {
          return Response.json({ error: "No file provided" }, { status: 400 });
        }
        return Response.json(await sandbox.fulfillFileChooser(uiUserId, files));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/filechooser/cancel") {
      return Response.json(await sandbox.cancelFileChooser(uiUserId));
    }

    if (req.method === "POST" && url.pathname === "/view/click") {
      const body = (await req.json().catch(() => ({}))) as {
        x?: number;
        y?: number;
        button?: "left" | "right" | "middle";
      };
      if (typeof body.x !== "number" || typeof body.y !== "number") {
        return Response.json({ error: "x and y are required" }, { status: 400 });
      }
      const btn = body.button === "right" || body.button === "middle" ? body.button : "left";
      try {
        return Response.json(await sandbox.clickAt(uiUserId, body.x, body.y, btn));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/context") {
      const body = (await req.json().catch(() => ({}))) as { x?: number; y?: number };
      if (typeof body.x !== "number" || typeof body.y !== "number") {
        return Response.json({ error: "x and y are required" }, { status: 400 });
      }
      try {
        await sandbox.clickAt(uiUserId, body.x, body.y, "right").catch(() => {});
        return Response.json(await sandbox.inspectContextAt(uiUserId, body.x, body.y));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "GET" && url.pathname === "/view/selection") {
      try {
        return Response.json(await sandbox.getSelectionText(uiUserId));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/view/drag") {
      const body = (await req.json().catch(() => ({}))) as {
        fromX?: number;
        fromY?: number;
        toX?: number;
        toY?: number;
      };
      if (
        typeof body.fromX !== "number" ||
        typeof body.fromY !== "number" ||
        typeof body.toX !== "number" ||
        typeof body.toY !== "number"
      ) {
        return Response.json({ error: "fromX, fromY, toX, and toY are required" }, { status: 400 });
      }
      try {
        return Response.json(await sandbox.dragAt(uiUserId, body.fromX, body.fromY, body.toX, body.toY));
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
        return Response.json(await sandbox.pressKey(uiUserId, body.key, undefined, undefined, true));
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
        return Response.json(await sandbox.scroll(uiUserId, body.deltaY ?? 0, body.y, true));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const { userId, tabId } = ws.data;
      try {
        const state = getOrCreateUserTerminals(userId);
        const session =
          (tabId ? state.tabs.find((t) => t.id === tabId) : undefined) ||
          state.tabs.find((t) => t.id === state.activeId) ||
          state.tabs[0]!;
        state.activeId = session.id;
        ws.data.session = session;
        session.clients.add(ws);
        for (const chunk of session.scrollback) {
          try {
            ws.sendBinary(chunk);
          } catch {}
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", error: err instanceof Error ? err.message : String(err) }));
        ws.close();
      }
    },
    message(ws, message) {
      const proc = ws.data.session?.proc;
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
      ws.data.session?.clients.delete(ws);
    },
  },
});

console.log(`[openboxy-mcp] Listening on :${server.port} (single-container, users=${userTokens.size})`);
