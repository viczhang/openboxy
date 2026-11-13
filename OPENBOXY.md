# OpenBoxy

**OpenBoxy** packages [OpenBot](https://github.com/CopilotKit/openbot) in **single-user Personal Edition** together with a **Streamable HTTP MCP server** (`/mcp`) so external AI agents (Claude Code, Cursor, Codex, Antigravity, etc.) can use its persistent terminal, workspace files, and Playwright/visual Chromium browser—similar to `box.simular.ai/mcp`, self-hosted on your own server.

Upstream OpenBot files are kept unmodified so you can pull new OpenBot releases with `git fetch upstream && git merge upstream/main` (or a release tag) without merge conflicts.

---

## Quick Start

1. **Create `.env` from the example:**
   ```bash
   cp .env.openboxy.example .env
   ```
   Generate the required secrets:
   ```bash
   openssl rand -base64 32   # -> KEY_ENCRYPTION_KEY
   openssl rand -hex 32      # -> COMPUTER_TOKEN
   openssl rand -hex 32      # -> OPENBOXY_MCP_TOKEN
   ```
   Fill in your `INTELLIGENCE_API_KEY` and model provider (`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `BOT_MODEL`).

2. **Start OpenBoxy:**
   - **x86_64 (`linux/amd64`):**
     ```bash
     docker compose -f docker-compose.openboxy.yml up -d --build
     ```
   - **ARM64 (`linux/arm64`):** Build the base image once locally, set `OPENBOXY_IMAGE=openbot-local:v1.0.2-arm64` in `.env`, then start:
     ```bash
     docker build -t openbot-local:v1.0.2-arm64 .
     docker compose -f docker-compose.openboxy.yml up -d --build
     ```

3. **Verify:**
   - OpenBot UI: `http://127.0.0.1:3001`
   - MCP Server health: `curl http://127.0.0.1:3100/health`

---

## Connecting External AI Clients (`/mcp`)

Point any Streamable HTTP MCP client at `http://127.0.0.1:3100/mcp` (or `https://your-domain/mcp` behind a reverse proxy like Caddy):

```json
{
  "mcpServers": {
    "openboxy": {
      "serverUrl": "https://your-domain/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_OPENBOXY_MCP_TOKEN"
      }
    }
  }
}
```

### Exposed MCP Tools
- **Terminal & Files:** `shell`, `read_file`, `write_file`, `edit_file`, `list_dir`
- **Playwright Browser:** `browser_navigate`, `browser_snapshot`, `browser_read`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`
- **Visual Browser:** `screenshot` (returns PNG image + metadata), `browser_view` (returns live UI URL)

---

## Optional: SSH Keys for Remote Servers

If you want commands run in the terminal (`shell`) to SSH into other servers, generate a dedicated keypair on your host and mount it into `/home/pwuser/.ssh` inside `openboxy` (owned by UID/GID `1001:1001`). Do not commit SSH keys to git.

---

## Merging Upstream OpenBot Updates

```bash
git remote add upstream https://github.com/CopilotKit/openbot.git  # if not already set
git fetch upstream --tags
git merge v1.0.3   # or upstream/main
```
