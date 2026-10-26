# Build context is the repo root (pnpm workspace + lockfile live there):
#   docker build -f apps/woo-mcp/Dockerfile -t switchyard-woo-mcp:dev .
FROM node:24.22.1-alpine AS build
RUN npm install -g pnpm@10.34.7
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/woo-mcp/package.json apps/woo-mcp/
RUN pnpm install --frozen-lockfile --filter woo-mcp
COPY apps/woo-mcp apps/woo-mcp
RUN pnpm --filter woo-mcp build && pnpm --filter woo-mcp deploy --prod --legacy /out

FROM node:24.22.1-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# Files stay root-owned (read-only to the app); the process runs as the image's "node" user (uid 1000).
COPY --from=build /out ./
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
