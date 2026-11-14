# OpenBoxy

**OpenBoxy** is a self-hosted, single-user cloud sandbox for AI agents—combining [OpenBot](https://github.com/CopilotKit/openbot) (Personal Edition) with a **Streamable HTTP MCP server** (`boxy`) and an interactive **live Browser + Terminal viewer** (`/view`, `/view/terminal`).

External AI clients (OpenCode, Claude Code, Cursor, Codex, etc.) connect over MCP to drive a persistent Chromium browser (Playwright ARIA snapshots + visual screenshots) and a persistent Linux terminal/workspace, while you can watch and take over control of both the browser and terminal from any web browser.

---

## Architecture

| Service | Container | Port | Purpose |
| --- | --- | --- | --- |
| **OpenBot + `agent-computer`** | `openboxy` | `127.0.0.1:3001` (UI/API), internal `:4100` (`agent-computer`) | Single-user OpenBot (`OPENBOT_EDITION=personal`), embedded Postgres, persistent `/workspace` & `/profiles`, Xvfb + Chromium, live PTY shell. |
| **MCP + Live View Proxy** | `openboxy-mcp` | `127.0.0.1:3100` | Streamable HTTP `/mcp` server (`boxy`), OAuth 2.0 PKCE + Dynamic Client Registration, `/view` (interactive browser), `/view/terminal` (live `xterm.js` PTY), and `/` launcher overlay. |

---

## Hardware Requirements

| Tier | CPU | RAM | Disk | Notes |
| --- | --- | --- | --- | --- |
| **Minimum** | 2 vCPU | **2 GB** (+ 2 GB swap) | 10 GB | Runs `openboxy` + `openboxy-mcp` with light browsing. Swap helps absorb Chromium spikes on heavy sites. |
| **Recommended** | 2–4 vCPU | **4 GB+** | 20 GB+ SSD | Smooth multi-tab Chromium browsing and fast local ARM64/MCP Docker builds. |

- **Supported architectures:** `linux/amd64` (prebuilt image) and `linux/arm64` (single local `docker build`).
- **Measured footprint:** ~390–420 MiB idle; **~970 MiB** active with a heavy webpage open in Chromium (`openboxy` ~949 MiB + `openboxy-mcp` ~21 MiB).

---

## Deploy with an AI Agent

This repo includes [`AGENTS.md`](./AGENTS.md) so coding agents (OpenCode, Claude Code, Codex, Cursor, Antigravity) can deploy and verify it autonomously on your server.

Paste this prompt to an agent running on your target machine:

> Clone `https://github.com/viczhang/openboxy`, read `AGENTS.md` and `README.md`, and deploy OpenBoxy on this server. Generate fresh secrets in `.env`, build/start the containers (building `openbot-local` first if ARM64), verify `/health` and `/mcp`, and configure HTTPS reverse proxy for `<your-domain>` (using my preferred proxy/auth such as Nginx, Caddy, Traefik, Cloudflare Tunnel, or Tailscale).

---

## Quick Start (Manual)

1. **Create `.env` from the example:**
   ```bash
   cp .env.openboxy.example .env
   ```

2. **Generate required secrets and add them to `.env`:**
   ```bash
   openssl rand -base64 32   # -> KEY_ENCRYPTION_KEY
   openssl rand -hex 32      # -> COMPUTER_TOKEN
   openssl rand -hex 32      # -> OPENBOXY_MCP_TOKEN
   ```
   Fill in your `INTELLIGENCE_API_KEY` and model provider (`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `BOT_MODEL`), plus `OPENBOXY_PUBLIC_URL=https://mcp.example.com`.

3. **Start OpenBoxy:**
   - **x86_64 (`linux/amd64`):**
     ```bash
     docker compose -f docker-compose.openboxy.yml up -d --build
     ```
   - **ARM64 (`linux/arm64`):** Build the base image locally once, set `OPENBOXY_IMAGE=openbot-local:v1.0.2-arm64` in `.env`, then start:
     ```bash
     docker build -t openbot-local:v1.0.2-arm64 .
     docker compose -f docker-compose.openboxy.yml up -d --build
     ```

4. **Verify locally:**
   ```bash
   curl http://127.0.0.1:3100/health
   ```

---

## Reverse Proxy & Authentication (Proxy-Agnostic)

OpenBoxy does **not** require Caddy or a separate Basic Auth password. Choose whichever auth model fits your setup:

### Authentication Options (`OPENBOXY_UI_AUTH`)

- **`OPENBOXY_UI_AUTH=token` (default):** Built-in `/login` page protected by your `OPENBOXY_MCP_TOKEN` (`HttpOnly` signed cookie). Works behind **any** reverse proxy (Nginx, Traefik, Caddy, Cloudflare Tunnel) with zero proxy-level auth setup.
- **`OPENBOXY_UI_AUTH=off`:** Disables the built-in `/login` screen when your edge/VPN handles auth (e.g., **Tailscale Serve**, **Cloudflare Access**, **Authelia/Authentik**, or proxy Basic Auth).

### Routing Rules (Single Upstream: `openboxy-mcp:3100`)

`openboxy-mcp:3100` proxies and gates all OpenBot UI/API/WebSocket routes behind `OPENBOXY_UI_AUTH`, so your reverse proxy only needs **one** upstream (`127.0.0.1:3100` or `openboxy-mcp:3100`) with WebSocket upgrade enabled:

<details>
<summary>Nginx example</summary>

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.example.com;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}
```

</details>

<details>
<summary>Caddy example</summary>

```caddyfile
mcp.example.com {
    reverse_proxy openboxy-mcp:3100
}
```

</details>

---

## Connecting External AI Clients (`/mcp`)

The default MCP server name is **`boxy`** (configurable via `OPENBOXY_MCP_NAME`). Both authentication modes are supported:

### Option A: OAuth 2.0 PKCE (Recommended for OpenCode, Claude Code, Cursor)

Configure the remote MCP URL with no manual headers:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "mcp": {
    "boxy": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "enabled": true
    }
  }
}
```

In **OpenCode**, run `/mcps`, select **`boxy`**, and sign in—your browser opens `/oauth/authorize`, where you paste `OPENBOXY_MCP_TOKEN` once and click **Approve & Connect**.

### Option B: Static Bearer Token

```json
{
  "mcpServers": {
    "boxy": {
      "serverUrl": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_OPENBOXY_MCP_TOKEN"
      }
    }
  }
}
```

For OpenCode with a static token, add `"oauth": false` alongside `"headers"`.

---

## Live Browser & Terminal Takeover (`/view`)

- **`https://mcp.example.com/`** — OpenBot UI with a floating bottom-right pill linking to **Live Browser** (`/view`), **Terminal** (`/view/terminal`), and **MCP Setup**.
- **`https://mcp.example.com/view`** — Live `1280x800` Chromium screen + URL bar. Click **Take Control** to click, type, paste, and scroll directly in the remote browser; click **Release Control** to hand control back to the AI.
- **`https://mcp.example.com/view/terminal`** — Live `xterm.js` PTY terminal attached to the same workspace shell. Click **Take Control** to type directly in the shell.

---

## Exposed MCP Tools (14)

- **Terminal & Files:** `shell`, `read_file`, `write_file`, `edit_file`, `list_dir`
- **Playwright Browser:** `browser_navigate`, `browser_snapshot`, `browser_read`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`
- **Visual Browser:** `screenshot` (PNG + metadata), `browser_view` (live `/view` URL)

---

## Merging Upstream OpenBot Updates

OpenBoxy keeps its additions isolated in `mcp-server/`, `docker-compose.openboxy.yml`, `.env.openboxy.example`, `OPENBOXY.md`, and `README.md`:

```bash
git remote add upstream https://github.com/CopilotKit/openbot.git  # if not set
git fetch upstream --tags
git merge v1.0.3   # or upstream/main
```
