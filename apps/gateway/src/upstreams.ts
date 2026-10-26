// UpstreamManager: the gateway's client side. One long-lived MCP Client per enabled upstream.
// Upstream credentials are decrypted and attached to requests only here.
//
// Every HEALTH_INTERVAL_MS each upstream is checked with tools/list (5 s timeout). Success means
// Connected and refreshes its tool snapshot; failure means Unreachable with a reason, and the
// client is thrown away so the next check re-initializes from scratch. That is also how we
// recover when an upstream pod restarts and our MCP session id stops being valid.
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError, ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { decrypt } from "./crypto.js";
import { pool } from "./db.js";

export type Status = "connected" | "unreachable" | "disabled";

export interface ServerRow {
  id: number;
  slug: string;
  name: string;
  url: string;
  auth_type: "none" | "bearer" | "header";
  auth_header: string | null;
  credential_enc: string | null;
  enabled: boolean;
  updated_at: Date;
}

interface Upstream {
  row: ServerRow;
  client?: Client;
  status: Status;
  reason: string | null;
  lastChecked: Date | null;
  tools: Tool[];
}

// A tool as the gateway exposes it: `<slug>__<tool>` plus where to route it.
export interface GatewayTool {
  name: string;
  slug: string;
  upstreamName: string;
  tool: Tool;
}

const CHECK_TIMEOUT_MS = 5_000;
const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// Namespacing scheme: always `<slug>__<tool>`, so names are stable when servers are added.
// If that exceeds 64 chars (or has odd characters), truncate and add a short hash.
export function exposedName(slug: string, tool: string): string {
  const name = `${slug}__${tool}`;
  if (NAME_RE.test(name)) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${slug}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 55) + `_${hash}`;
}

function describeError(err: unknown): string {
  if (err instanceof StreamableHTTPError) {
    if (err.code === 401 || err.code === 403) return `rejected credentials (HTTP ${err.code})`;
    if (err.code === 404) return "session expired or wrong path (HTTP 404)";
    return `HTTP ${err.code}`;
  }
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code;
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS lookup failed";
  if (code === "ECONNRESET") return "connection reset";
  if (/timed out|timeout/i.test(e?.message ?? "")) return "timed out";
  return e?.cause?.message ?? e?.message ?? String(err);
}

export class UpstreamManager extends EventEmitter {
  private upstreams = new Map<string, Upstream>();
  private catalog = new Map<string, GatewayTool>();
  private catalogKey = "";
  private timer?: NodeJS.Timeout;

