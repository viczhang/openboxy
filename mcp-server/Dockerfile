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
RUN bun install --production && bunx playwright install chromium --with-deps && rm -rf /var/lib/apt/lists/*

COPY src ./src

ENV DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 3100

CMD ["bun", "run", "src/index.ts"]
