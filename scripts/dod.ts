// Definition-of-Done checks (docs/ASSIGNMENT.md) against a running Switchyard install.
//
//   make dod                 # all checks
//   make dod ONLY=3,6        # some checks
//
// User A = the seeded admin (uses the dashboard chat), user B = the seeded member (uses an external
// MCP client: this script, via the MCP TypeScript SDK). Every check prints PASS/FAIL plus evidence.
// Shared state (A's product, a storefront order, B's key) is created lazily by the first check that
// needs it, so any check can run on its own. Exit code 0 only if every selected check passed.
//
// Env: ADMIN_EMAIL/PASSWORD, MEMBER_EMAIL/PASSWORD (make dod reads them from the gateway Secret),
// optional YARD_URL, MCP_URL, SHOP_URL, ONLY, ORDER_ID, PRODUCT_ID.
// Runs as TypeScript with Node's type stripping (default in Node 24).
import { execSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const env = (k: string, d?: string): string => {
  const v = process.env[k] || d;
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const YARD = env("YARD_URL", "http://yard.localtest.me");
const MCP = env("MCP_URL", "http://mcp.localtest.me/mcp");
const SHOP = env("SHOP_URL", "http://shop.localtest.me");
const ADMIN = { email: env("ADMIN_EMAIL", "admin@switchyard.local"), password: env("ADMIN_PASSWORD") };
const MEMBER = { email: env("MEMBER_EMAIL", "member@switchyard.local"), password: env("MEMBER_PASSWORD") };

// ---------- helpers ----------
type Api = (path: string, method?: string, body?: unknown) => Promise<{ status: number; body: any }>;
interface ToolCall { name: string; arguments: unknown; ok: boolean; durationMs: number; result: string }
interface ChatReply { reply: string; toolCalls?: ToolCall[]; error?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: unknown, n = 200) => String(s).replace(/\s+/g, " ").slice(0, n);
const text = (r: CallToolResult) => (r.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");

async function login(email: string, password: string): Promise<Api> {
  const r = await fetch(`${YARD}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`login ${email}: HTTP ${r.status}`);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (path, method = "GET", body) => {
    const x = await fetch(`${YARD}/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: x.status, body: await x.json().catch(() => ({})) };
  };
}

class ExternalClient {
  changed = 0; // notifications/tools/list_changed received
  client = new Client({ name: "switchyard-dod", version: "1.0.0" });
  static async connect(key: string): Promise<ExternalClient> {
    const c = new ExternalClient();
    c.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void c.changed++);
    await c.client.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    return c;
  }
  async names(): Promise<string[]> {
    return (await this.client.listTools()).tools.map((t) => t.name);
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return (await this.client.callTool({ name, arguments: args })) as CallToolResult;
  }
}

async function chat(api: Api, prompt: string): Promise<ChatReply> {
  return (await api("/chat", "POST", { messages: [{ role: "user", content: prompt }] })).body;
}
const describeCalls = (c: ChatReply) =>
  ((c.toolCalls ?? []).map((t) => `${t.name}(${short(JSON.stringify(t.arguments), 80)}) ${t.ok ? "ok" : "ERR"} ${t.durationMs}ms`).join("; ") || "none") +
  (c.error ? ` | chat error: ${short(c.error, 160)}` : "");

// A storefront checkout through the WooCommerce Store API: the same cart -> checkout calls the
// block checkout page makes in a browser, paying with Cash on Delivery.
async function storefrontOrder(productId: number): Promise<number> {
  const url = (route: string) => `${SHOP}/?rest_route=/wc/store/v1/${route}`;
  let r = await fetch(url("cart"));
  const headers = { "content-type": "application/json", "cart-token": r.headers.get("cart-token") ?? "", nonce: r.headers.get("nonce") ?? "" };
  r = await fetch(url("cart/add-item"), { method: "POST", headers, body: JSON.stringify({ id: productId, quantity: 1 }) });
  if (!r.ok) throw new Error(`add-item HTTP ${r.status}: ${short(await r.text())}`);
  const addr = { first_name: "Dod", last_name: "Buyer", address_1: "1 MG Road", city: "Bengaluru", state: "KA", postcode: "560001", country: "IN", email: "dod.buyer@example.com", phone: "9999999999" };
  r = await fetch(url("checkout"), { method: "POST", headers, body: JSON.stringify({ billing_address: addr, shipping_address: addr, payment_method: "cod" }) });
  const body: any = await r.json();
  if (!r.ok) throw new Error(`checkout HTTP ${r.status}: ${short(JSON.stringify(body))}`);
  return body.order_id;
}

// ---------- shared, lazily created state ----------
const A = await login(ADMIN.email, ADMIN.password);
const B = await login(MEMBER.email, MEMBER.password);
const runStarted = Date.now();
const stamp = runStarted.toString(36);
const state: { productId?: number; productName: string; orderId?: number; keyB?: string; clientB?: ExternalClient } = {
  productId: process.env.PRODUCT_ID ? Number(process.env.PRODUCT_ID) : undefined,
  productName: `DoD Lamp ${stamp}`,
  orderId: process.env.ORDER_ID ? Number(process.env.ORDER_ID) : undefined,
};

async function clientB(fresh = false): Promise<ExternalClient> {
  if (!state.clientB || fresh) {
    state.keyB = (await B("/keys", "POST", { name: `dod ${stamp}` })).body.key;
    state.clientB = await ExternalClient.connect(state.keyB!);
  }
  return state.clientB;
}
async function orderId(): Promise<number> {
  if (!state.orderId) {
    // Prefer the product A created in check 1; otherwise any product in the store.
    let pid = state.productId;
    if (!pid) pid = JSON.parse(text(await (await clientB()).call("woo__list_products", { per_page: 1 }))).products[0].id as number;
    state.orderId = await storefrontOrder(pid);
  }
  return state.orderId;
}

// ---------- checks ----------
interface Check { n: number; name: string; run: () => Promise<{ pass: boolean; evidence: string[] }> }
const checks: Check[] = [];

checks.push({
  n: 1,
  name: "chat as A creates a product; it appears on the storefront",
  async run() {
    const c = await chat(A, `Create a product named "${state.productName}" priced at 799 rupees.`);
    const created = c.toolCalls?.find((t) => t.name === "woo__create_product" && t.ok);
    const id: number | undefined = created ? JSON.parse(created.result).created?.id : undefined;
    // ?post_type=product&p=<id> redirects to the product's permalink on the public storefront.
    const page = id ? await fetch(`${SHOP}/?post_type=product&p=${id}`) : undefined;
    const onStorefront = Boolean(page?.ok && (await page.text()).includes(state.productName));
    if (id) state.productId = id;
    return {
      pass: Boolean(id) && onStorefront,
      evidence: [`tool calls: ${describeCalls(c)}`, `reply: ${short(c.reply)}`, `storefront ${page?.url ?? "-"} -> HTTP ${page?.status ?? "-"}, shows "${state.productName}": ${onStorefront}`],
    };
  },
});

checks.push({
  n: 2,
  name: "storefront order, then chat as A: what orders came in today?",
  async run() {
    const id = await orderId();
    const c = await chat(A, "What orders came in today?");
    const listed = c.toolCalls?.find((t) => t.name === "woo__list_orders" && t.ok);
    return {
      pass: Boolean(listed?.result.includes(`"id": ${id}`)) && c.reply.includes(String(id)),
      evidence: [`storefront checkout (Store API, Cash on Delivery) -> order #${id}`, `tool calls: ${describeCalls(c)}`, `reply: ${short(c.reply, 300)}`],
    };
  },
});

checks.push({
  n: 3,
  name: "B's external MCP client (gateway URL + own key only) sees tools from all 3 servers",
  async run() {
    const names = await (await clientB()).names();
    const per = ["woo", "shipping", "everything"].map((s) => [s, names.filter((n) => n.startsWith(`${s}__`)).length] as const);
    return {
      pass: per.every(([, count]) => count > 0) && names.includes("woo__search") && names.includes("shipping__search"),
      evidence: [`${MCP}: ${names.length} tools (${per.map(([s, n]) => `${s} ${n}`).join(", ")})`, `same upstream name, no collision: ${names.filter((n) => n.endsWith("__search")).join(", ")}`],
    };
  },
});

checks.push({
  n: 4,
  name: "B asks today's orders through the external client",
  async run() {
    const id = await orderId();
    const r = await (await clientB()).call("woo__list_orders", { date: "today" });
    const t = text(r);
    return { pass: !r.isError && t.includes(`"id": ${id}`), evidence: [`expects order #${id}`, `woo__list_orders {date:"today"} -> ${short(t, 260)}`] };
  },
});

checks.push({
  n: 5,
  name: "one prompt that needs two upstream servers (woo + shipping)",
  async run() {
    const id = await orderId();
    // As B's external client: the two calls a model would make for this prompt.
    const b = await clientB();
    const order = await b.call("woo__get_order", { id });
    const quote = await b.call("shipping__quote_shipping", { destination: "560001", weight_kg: 1, service: "express" });
    // And as one natural-language prompt through the chat agent (as B).
    const c = await chat(B, `Look up order ${id} and quote express shipping for it to PIN 560001, weight 1 kg.`);
    const servers = new Set((c.toolCalls ?? []).filter((t) => t.ok).map((t) => t.name.split("__")[0]));
    return {
      pass: !order.isError && !quote.isError && servers.has("woo") && servers.has("shipping"),
      evidence: [
        `external client: woo__get_order -> ${short(text(order), 80)} | shipping__quote_shipping -> ${short(text(quote), 80)}`,
        `chat as B, one prompt: ${describeCalls(c)}`,
        `reply: ${short(c.reply)}`,
      ],
    };
  },
});

checks.push({
  n: 6,
  name: "admin revokes B's key; B's next call (same open session) is rejected",
  async run() {
    const b = await clientB();
    const before = await b.call("woo__list_products", { per_page: 1 });
    const users = (await A("/users")).body as { email: string; keys: { id: number; name: string; revoked_at: string | null }[] }[];
    const key = users.find((u) => u.email === MEMBER.email)?.keys.find((k) => !k.revoked_at && k.name === `dod ${stamp}`);
    const rev = await A(`/keys/${key?.id}`, "DELETE");
    let after: string;
    let rejected = false;
    try {
      await b.call("woo__list_products", { per_page: 1 });
      after = "call SUCCEEDED after revoke";
    } catch (err) {
      rejected = err instanceof StreamableHTTPError && err.code === 401;
      after = `rejected: HTTP ${(err as StreamableHTTPError).code} ${short((err as Error).message, 140)}`;
    }
    await b.client.close().catch(() => {}); // stop the revoked client's stream retries
    state.clientB = undefined; // later checks need a fresh key
    // The rejected attempt is audited too: outcome 'denied', under B.
    type Row = { ts: string; user_email: string; tool: string; outcome: string; error: string | null };
    const denied = ((await A("/audit")).body as Row[]).find(
      (r) => new Date(r.ts).getTime() >= runStarted - 5_000 && r.user_email === MEMBER.email && r.outcome === "denied" && r.tool === "woo__list_products",
    );
    return {
      pass: !before.isError && rev.status === 200 && rejected && denied?.error === "API key revoked",
      evidence: [
        `before revoke: woo__list_products ${before.isError ? "ERROR" : "ok"}`,
        `admin DELETE /api/keys/${key?.id} -> ${rev.status}`,
        after,
        `audit: ${denied ? `${denied.ts} ${denied.user_email} ${denied.tool} ${denied.outcome} (${denied.error})` : "no 'denied' row for B"}`,
      ],
    };
  },
});

checks.push({
  n: 7,
  name: "admin disables shipping; its tools disappear from the external client and from chat",
  async run() {
    const b = await clientB();
    const shippingTools = async () => (await b.names()).filter((n) => n.startsWith("shipping__")).length;
    const before = await shippingTools();
    const ship = ((await A("/servers")).body as { id: number; slug: string }[]).find((s) => s.slug === "shipping")!;
    const dis = await A(`/servers/${ship.id}`, "PATCH", { enabled: false });
    try {
      await sleep(1000); // let list_changed reach the client
      const after = await shippingTools();
      const direct = await b.call("shipping__list_zones");
      const c = await chat(A, "Quote standard shipping to PIN 110001 for 2 kg. If you have no shipping tool, say so.");
      const chatShipping = (c.toolCalls ?? []).filter((t) => t.name.startsWith("shipping__") && t.ok).length;
      return {
        // The chat must actually answer: "no shipping call" only counts if the LLM ran.
        pass: dis.body.status === "disabled" && before > 0 && after === 0 && Boolean(direct.isError) && !c.error && chatShipping === 0,
        evidence: [
          `PATCH enabled=false -> ${dis.body.status}; list_changed notifications at B: ${b.changed}`,
          `B's shipping tools: ${before} before, ${after} after; direct call -> ${short(text(direct), 90)}`,
          `chat while disabled: tool calls ${describeCalls(c)}; reply: ${short(c.reply, 140)}`,
        ],
      };
    } finally {
      const en = await A(`/servers/${ship.id}`, "PATCH", { enabled: true });
      console.log(`    (shipping re-enabled -> ${en.body.status})`);
    }
  },
});

checks.push({
  n: 8,
  name: "everything-mcp pod killed: woo keeps working, dashboard shows it Unreachable",
  async run() {
    type Srv = { slug: string; status: string; reason: string | null };
    const everything = async () => ((await A("/servers")).body as Srv[]).find((s) => s.slug === "everything")!;
    // On a loaded laptop the kube API sometimes times out (TLS handshake timeout). Retry, so a
    // blip can't leave everything-mcp scaled to 0 after the check.
    const kubectl = async (args: string): Promise<string> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return execSync(`kubectl --request-timeout=10s ${args}`, { stdio: "pipe" }).toString().trim();
        } catch (err) {
          if (attempt >= 5) throw err;
          await sleep(3000);
        }
      }
    };
    // Scale to 0 rather than delete the pod: a Deployment would recreate a deleted pod within
    // seconds, possibly before the 15 s health check notices it was gone.
    await kubectl("scale deploy/everything-mcp -n mcp --replicas=0");
    try {
      await kubectl("wait --for=delete pod -l app.kubernetes.io/name=everything-mcp -n mcp --timeout=60s");
      let ev = await everything();
      for (let i = 0; i < 30 && ev.status !== "unreachable"; i++) {
        await sleep(1000);
        ev = await everything();
      }
      const b = await clientB();
      const woo = await b.call("woo__list_products", { per_page: 1 });
      const dead = await b.call("everything__echo", { message: "hi" });
      return {
        pass: ev.status === "unreachable" && !woo.isError && Boolean(dead.isError),
        evidence: [`everything-mcp scaled to 0; dashboard /api/servers -> ${ev.status} (${ev.reason})`, `woo__list_products -> ${woo.isError ? "ERROR" : "ok"}`, `everything__echo -> ${short(text(dead), 150)}`],
      };
    } finally {
      await kubectl("scale deploy/everything-mcp -n mcp --replicas=1");
      let ev = await everything();
      for (let i = 0; i < 60 && ev.status !== "connected"; i++) {
        await sleep(2000);
        ev = await everything();
      }
      console.log(`    (everything-mcp scaled back to 1 -> ${ev.status})`);
    }
  },
});

