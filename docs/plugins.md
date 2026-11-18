# Writing OpenBoxy Plugins

OpenBoxy loads `.ts`, `.js`, and `.mjs` plugins automatically at startup from:

1. Built-in plugins: `mcp-server/plugins/` (inside the container: `/app/plugins`)
2. Custom plugins: `/data/plugins` (or `OPENBOXY_PLUGINS_DIR`)

If a custom plugin in `/data/plugins` has the same `name` as a built-in plugin, the custom plugin overrides it. Files starting with `_` or `.`, `.d.ts` files, and `*.test.*` files are ignored.

After adding or editing a plugin, restart the container so OpenBoxy reloads it:

```bash
docker restart openboxy-mcp
```

---

## Plugin Interface

Every plugin exports an `OpenBoxyPlugin` object as `default` (or named `plugin`):

```ts
import type { OpenBoxyPlugin } from "/app/src/plugins.ts";

const plugin: OpenBoxyPlugin = {
  name: "my-plugin",
  // Optional: restrict to specific OpenBoxy user IDs
  // allowedUsers: ["default"],
  // Optional: show a card in the "Plugins" section on the browser home page
  homeLink: {
    title: "My Plugin",
    subtitle: "Short description",
    url: "http://127.0.0.1:3100/p/my-plugin",
    icon: "🔌",
  },
  // Optional: route Chromium traffic through a proxy (first matching plugin wins)
  // proxyUrl: "socks5://127.0.0.1:10808",
  // Optional: load an unpacked Chrome extension directory into Chromium
  // chromeExtensionDir: "/data/extensions/my-ext",
  // Optional: serve custom UI / API routes under /p/<name>/*
  async httpHandler({ req, url, userId, sandbox }) {
    const sub = url.pathname.slice("/p/my-plugin".length);
    if (req.method === "GET" && (sub === "" || sub === "/")) {
      return new Response("<h1>Hello from My Plugin</h1>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return null;
  },
  // Optional: register custom MCP tools for AI agents
  register(ctx) {
    ctx.registerTool(
      "my_tool",
      {
        description: "Describe what this tool does.",
        inputSchema: { query: ctx.z.string() },
      },
      async ({ query }) => {
        return ctx.textResult({ ok: true, query });
      },
    );
  },
};

export default plugin;
```

---

## Capabilities Reference

### 1. `homeLink` (Browser Home Page Card)

Adds a card to the **Plugins** section on the browser home page (`boxy://home` / `/bookmarks`):

- `title`: Card heading (defaults to `plugin.name`)
- `subtitle` *(optional)*: Short secondary text
- `url`: URL opened in Boxy's browser when clicked (use `http://127.0.0.1:3100/p/<name>` for plugin-hosted pages)
- `icon` *(optional)*: Emoji or short text icon

### 2. `httpHandler` (Custom Web UI & API Routes)

Handles HTTP requests under `/p/<plugin.name>` and `/p/<plugin.name>/*`:

- Receives `{ req, url, userId, publicOrigin, sandbox }`.
- Return a `Response` if handled, or `null` to fall through to `404`.
- Access to `/p/*` is gated by OpenBoxy's UI auth (or local loopback `127.0.0.1` / `localhost` for requests originating from Boxy's own Chromium browser).

### 3. `register(ctx)` (Custom MCP Tools)

Registers tools on the MCP server for each allowed user:

- `ctx.userId`: Current OpenBoxy user ID
- `ctx.sandbox`: `SandboxManager` instance (e.g. `ctx.sandbox.withPage(ctx.userId, async (page) => ...)` to interact with the user's live Chromium page)
- `ctx.publicUrl`: Public base URL of the OpenBoxy server
- `ctx.z`: Zod instance for `inputSchema`
- `ctx.registerTool(name, config, handler)`: Standard `@modelcontextprotocol/sdk` tool registration
- `ctx.textResult(data)`: Helper returning `{ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }`

### 4. `proxyUrl` (Browser Proxy)

Routes Chromium's traffic through a SOCKS5 or HTTP proxy (`--proxy-server=...` with `--proxy-bypass-list=<-loopback>,localhost,127.0.0.1,...`):

- Can be a string (`"socks5://127.0.0.1:10808"`) or a function `(userId: string) => string | undefined`.
- If you run a local proxy daemon (e.g. `xray`, `sing-box`, `privoxy`) from your plugin on `127.0.0.1:<port>`, Chromium picks up changes on the fly without restarting the browser.

### 5. `chromeExtensionDir` (Unpacked Chrome Extension)

Path to an unpacked Chrome extension directory (containing `manifest.json`). OpenBoxy passes it to Chromium via `--load-extension=...` at browser launch. See `mcp-server/plugins/ublock-origin-lite.ts` for an example.

### 6. `allowedUsers` (Per-User Access Control)

Optional array of user IDs (e.g. `["default"]`). When set, the plugin's `homeLink`, `httpHandler`, `proxyUrl`, `chromeExtensionDir`, and `register` tools are only active for those users.

---

## Persisting Plugin State

Store any plugin state or config files under `/data/` (e.g. `/data/my-plugin.json`) so they persist across container rebuilds and restarts on the `openboxy-data` Docker volume.
