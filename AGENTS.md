# AGENTS.md — AI Agent Guide for OpenBoxy

This repository packages **OpenBot (Personal Edition)** with **OpenBoxy MCP** (`boxy`), a Streamable HTTP MCP server + live `/view` browser/terminal takeover proxy.

## Repository Layout (Do Not Break Upstream Merges)

Keep OpenBoxy-specific code isolated so `git merge upstream/<tag>` stays conflict-free:

- `mcp-server/src/index.ts` — Bun HTTP/WebSocket server: Streamable HTTP `/mcp` (14 tools), OAuth 2.0 PKCE + Dynamic Client Registration, `/view` (live browser + click/type/scroll takeover), `/view/terminal` (live `xterm.js` PTY proxy), and `/` launcher overlay.
- `mcp-server/Dockerfile`, `mcp-server/package.json` — container build for `openboxy-mcp`.
- `docker-compose.openboxy.yml` — standalone Compose stack (`openboxy` + `openboxy-mcp`).
- `.env.openboxy.example` — environment template (never commit `.env`).
- `README.md`, `OPENBOXY.md`, `AGENTS.md` — documentation.
- **Do not edit** upstream OpenBot directories (`app/`, `server/`, `agent-computer/`, `Dockerfile`, etc.) unless fixing an upstream bug intentionally.

## Autonomous Deployment Playbook

When asked by a user to deploy OpenBoxy on a Linux server:

1. **Check prerequisites & architecture:**
   ```bash
   uname -m
   free -h
   df -h .
   docker --version && docker compose version
   ```
   Verify at least **2 GB RAM** (4 GB+ recommended) and **10 GB+ free disk**.

2. **Prepare `.env`:**
   ```bash
   cp .env.openboxy.example .env
   ```
   Generate fresh secrets (never reuse example values or commit `.env`):
   - `KEY_ENCRYPTION_KEY`: `openssl rand -base64 32`
   - `COMPUTER_TOKEN`: `openssl rand -hex 32`
   - `OPENBOXY_MCP_TOKEN`: `openssl rand -hex 32`
   Ask the user (or read from their environment if provided) for:
   - `INTELLIGENCE_API_KEY`
   - `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `BOT_MODEL`
   - `OPENBOXY_PUBLIC_URL` (e.g. `https://mcp.example.com`)

3. **Build / Start Containers:**
   - If `uname -m` is `aarch64` / `arm64`:
     ```bash
     docker build -t openbot-local:v1.0.2-arm64 .
     # Set OPENBOXY_IMAGE=openbot-local:v1.0.2-arm64 in .env
     ```
   - Start stack:
     ```bash
     docker compose -f docker-compose.openboxy.yml up -d --build
     ```

4. **Verify Health & MCP:**
   ```bash
   curl -fsS http://127.0.0.1:3100/health
   curl -fsS http://127.0.0.1:3001/ >/dev/null
   ```
   Test MCP `initialize` with `OPENBOXY_MCP_TOKEN` against `http://127.0.0.1:3100/mcp`.

5. **Configure Reverse Proxy (if public domain requested):**
   - Route `/mcp*`, `/.well-known/oauth*`, `/oauth/*` publicly to `openboxy-mcp:3100` (protected by OAuth / `OPENBOXY_MCP_TOKEN`).
   - Route `/` and `/view*` behind Basic Auth to `openboxy-mcp:3100`.
   - Route remaining paths behind Basic Auth to `openboxy:3001` with `Host: localhost:3001` and `Origin: http://localhost:3001`.
   - **Never** expose `agent-computer` port `4100` publicly.

6. **Hand Off to User:**
   Provide the user with:
   - Public URL (`OPENBOXY_PUBLIC_URL`), `/view`, and `/view/terminal`
   - Their `OPENBOXY_MCP_TOKEN` (for `/mcps` OAuth sign-in or `Bearer` header)
   - The `boxy` client config snippet for OpenCode / Claude Code / Cursor.
