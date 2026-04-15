FROM oven/bun:1.3.12-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY src ./src
COPY drizzle ./drizzle

ENV NODE_ENV=production
CMD ["bun", "src/index.ts"]
