// The MCP tools. Each returns a trimmed JSON view of WooCommerce data (full WC payloads are huge and
// waste model context). Errors thrown here become `isError: true` tool results via the SDK.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { dayRange } from "./dates.js";
import { WcClient } from "./wc.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Wc = Record<string, any>;

const product = (p: Wc) => ({
  id: p.id,
  name: p.name,
  status: p.status,
  sku: p.sku,
  price: p.price,
  regular_price: p.regular_price,
  stock_status: p.stock_status,
  stock_quantity: p.stock_quantity,
  permalink: p.permalink,
});

const order = (o: Wc) => ({
  id: o.id,
  status: o.status,
  date_created: o.date_created,
  date_created_gmt: o.date_created_gmt,
  total: o.total,
  currency: o.currency,
  customer: [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(" ") || null,
  email: o.billing?.email || null,
  payment_method: o.payment_method_title,
  items: (o.line_items ?? []).map((li: Wc) => ({ product_id: li.product_id, name: li.name, quantity: li.quantity, total: li.total })),
});

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] as const;

export function registerTools(server: McpServer, wc: WcClient, tz: string): void {
  server.registerTool(
    "list_products",
    {
      description: "List products in the WooCommerce store. Optionally filter by a search term or status.",
      inputSchema: {
        search: z.string().optional().describe("Text to match in product name/description"),
        status: z.enum(["any", "publish", "draft", "pending", "private"]).optional().describe("Default: any"),
        per_page: z.number().int().min(1).max(100).optional().describe("Default 20"),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ search, status, per_page, page }) => {
      const rows = await wc.request<Wc[]>("GET", "/wc/v3/products", { search, status: status ?? "any", per_page: per_page ?? 20, page });
      return json({ count: rows.length, products: rows.map(product) });
    },
  );

  server.registerTool(
    "create_product",
    {
      description: "Create a simple product. It is published (visible on the storefront) unless status is set to draft.",
      inputSchema: {
        name: z.string().min(1),
        regular_price: z.union([z.string(), z.number()]).describe("Price in store currency, e.g. 499 or \"499.00\""),
        description: z.string().optional(),
        sku: z.string().optional(),
        stock_quantity: z.number().int().min(0).optional().describe("If set, stock is managed"),
        status: z.enum(["publish", "draft"]).optional().describe("Default: publish"),
      },
    },
    async ({ name, regular_price, description, sku, stock_quantity, status }) => {
      const body: Wc = { name, type: "simple", regular_price: String(regular_price), status: status ?? "publish" };
      if (description) body.description = description;
      if (sku) body.sku = sku;
      if (stock_quantity !== undefined) Object.assign(body, { manage_stock: true, stock_quantity });
      const p = await wc.request<Wc>("POST", "/wc/v3/products", {}, body);
      return json({ created: product(p) });
    },
  );

  server.registerTool(
    "list_orders",
    {
      description: `List orders, newest first. Use date "today" for orders placed today (store time zone ${tz}).`,
      inputSchema: {
        date: z.string().optional().describe(`"today", "yesterday" or YYYY-MM-DD, in ${tz}`),
        status: z.enum(["any", ...ORDER_STATUSES]).optional().describe("Default: any"),
        per_page: z.number().int().min(1).max(100).optional().describe("Default 20"),
      },
    },
    async ({ date, status, per_page }) => {
      const range = date ? dayRange(date, tz) : undefined;
      const rows = await wc.request<Wc[]>("GET", "/wc/v3/orders", {
        status: status ?? "any",
        per_page: per_page ?? 20,
        orderby: "date",
        order: "desc",
        ...(range ? { after: range.after, before: range.before, dates_are_gmt: true } : {}),
      });
      return json({ ...(range ? { date: range.date, timezone: tz } : {}), count: rows.length, orders: rows.map(order) });
    },
  );

  server.registerTool(
    "get_order",
    {
      description: "Get one order by its ID, including line items and customer.",
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => json(order(await wc.request<Wc>("GET", `/wc/v3/orders/${id}`))),
  );

  server.registerTool(
    "update_order_status",
    {
      description: "Change an order's status (e.g. processing -> completed).",
      inputSchema: { id: z.number().int().positive(), status: z.enum(ORDER_STATUSES) },
    },
    async ({ id, status }) => {
      const o = await wc.request<Wc>("PUT", `/wc/v3/orders/${id}`, {}, { status });
      return json({ updated: order(o) });
    },
  );

  server.registerTool(
    "search",
    {
      description: "Search the store's products and orders by free text (product name, SKU, customer name/email).",
      inputSchema: { query: z.string().min(1) },
    },
    async ({ query }) => {
      const [products, orders] = await Promise.all([
        wc.request<Wc[]>("GET", "/wc/v3/products", { search: query, status: "any", per_page: 10 }),
        wc.request<Wc[]>("GET", "/wc/v3/orders", { search: query, per_page: 10 }),
      ]);
      return json({ products: products.map(product), orders: orders.map(order) });
    },
  );
}
