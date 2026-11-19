# OpenBoxy

> **Give your AI agents a real browser and terminal.**
>
> **OpenBoxy** equips chat-only AI agents with a persistent Chromium browser, workspace shell, and live human takeover over MCP—in a self-hosted, single-container **Streamable HTTP MCP server** (`/mcp`) with a live web UI (`/`, `/view`, `/view/terminal`) where you can watch or click **Take Control** to handle logins, 2FA, or CAPTCHAs by hand.

Each API token maps to an isolated user sandbox (`/data/users/<userId>/profile`, `/workspace`, and `/home`), so multiple users (or multiple AI clients) can connect safely.

---

## What You Can Ask Your AI (Example Prompts)

Once OpenBoxy (`boxy`) is connected to **ChatGPT, Gemini, Claude, OpenCode, or Cursor**, you can just talk to it naturally:

- **Browse & Screenshot:** *"Use boxy to open `https://news.ycombinator.com`, summarize the top 5 stories, and take a screenshot."* → Navigates in a real Chromium browser (with uBlock Origin Lite + your cookies) and saves a PNG to `screenshots/`.
- **Download a Clean Article:** *"Have boxy save `https://example.com/long-post` as a clean offline article."* → Extracts Reader View HTML + embedded images (no nav/ads) into `articles/` for reading in `/view/files`.
- **Listen to an Article Hands-Free:** *"Let boxy send me the audio link for `https://example.com/long-post`."* → Archives the clean article and returns a `?audio=1` link that opens the article and starts dynamic Edge TTS playback at your remembered speed (`1x`–`2x`) with zero MP3 clutter.
- **Private Audio Briefing for Emails & Messages:** *"Let boxy check my unread emails in Gmail (or Outlook / Slack / Discord) and send me an audio link."* → Reads your already signed-in webmail/chat tab and returns a **private, login-protected link** (`/view/files?file=...&audio=1`) to listen on your phone.
- **Download Videos or Music:** *"Use boxy to download the audio from `https://youtu.be/...`."* → Downloads video/MP3 into `downloads/` (via the MeTube/yt-dlp plugin or browser downloads), playable right in `/view/files`.
- **Build & Publish a Playable HTML Game / Mini-App / any HTML file:** *"Build a Snake game in HTML and publish it with boxy."* → Saves to `apps/` and publishes a live, full-screen playable URL (`/app/<id>`) in an isolated sandbox iframe (updates in-place when you ask for changes).
- **Save a Logged-In Page as PDF:** *"Open my billing page in boxy, export it to PDF, and give me a share link."* → Prints the active page to `pdfs/` (`browser_pdf`) with an optional `/s/<id>` link.
- **Handle Logins / 2FA Together:** *"Open my dashboard in boxy—if it asks to sign in, hand control to me."* → Triggers `request_human_control` with an **Action Needed** banner and **Done — Resume Agent** button in `/view`.
- **Multi-Tab Research & API Debugging:** *"Open these 3 pages in separate boxy tabs, and check the JSON API responses in the network log."* → Uses `browser_tabs` and `browser_network_log` to inspect live XHR/fetch payloads without losing your open tabs.
- **Share Any Workspace File:** *"Share `articles/report.html` with a password that expires in 1 day."* → Creates a password-protected `/s/<id>` link with configurable expiration (`1d`, `1w`, `1m`, `forever`).
- **Run Shell Commands & Scripts:** *"Use boxy's shell to convert `downloads/data.csv` into a summary chart and save it to `files/`."* → Runs commands in your persistent Linux workspace (`shell`, `read_file`, `write_file`, `edit_file`) or lets you jump into `/view/terminal` with the built-in **Pi** coding agent (`+ Pi`).
- **Switch VPN Country (Plugin):** *"Switch boxy's VPN to Japan and check how `https://example.com` looks from Tokyo."* → Routes the browser through a configured proxy/VPN plugin (`set_vpn_country`).

---

## Features