  start(): void {
    void this.reload();
    this.timer = setInterval(() => void this.checkAll(), config.healthIntervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    for (const u of this.upstreams.values()) void u.client?.close();
  }

  // Sync in-memory state with the servers table (after startup and after every admin change).
  async reload(): Promise<void> {
    const rows = (await pool.query<ServerRow>("SELECT * FROM servers ORDER BY slug")).rows;
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.slug);
      const cur = this.upstreams.get(row.slug);
      if (cur && cur.row.updated_at.getTime() === row.updated_at.getTime()) continue;
      void cur?.client?.close();
      this.upstreams.set(row.slug, {
        row,
        status: row.enabled ? "unreachable" : "disabled",
        reason: row.enabled ? "connecting" : null,
        lastChecked: null,
        tools: [],
      });
    }
    for (const [slug, u] of this.upstreams) {
      if (!seen.has(slug)) {
        void u.client?.close();
        this.upstreams.delete(slug);
      }
    }
    this.rebuildCatalog();
    await this.checkAll();
  }

  private async checkAll(): Promise<void> {
    await Promise.all([...this.upstreams.values()].map((u) => this.check(u)));
    this.rebuildCatalog();
  }

  private headers(row: ServerRow): Record<string, string> {
    if (row.auth_type === "none" || !row.credential_enc) return {};
    const secret = decrypt(row.credential_enc);
    if (row.auth_type === "bearer") return { Authorization: `Bearer ${secret}` };
    return { [row.auth_header || "X-Api-Key"]: secret };
  }

  private async connect(u: Upstream): Promise<Client> {
    const client = new Client({ name: "switchyard-gateway", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(u.row.url), {
      requestInit: { headers: this.headers(u.row), redirect: "manual" },
    });
    // If the upstream says its tools changed, refresh now instead of waiting for the next tick.
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.check(u);
      this.rebuildCatalog();
    });
    await client.connect(transport, { timeout: CHECK_TIMEOUT_MS });
    return client;
  }

  private markDown(u: Upstream, err: unknown): void {
    u.status = "unreachable";
    u.reason = describeError(err);
    u.tools = [];
    void u.client?.close().catch(() => {});
    u.client = undefined;
  }

  private async check(u: Upstream): Promise<void> {
    if (!u.row.enabled) {
      Object.assign(u, { status: "disabled", reason: null, tools: [], lastChecked: new Date() });
      return;
    }
    try {
      u.client ??= await this.connect(u);
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await u.client.listTools(cursor ? { cursor } : undefined, { timeout: CHECK_TIMEOUT_MS });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      Object.assign(u, { status: "connected", reason: null, tools });
    } catch (err) {
      if (u.status !== "unreachable" || u.reason !== describeError(err)) console.warn(`upstream ${u.row.slug} unreachable: ${describeError(err)}`);
      this.markDown(u, err);
    }
    u.lastChecked = new Date();
  }

  // The union of tools from enabled + Connected servers. Emits "toolsChanged" when the set changes,
  // which /mcp turns into notifications/tools/list_changed for every open client session.
  private rebuildCatalog(): void {
    const next = new Map<string, GatewayTool>();
    for (const u of this.upstreams.values()) {
      if (u.status !== "connected") continue;
      for (const tool of u.tools) {
        const name = exposedName(u.row.slug, tool.name);
        next.set(name, { name, slug: u.row.slug, upstreamName: tool.name, tool });
      }
    }
    const key = [...next.keys()].sort().join(",");
    this.catalog = next;
    if (key !== this.catalogKey) {
      this.catalogKey = key;
      this.emit("toolsChanged");
    }
  }

  listTools(): Tool[] {
    return [...this.catalog.values()].map((t) => {
      const u = this.upstreams.get(t.slug)!;
      return { ...t.tool, name: t.name, description: `[${u.row.name}] ${t.tool.description ?? ""}`.trim() };
    });
  }

  resolve(name: string): GatewayTool | undefined {
    return this.catalog.get(name);
  }

  // Why a tool name isn't routable right now, for a clear error message.
  explainMissing(name: string): string {
    const slug = name.split("__")[0];
    const u = this.upstreams.get(slug);
    if (!u) return `Unknown tool '${name}'. Tool names are <server>__<tool>; list tools to see what is available.`;
    if (u.status === "disabled") return `Server '${slug}' is disabled by an admin.`;
    if (u.status === "unreachable") return `Server '${slug}' is unreachable (${u.reason}, last checked ${u.lastChecked?.toISOString() ?? "never"}). Other servers are unaffected.`;
    return `Server '${slug}' has no tool named '${name.slice(slug.length + 2)}'.`;
  }

  async callTool(t: GatewayTool, args: Record<string, unknown>): Promise<CallToolResult> {
    const u = this.upstreams.get(t.slug);
    if (!u?.client) throw new Error(this.explainMissing(t.name));
    try {
      return (await u.client.callTool({ name: t.upstreamName, arguments: args }, undefined, { timeout: config.toolTimeoutMs })) as CallToolResult;
    } catch (err) {
      // A 404 means the upstream restarted and forgot our session; the call never ran, so it is
      // safe to reconnect and retry once. Anything else is reported, not retried (could be a write).
      if (err instanceof StreamableHTTPError && err.code === 404) {
        void u.client.close().catch(() => {});
        u.client = await this.connect(u);
        return (await u.client.callTool({ name: t.upstreamName, arguments: args }, undefined, { timeout: config.toolTimeoutMs })) as CallToolResult;
      }
      // A JSON-RPC error (bad arguments, timeout) means the upstream is alive; only transport
      // failures mark it down.
      if (!(err instanceof McpError)) this.markDown(u, err);
      throw err;
    }
  }

  // For the dashboard: status of every server, never the credential.
  snapshot() {
    return [...this.upstreams.values()].map((u) => ({
      id: u.row.id,
      slug: u.row.slug,
      name: u.row.name,
      url: u.row.url,
      authType: u.row.auth_type,
      authHeader: u.row.auth_header,
      hasCredential: Boolean(u.row.credential_enc),
      enabled: u.row.enabled,
      status: u.status,
      reason: u.reason,
      lastChecked: u.lastChecked,
      tools: u.tools.map((t) => ({ name: exposedName(u.row.slug, t.name), description: t.description ?? "" })),
    }));
  }
}

export const upstreams = new UpstreamManager();
