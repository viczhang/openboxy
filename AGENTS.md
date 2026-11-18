# OpenBoxy Agent Guide

OpenBoxy is a single-container Bun + Playwright + PTY MCP server (`mcp-server/`).

## Repository Layout
- `mcp-server/src/index.ts`: HTTP/WebSocket server, multi-user token/OAuth auth, MCP tools, and live Browser/Terminal web UI.
- `mcp-server/src/sandbox.ts`: Per-user `SandboxManager` isolating `/data/users/<userId>/{profile,workspace,home}`, Chromium contexts, and shell execution.
- `mcp-server/Dockerfile`: `oven/bun:1-slim` image with Playwright Chromium and CLI utilities.
- `docker-compose.openboxy.yml`: Single-service compose definition (`openboxy-mcp`) with `openboxy-data:/data`.
- `.env.openboxy.example`: Environment template (`OPENBOXY_MCP_TOKEN`, `OPENBOXY_USERS`, `OPENBOXY_USERS_JSON`, `OPENBOXY_PUBLIC_URL`, `OPENBOXY_UI_AUTH`, `BROWSER_IDLE_MINUTES`).

## Rules
- Never commit `.env`, API tokens, personal domains, or `docker-compose.caddy.yml`.
- Rebuild after changes: `docker compose -f docker-compose.openboxy.yml up -d --build openboxy-mcp`.
