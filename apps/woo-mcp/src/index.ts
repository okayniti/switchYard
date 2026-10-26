// woo-mcp: an MCP server over Streamable HTTP, in stateless mode. Each POST /mcp gets a fresh
// McpServer + transport, so there is no session state to lose when the pod restarts and any
// replica can answer any request. Only the gateway reaches this (ClusterIP + NetworkPolicy).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { registerTools } from "./tools.js";
import { WcClient } from "./wc.js";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

const port = Number(env("PORT", "8080"));
const tz = env("STORE_TZ", "Asia/Kolkata");
const wcUrl = env("WC_URL");
const wc = new WcClient({ url: wcUrl, home: env("WC_HOME", wcUrl), key: env("WC_KEY"), secret: env("WC_SECRET") });

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.post("/mcp", async (req, res) => {
  const server = new McpServer({ name: "woo-mcp", version: "1.0.0" });
  registerTools(server, wc, tz);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mcp request failed:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

// Stateless server: no SSE stream to resume and no session to delete.
const notAllowed: express.RequestHandler = (_req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
};
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

const httpServer = app.listen(port, () => console.log(`woo-mcp listening on :${port} (store ${wcUrl}, tz ${tz})`));
process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
