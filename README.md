# OpenBoxy

**OpenBoxy** is a self-hosted, single-container **Streamable HTTP MCP server** (`/mcp`) with a persistent **Playwright Chromium browser**, **PTY terminal**, and **workspace filesystem**—plus a live web UI (`/`, `/view`, `/view/terminal`) where you can watch or click **Take Control** to handle logins, 2FA, or CAPTCHAs by hand.

Each API token maps to an isolated user sandbox (`/data/users/<userId>/profile`, `/workspace`, and `/home`), so multiple users (or multiple AI clients) can connect safely.

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
- **Browser:** `browser_navigate`, `browser_snapshot`, `browser_read`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `screenshot`, `browser_view`
