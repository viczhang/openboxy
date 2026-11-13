FROM oven/bun:1-slim

WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src ./src

EXPOSE 3100

CMD ["bun", "run", "src/index.ts"]
