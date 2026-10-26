// Switchyard gateway: one process serving
//   /mcp      the team MCP endpoint (API-key auth)
//   /api/*    the dashboard's REST API (session-cookie auth)
//   /healthz  probes
//   /*        the dashboard SPA (built by Vite into dist/public)
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import { apiRouter } from "./api.js";
import { loadUser } from "./auth.js";
import { config } from "./config.js";
import { migrate, pool } from "./db.js";
import { mcpRouter } from "./mcp.js";
import { seed } from "./seed.js";
import { upstreams } from "./upstreams.js";

await migrate();
await seed();
upstreams.start();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // behind the ingress controller

// Liveness: the process is up. Readiness additionally needs Postgres (a gateway without its DB
// can't authenticate anyone). Upstream health deliberately doesn't affect either probe.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});
app.get("/readyz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, error: "database unavailable" });
  }
});

app.use("/mcp", mcpRouter());
app.use("/api", loadUser, apiRouter());

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
if (existsSync(publicDir)) {
  app.use(express.static(publicDir, { index: false, maxAge: "1h" }));
  app.get(/^\/(?!api\/|mcp).*/, (_req, res) => res.sendFile("index.html", { root: publicDir, maxAge: 0 }));
}

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error("request failed:", err);
  if (!res.headersSent) res.status(500).json({ error: "Internal error" });
};
app.use(onError);

const server = app.listen(config.port, () => console.log(`gateway listening on :${config.port}`));
process.on("SIGTERM", () => {
  upstreams.stop();
  server.close(() => void pool.end().then(() => process.exit(0)));
});
