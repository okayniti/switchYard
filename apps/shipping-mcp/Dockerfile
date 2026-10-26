# Build context is the repo root (pnpm workspace + lockfile live there):
#   docker build -f apps/shipping-mcp/Dockerfile -t switchyard-shipping-mcp:dev .
FROM node:24.22.1-alpine AS build
RUN npm install -g pnpm@10.34.7
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/shipping-mcp/package.json apps/shipping-mcp/
RUN pnpm install --frozen-lockfile --filter shipping-mcp
COPY apps/shipping-mcp apps/shipping-mcp
RUN pnpm --filter shipping-mcp build && pnpm --filter shipping-mcp deploy --prod --legacy /out

FROM node:24.22.1-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# Files stay root-owned (read-only to the app); the process runs as the image's "node" user (uid 1000).
COPY --from=build /out ./
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
