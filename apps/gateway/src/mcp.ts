// The gateway's server side: one MCP endpoint, /mcp, for every team member.
//
// - Origin, when present, must be in MCP_ALLOWED_ORIGINS (DNS-rebinding defence, required by
//   the spec). CLI clients send no Origin and are allowed.
// - Authorization: Bearer <api key> is checked against the DB on EVERY request (not just at
//   initialize), so a revoked key fails on its very next request even inside an open session.
// - Each MCP session is bound to the key that opened it; a request presenting a different key
//   for that session is rejected.
// - Uses the SDK's low-level Server (not McpServer), because the tool set is dynamic: tools/list
//   is served from the UpstreamManager's cache (never blocks on a slow upstream) and tools/call is
//   routed through executeToolCall.
// - When the cached tool set changes, every open session gets notifications/tools/list_changed.
// - The client's key is never forwarded upstream (the MCP spec forbids token passthrough);
//   upstreams only ever see the gateway's own per-server credential.
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response, Router } from "express";
import express from "express";
import { config } from "./config.js";
import { sha256 } from "./crypto.js";
import { pool } from "./db.js";
import { executeToolCall, type CallContext } from "./execute.js";
import { originAllowed, parseOrigins } from "./origin.js";
import { upstreams } from "./upstreams.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  ctx: CallContext;
  lastSeen: number;
}

const sessions = new Map<string, Session>();
const allowedOrigins = parseOrigins(config.mcpAllowedOrigins);
const SESSION_IDLE_MS = 60 * 60 * 1000;

const rpcError = (res: Response, status: number, message: string) =>
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null });

// Look up the bearer key. Returns null if missing, unknown, revoked or expired.
export async function authenticateKey(header: string | undefined): Promise<CallContext | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) return null;
  const { rows } = await pool.query<{ id: number; user_id: number; email: string; kind: "user" | "chat" }>(
    `SELECT k.id, k.user_id, u.email, k.kind FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())`,
    [sha256(m[1])],
  );
  if (!rows[0]) return null;
  const k = rows[0];
  void pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [k.id]).catch(() => {});
  return { userId: k.user_id, email: k.email, apiKeyId: k.id, source: k.kind === "chat" ? "chat" : "mcp" };
}

function newServer(ctx: CallContext): Server {
  const server = new Server({ name: "switchyard-gateway", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: upstreams.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => executeToolCall(ctx, req.params.name, req.params.arguments ?? {}));
  return server;
}

// Close every open session opened with this key (cleanup after revoke; enforcement is the per-request check).
export function closeSessionsForKey(apiKeyId: number): void {
  for (const [id, s] of sessions) {
    if (s.ctx.apiKeyId === apiKeyId) {
      sessions.delete(id);
      void s.transport.close();
    }
  }
}

upstreams.on("toolsChanged", () => {
  for (const s of sessions.values()) void s.server.sendToolListChanged().catch(() => {});
});

setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) {
      sessions.delete(id);
      void s.transport.close();
    }
  }
}, 60_000).unref();

async function handle(req: Request, res: Response): Promise<void> {
  if (!originAllowed(req.headers.origin, allowedOrigins)) {
    rpcError(res, 403, `Origin ${req.headers.origin} is not allowed to call /mcp.`);
    return;
  }
  const ctx = await authenticateKey(req.headers.authorization);
  if (!ctx) {
    res.set("WWW-Authenticate", 'Bearer realm="switchyard"');
    rpcError(res, 401, "Invalid, revoked or missing API key. Create one in the Switchyard dashboard.");
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return void rpcError(res, 404, "Session not found; re-initialize.");
    if (s.ctx.apiKeyId !== ctx.apiKeyId) return void rpcError(res, 403, "This session belongs to a different API key.");
    s.lastSeen = Date.now();
    await s.transport.handleRequest(req, res, req.body);
    return;
  }

  if (req.method !== "POST" || !isInitializeRequest(req.body)) {
    return void rpcError(res, 400, "Missing Mcp-Session-Id; the first request must be initialize.");
  }

  const server = newServer(ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server, ctx, lastSeen: Date.now() });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

export function mcpRouter(): Router {
  const r = express.Router();
  r.use(express.json({ limit: "4mb" }));
  r.all("/", (req, res) => {
    handle(req, res).catch((err) => {
      console.error("/mcp error:", err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    });
  });
  return r;
}