### 1. Live Persistent Browser (`/view`) with Human Takeover
- **Real Chromium with anti-bot stealth:** Runs a persistent `patchright` Chromium context per user (`/data/users/<userId>/profile`) with uBlock Origin Lite preloaded.
- **Live Human Takeover ("Take Control"):** Watch the agent browse in real time, or click **Take Control** to pause agent actions and manually complete logins, 2FA, or interactive flows using mouse clicks, drag-selection, scrolling, keyboard shortcuts (`Ctrl/Cmd + C`, `V`, `X`, `A`), right-click context menu, and file upload dialogs.
- **Full Browser Controls:** Multi-tab bar (`+`, switch, `×`), Back / Reload / Forward buttons, URL bar with `Go` / Return-key navigation, full-screen mode, and one-click **Save Webpage to Files** (archives clean reader HTML + images into the workspace).
- **Browser Home Page (`boxy://home`):** Displays live Exit IP & Country, Server local time, and VPN remote country time on top, followed by Plugin cards and editable Bookmarks.

### 2. Multi-Tab Web Terminal & Built-in TUI AI Agent (`/view/terminal`)
- **Persistent Multi-Tab PTYs:** Open multiple `bash` tabs (`Terminal 1`, `Terminal 2`, …) that stay alive across browser refreshes with a `64 KB` scrollback buffer per tab.
- **Built-in Pi Coding Agent (`+ Pi`):** Pre-installed `@earendil-works/pi-coding-agent` (`pi`) with BYOK support (`~/.pi/agent/` stored on `/data` so API keys and sessions survive Docker image updates) and pre-wired to OpenBoxy's local `/mcp` server out of the box.

### 3. Workspace File Manager & Public Share Links (`/view/files` & `/s/<id>`)
- **Workspace Explorer:** Browse, upload, download, and delete files in `/data/users/<userId>/workspace` (including automatic browser downloads in `workspace/downloads/`).
- **Rich In-Browser Previews:** Preview images, video, markdown/code/text, and audio (with playback speed and track navigation controls).
- **Share Links (`share` tool & UI modal):** Generate public share links (`/s/<id>`) for workspace files or archived web pages with configurable expiration (`1h`, `24h`, `7d`, `never`) and optional password protection.