checks.push({
  n: 9,
  name: "every call above is in the audit log, attributed to the right user",
  async run() {
    type Row = { ts: string; user_email: string; source: string; tool: string; duration_ms: number; outcome: string };
    const since = runStarted - 5_000; // small allowance for clock skew with the gateway
    let rows = ((await A("/audit")).body as Row[]).filter((r) => new Date(r.ts).getTime() >= since);
    const of = (email: string, source: string) => rows.filter((r) => r.user_email === email && r.source === source);
    if (!of(ADMIN.email, "chat").length || !of(MEMBER.email, "mcp").length) {
      // Run on its own: make one chat call as A and one MCP call as B first.
      await chat(A, "How many products does the store have? Use list_products with per_page 5.");
      await (await clientB()).call("woo__list_products", { per_page: 1 });
      rows = ((await A("/audit")).body as Row[]).filter((r) => new Date(r.ts).getTime() >= since);
    }
    const aChat = of(ADMIN.email, "chat");
    const bMcp = of(MEMBER.email, "mcp");
    const memberView = (await B("/audit")).body as Row[];
    const complete = rows.every((r) => r.user_email && r.tool && Number.isFinite(r.duration_ms) && ["ok", "error", "denied"].includes(r.outcome));
    return {
      pass: aChat.length > 0 && bMcp.length > 0 && complete && memberView.every((r) => r.user_email === MEMBER.email),
      evidence: [
        `this run: ${rows.length} rows; A (${ADMIN.email}) via chat: ${aChat.length}; B (${MEMBER.email}) via mcp: ${bMcp.length}`,
        `every row has user, tool, duration and outcome: ${complete}; B's own audit view contains only B: ${memberView.every((r) => r.user_email === MEMBER.email)}`,
        ...rows.slice(0, 6).map((r) => `${r.ts} ${r.user_email} ${r.source} ${r.tool} ${r.duration_ms}ms ${r.outcome}`),
      ],
    };
  },
});

// ---------- runner ----------
const only = (process.env.ONLY ?? "").split(",").map((s) => Number(s.trim())).filter(Boolean);
const selected = checks.filter((c) => !only.length || only.includes(c.n));
const results: { n: number; pass: boolean }[] = [];
for (const c of selected) {
  let out: { pass: boolean; evidence: string[] };
  try {
    out = await c.run();
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    out = { pass: false, evidence: [`threw: ${short((err as Error).message, 300)}${cause ? ` (cause: ${cause.code ?? ""} ${short(cause.message ?? "", 160)})` : ""}`] };
  }
  results.push({ n: c.n, pass: out.pass });
  console.log(`\n[${out.pass ? "PASS" : "FAIL"}] ${c.n}. ${c.name}\n${out.evidence.map((e) => `    ${e}`).join("\n")}`);
}
console.log(`\nSUMMARY: ${results.map((r) => `${r.n}:${r.pass ? "PASS" : "FAIL"}`).join(" ") || "no checks selected"}`);
process.exit(results.length && results.every((r) => r.pass) ? 0 : 1);
