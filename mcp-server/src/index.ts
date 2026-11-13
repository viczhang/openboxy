import { timingSafeEqual } from "node:crypto";
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

function authorized(req: Request): boolean {
  const auth = req.headers.get("authorization")?.trim() || "";
  const offered = auth.replace(/^Bearer\s+/i, "").trim();
  if (!offered) return false;
  const a = Buffer.from(offered);
  const b = Buffer.from(MCP_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
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

    if (url.pathname === "/mcp") {
      if (!authorized(req)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcp = buildMcpServer();
      await mcp.connect(transport);
      try {
        return await transport.handleRequest(req);
      } finally {
        await mcp.close().catch(() => {});
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`[openboxy-mcp] Listening on http://0.0.0.0:${server.port}/mcp (upstream ${COMPUTER_URL})`);
