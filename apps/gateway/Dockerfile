# Build context is the repo root (pnpm workspace + lockfile live there):
#   docker build -f apps/gateway/Dockerfile -t switchyard-gateway:dev .
FROM node:24.22.1-alpine AS build
# Build-time only: Docker Desktop resolves the npm registry to IPv6 first and stalls; prefer IPv4.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
RUN npm install -g pnpm@10.34.7
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/gateway/package.json apps/gateway/
# Cached pnpm store: a flaky registry connection only re-downloads what is missing.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --filter gateway --store-dir /pnpm-store --fetch-retries 6 --network-concurrency 8
COPY apps/gateway apps/gateway
RUN pnpm --filter gateway build && pnpm --filter gateway deploy --prod --legacy /out

FROM node:24.22.1-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# dist/ holds the server and the built dashboard (dist/public); migrations/ is read at startup.
# Files stay root-owned (read-only to the app); the process runs as the image's "node" user (uid 1000).
COPY --from=build /out ./
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
