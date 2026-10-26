// shipping-mcp: a small second upstream for the gateway. It quotes shipping from a fixed rate
// table (no external carrier), and it requires a static bearer token, so it demonstrates how the
// gateway injects an upstream credential that clients never see. Stateless Streamable HTTP.
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import * as z from "zod";

const port = Number(process.env.PORT ?? 8080);
const token = process.env.SHIPPING_TOKEN;
if (!token) {
  console.error("missing required env SHIPPING_TOKEN");
  process.exit(1);
}

interface Zone {
  id: string;
  name: string;
  regions: string[];
  standard: { base: number; perKg: number; days: string };
  express: { base: number; perKg: number; days: string };
}

// Prices in INR. Indian zones are keyed by the first digit of the PIN code.
const ZONES: Zone[] = [
  { id: "in-north", name: "India North", regions: ["PIN 1xxxxx-2xxxxx", "Delhi", "Punjab", "Uttar Pradesh"], standard: { base: 60, perKg: 20, days: "3-5" }, express: { base: 140, perKg: 40, days: "1-2" } },
  { id: "in-west", name: "India West", regions: ["PIN 3xxxxx-4xxxxx", "Rajasthan", "Gujarat", "Maharashtra"], standard: { base: 50, perKg: 18, days: "2-4" }, express: { base: 120, perKg: 35, days: "1-2" } },
  { id: "in-south", name: "India South", regions: ["PIN 5xxxxx-6xxxxx", "Karnataka", "Tamil Nadu", "Kerala"], standard: { base: 70, perKg: 22, days: "3-6" }, express: { base: 150, perKg: 45, days: "2-3" } },
  { id: "in-east", name: "India East", regions: ["PIN 7xxxxx-8xxxxx", "West Bengal", "Bihar", "Assam"], standard: { base: 80, perKg: 25, days: "4-7" }, express: { base: 170, perKg: 50, days: "2-3" } },
  { id: "intl", name: "International", regions: ["Any non-Indian destination"], standard: { base: 1200, perKg: 600, days: "8-14" }, express: { base: 2500, perKg: 900, days: "3-5" } },
];

function zoneFor(destination: string): Zone {
  const d = destination.trim();
  const pin = /^\d{6}$/.test(d) ? Number(d[0]) : NaN;
  if (pin >= 1 && pin <= 2) return ZONES[0];
  if (pin >= 3 && pin <= 4) return ZONES[1];
  if (pin >= 5 && pin <= 6) return ZONES[2];
  if (pin >= 7 && pin <= 8) return ZONES[3];
  const byName = ZONES.find((z) => z.regions.some((r) => r.toLowerCase() === d.toLowerCase()));
  return byName ?? ZONES[4];
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
    async ({ destination, weight_kg, service }) => {
      const zone = zoneFor(destination);
      const kg = Math.ceil(weight_kg * 2) / 2; // bill per started half-kilo
      const quote = (s: "standard" | "express") => ({
        service: s,
        price_inr: zone[s].base + Math.round(zone[s].perKg * kg),
        delivery_days: zone[s].days,
      });
      return json({ destination, zone: zone.id, billed_weight_kg: kg, quotes: service ? [quote(service)] : [quote("standard"), quote("express")] });
    },
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
    async ({ query }) => {
      const q = query.toLowerCase();
      return json(ZONES.filter((z) => [z.id, z.name, ...z.regions].some((s) => s.toLowerCase().includes(q))));
    },
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
