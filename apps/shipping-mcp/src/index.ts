// shipping-mcp: a small second upstream for the gateway. It quotes shipping from a fixed rate
// table (no external carrier), and it requires a static bearer token, so it demonstrates how the
// gateway injects an upstream credential that clients never see. Stateless Streamable HTTP.
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import * as z from "zod";
import { quote, searchZones, ZONES } from "./rates.js";

const port = Number(process.env.PORT ?? 8080);
const token = process.env.SHIPPING_TOKEN;
if (!token) {
  console.error("missing required env SHIPPING_TOKEN");
  process.exit(1);
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

function buildServer(): McpServer {
  const server = new McpServer({ name: "shipping-mcp", version: "1.0.0" });

  server.registerTool(
    "quote_shipping",
    {
      description: "Quote shipping cost and delivery time (INR) for a parcel to an Indian PIN code, Indian state, or another country.",
      inputSchema: {
        destination: z.string().min(1).describe("6-digit Indian PIN code, Indian state name, or country"),
        weight_kg: z.number().positive().max(50),
        service: z.enum(["standard", "express"]).optional().describe("Default: both are quoted"),
      },
    },
    async ({ destination, weight_kg, service }) => json(quote(destination, weight_kg, service)),
  );

  server.registerTool(
    "list_zones",
    { description: "List the shipping zones, the regions they cover, and their rate cards (INR)." },
    async () => json(ZONES),
  );

  server.registerTool(
    "search",
    {
      description: "Search shipping zones by name or region (e.g. 'Kerala', 'international').",
      inputSchema: { query: z.string().min(1) },
    },
    async ({ query }) => json(searchZones(query)),
  );

  return server;
}

const expected = Buffer.from(`Bearer ${token}`);
const authorized = (header: string | undefined): boolean => {
  const got = Buffer.from(header ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected);
};

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.use("/mcp", (req, res, next) => {
  if (authorized(req.headers.authorization)) return next();
  res.status(401).set("WWW-Authenticate", "Bearer").json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
});

app.post("/mcp", async (req, res) => {
  const server = buildServer();
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

const notAllowed: express.RequestHandler = (_req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
};
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

const httpServer = app.listen(port, () => console.log(`shipping-mcp listening on :${port}`));
process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
