import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.MCP_PORT || 3100);
const COMPUTER_URL = (process.env.COMPUTER_URL || "http://openboxy:4100").replace(/\/+$/, "");
const COMPUTER_TOKEN = (process.env.COMPUTER_TOKEN || "").trim();
const MCP_TOKEN = (process.env.OPENBOXY_MCP_TOKEN || "").trim();
const DEFAULT_BOT_ID = (process.env.OPENBOXY_BOT_ID || "default").trim();
const PUBLIC_URL = (process.env.OPENBOXY_PUBLIC_URL || "").replace(/\/+$/, "");

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
    name: "openboxy",
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
        url: PUBLIC_URL || "OpenBot UI is running on port 3001",
        note: "Open this URL to view or interactively take over the browser session.",
      });
    },
  );

  return server;
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", service: "openboxy-mcp" });
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

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`[openboxy-mcp] Listening on http://0.0.0.0:${server.port}/mcp (upstream ${COMPUTER_URL})`);