### 4. Streamable HTTP MCP Server (`/mcp`) & Client Setup
- **Core MCP Tools:**
  - **Browser:** `browser_navigate`, `browser_snapshot`, `browser_read`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_tabs`, `browser_network_log`, `browser_pdf`, `screenshot`, `browser_view`, `request_human_control`
  - **Publishing & Audio:** `publish_app`, `article_to_audio`, `create_audio_briefing`, `share`
  - **Terminal & Files:** `shell`, `read_file`, `write_file`, `edit_file`, `list_dir`
- **OAuth 2.0 PKCE & Bearer Auth:** Supports both zero-header OAuth 2.0 PKCE + Dynamic Client Registration (`/oauth/authorize`) and static `Authorization: Bearer <token>` headers, with a built-in **MCP Setup** modal in `/view` generating ready-to-paste configs for ChatGPT, Claude, Gemini, Claude Code, Codex, Gemini CLI, Cursor, OpenCode, VS Code, OpenClaw, Hermes, DeepSeek, and WorkBuddy.

### 5. Multi-User Isolation in a Single Container
- Each token (`OPENBOXY_MCP_TOKEN`, `OPENBOXY_USERS`, or `/data/users.json`) maps to an isolated user sandbox (`/data/users/<userId>/{profile,workspace,home}`) with its own browser profile, cookies, bookmarks, files, and terminal sessions.

### 6. Extensible Plugin System ([docs/plugins.md](docs/plugins.md))
- Drop `.ts` / `.js` files into `/data/plugins` to add:
  - **Custom MCP tools** (`register(ctx)`)
  - **Custom web UIs & APIs** under `/p/<pluginName>/*` (`httpHandler`)
  - **Home page cards** (`homeLink`)
  - **Browser SOCKS5/HTTP proxy routing** (`proxyUrl`, e.g. VLESS/Xray VPN exit-country switching)
  - **Unpacked Chrome extensions** (`chromeExtensionDir`)
  - **Per-user access control** (`allowedUsers`)

---

### Screenshots

**Sign In (`/login`)**

![OpenBoxy Sign In](docs/images/login.png)

**Browser Home (`boxy://home`)**

![OpenBoxy Browser Home](docs/images/browser-view.png)

**Multi-Tab Terminal (`/view/terminal`)**

![OpenBoxy Terminal](docs/images/terminal-view.png)

**Workspace File Browser (`/view/files`)**

![OpenBoxy File Browser](docs/images/files-view.png)

---

## Quick Start

1. **Create `.env` from the example:**
   ```bash
   cp .env.openboxy.example .env
   ```
   Generate your default API token (`OPENBOXY_MCP_TOKEN`):
   ```bash
   openssl rand -hex 32
   ```
   Optionally add more users in `.env`:
   ```env
   OPENBOXY_USERS=alice:tok_alice_xxx,bob:tok_bob_xxx
   ```

2. **Start OpenBoxy:**
   ```bash
   docker compose -f docker-compose.openboxy.yml up -d --build
   ```

3. **Verify:**
   - Health check: `curl http://127.0.0.1:3100/healthz`
   - Web UI (Browser & Terminal): `http://127.0.0.1:3100/`

---

## Connecting External AI Clients (`/mcp`)

OpenBoxy supports **OAuth 2.0 PKCE + Dynamic Client Registration** and **Static Bearer Tokens**.

### Option A: OAuth 2.0 PKCE (Recommended for OpenCode, Claude Code, Cursor)
Point your client at `https://your-domain/mcp` with no manual headers. In **OpenCode** (`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "mcp": {
    "boxy": {
      "type": "remote",
      "url": "https://your-domain/mcp",
      "enabled": true
    }
  }
}
```

Then run `/mcps` in OpenCode, select `boxy`, and sign in at `/oauth/authorize` using your API token. Your OAuth session is bound to that token's user sandbox.

### Option B: Static Bearer Token
```json
{
  "mcpServers": {
    "boxy": {
      "serverUrl": "https://your-domain/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_TOKEN"
      }
    }
  }
}
```

---

## Exposed MCP Tools
- **Terminal & Files:** `shell`, `read_file`, `write_file`, `edit_file`, `list_dir`
- **Browser & Handoff:** `browser_navigate`, `browser_snapshot`, `browser_read`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_tabs`, `browser_network_log`, `browser_pdf`, `screenshot`, `browser_view`, `request_human_control`
- **Publishing, Audio & Sharing:** `publish_app`, `article_to_audio`, `create_audio_briefing`, `share`
- **Browser Downloads:** Any file downloaded in the live browser automatically saves to `workspace/downloads/` and appears in `/view/files` (sorted newest-first).

---

## Plugins (Custom Tools & Extensions)

Drop `.ts` / `.js` plugin files into `/data/plugins` (or set `OPENBOXY_PLUGINS_DIR`) to register custom MCP tools, web UIs (`/p/<name>`), home page cards, browser proxies, or unpacked Chrome extensions without modifying OpenBoxy core. See **[docs/plugins.md](docs/plugins.md)** for the full plugin authoring guide.

```ts
import type { OpenBoxyPlugin } from "/app/src/plugins.ts";

export default {
  name: "my-custom-tool",
  // Optional: restrict to specific userIds
  // allowedUsers: ["default"],
  register(ctx) {
    ctx.registerTool(
      "open_my_app",
      {
        description: "Open my internal web app and prefill an input.",
        inputSchema: { query: ctx.z.string() },
      },
      async ({ query }) => {
        await ctx.sandbox.withPage(ctx.userId, async (page) => {
          await page.goto("http://my-service:8080");
          // ...prefill page...
        });
        return ctx.textResult({
          viewUrl: `${ctx.publicUrl}/view`,
          filesUrl: `${ctx.publicUrl}/view/files`,
        });
      },
    );
  },
} satisfies OpenBoxyPlugin;
```
