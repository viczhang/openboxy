FROM oven/bun:1-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    procps \
    python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN bun install --production && bunx patchright install chromium --with-deps && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/extensions/ublock-origin-lite \
    && curl -fsSL "https://github.com/uBlockOrigin/uBOL-home/releases/download/2026.1116.1650/uBOLite_2026.1116.1650.chromium.zip" -o /tmp/ubol.zip \
    && python3 -m zipfile -e /tmp/ubol.zip /app/extensions/ublock-origin-lite \
    && rm -f /tmp/ubol.zip

RUN ARCH=$(uname -m) \
    && if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then XRAY_ARCH="arm64-v8a"; else XRAY_ARCH="64"; fi \
    && curl -fsSL "https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-${XRAY_ARCH}.zip" -o /tmp/xray.zip \
    && python3 -m zipfile -e /tmp/xray.zip /tmp/xray-bin \
    && mv /tmp/xray-bin/xray /usr/local/bin/xray \
    && chmod +x /usr/local/bin/xray \
    && rm -rf /tmp/xray.zip /tmp/xray-bin

RUN ln -sf /usr/local/bin/bun /usr/local/bin/node \
    && BUN_INSTALL=/usr/local bun install -g @earendil-works/pi-coding-agent

COPY src ./src
COPY plugins ./plugins

ENV DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 3100

CMD ["sh", "-c", "rm -f /tmp/.X99-lock && Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 & export DISPLAY=:99 && exec bun run src/index.ts"]
