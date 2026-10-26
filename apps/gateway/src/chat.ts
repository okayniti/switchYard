// The chat agent. It is a real MCP client of the gateway's own /mcp: for each chat request it mints
// a short-lived 'chat' API key for the logged-in user, connects to /mcp with it, and revokes it when
// done. So the agent can only do what that user can do, and every call it makes goes through the
// same auth + executeToolCall + audit path as an external client (audit source = 'chat').
//
// The LLM is any OpenAI-compatible Chat Completions endpoint (Groq by default). The loop:
// list tools -> ask the model -> run the tool calls it asks for -> feed results back -> repeat,
// at most MAX_ITERATIONS times.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SessionUser } from "./auth.js";
import { config } from "./config.js";
import { newApiKey } from "./crypto.js";
import { pool } from "./db.js";

const MAX_ITERATIONS = 8;
const RESULT_CHARS = 4000;

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ToolCallRecord {
  name: string;
  arguments: unknown;
  ok: boolean;
  durationMs: number;
  result: string;
}

// LLM providers reject some JSON Schema keywords; keep the tool schema plain.
function sanitize(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitize);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) if (k !== "$schema") out[k] = sanitize(v);
  return out;
}

function systemPrompt(): string {
  const now = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "full", timeStyle: "short" }).format(new Date());
  return [
    "You are the Switchyard team assistant. You answer by calling the tools provided; do not guess store data.",
    "Tool names are <server>__<tool>, e.g. woo__list_orders is the WooCommerce store, shipping__quote_shipping is shipping rates.",
    `The current date and time is ${now} (Asia/Kolkata). For "today", pass date "today" to woo__list_orders.`,
    "Prices are in INR. Keep answers short and mention the IDs of anything you created or changed.",
  ].join("\n");
}

// How long a 429 asks us to wait: the Retry-After header (seconds), else the "try again in
// 1m2.5s / 172.5ms" hint free tiers such as Groq put in the message; clamped to 0.25-20 s.
export function retryDelayMs(retryAfter: string | null, body: string): number {
  let ms = 2_000;
  if (retryAfter && Number.isFinite(Number(retryAfter))) ms = Number(retryAfter) * 1000;
  else {
    const m = /try again in (?:(\d+)m)?(?:([\d.]+)s)?(?:([\d.]+)ms)?/i.exec(body);
    if (m && (m[1] || m[2] || m[3])) ms = Number(m[1] ?? 0) * 60_000 + Number(m[2] ?? 0) * 1000 + Number(m[3] ?? 0);
  }
  return Math.min(Math.max(Math.ceil(ms), 250), 20_000);
}

const MAX_429_RETRIES = 3;
const MAX_429_WAIT_MS = 30_000;

async function callLlm(messages: ChatMessage[], tools: unknown[]): Promise<ChatMessage> {
  let res: globalThis.Response;
  let text: string;
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${config.llm.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.llm.apiKey}` },
        body: JSON.stringify({ model: config.llm.model, messages, tools: tools.length ? tools : undefined, tool_choice: tools.length ? "auto" : undefined, temperature: 0.2 }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new Error(`LLM provider unreachable: ${(err as Error).message}`);
    }
    text = await res.text();
    // Free tiers rate-limit per minute; a short wait usually clears it. Bounded so a request
    // never hangs: at most MAX_429_RETRIES retries and MAX_429_WAIT_MS of waiting in total.
    if (res.status !== 429 || attempt >= MAX_429_RETRIES) break;
    const delay = retryDelayMs(res.headers.get("retry-after"), text);
    if (waited + delay > MAX_429_WAIT_MS) break;
    waited += delay;
    console.warn(`LLM rate limited (429); retrying in ${delay} ms`);
    await new Promise((r) => setTimeout(r, delay));
  }
  if (!res.ok) {
    const hint = res.status === 429 ? " (rate limited; wait a minute and retry)" : res.status === 401 ? " (check LLM_API_KEY)" : "";
    throw new Error(`LLM returned HTTP ${res.status}${hint}: ${text.slice(0, 300)}`);
  }
  const msg = JSON.parse(text).choices?.[0]?.message;
  if (!msg) throw new Error("LLM response had no message");
  return { role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined };
}

export async function chat(user: SessionUser, input: unknown): Promise<{ reply: string; toolCalls: ToolCallRecord[]; error?: string }> {
  const toolCalls: ToolCallRecord[] = [];
  if (!config.llm.apiKey) return { reply: "", toolCalls, error: "Chat is not configured: LLM_API_KEY is not set on the gateway." };
  const history = (Array.isArray(input) ? input : [])
    .filter((m): m is { role: "user" | "assistant"; content: string } => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string")
    .slice(-20);
  if (!history.length || history[history.length - 1].role !== "user") return { reply: "", toolCalls, error: "Send at least one user message." };

  // Short-lived key for this user, used only by this request.
  const k = newApiKey();
  const { rows } = await pool.query(
    "INSERT INTO api_keys (user_id, name, prefix, key_hash, kind, expires_at) VALUES ($1, 'chat agent', $2, $3, 'chat', now() + interval '10 minutes') RETURNING id",
    [user.id, k.prefix, k.hash],
  );
  const client = new Client({ name: "switchyard-chat", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(config.selfMcpUrl), { requestInit: { headers: { Authorization: `Bearer ${k.key}` } } }));
    const { tools } = await client.listTools();
    const llmTools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: (t.description ?? "").slice(0, 1000), parameters: sanitize(t.inputSchema) },
    }));

    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt() }, ...history];
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const msg = await callLlm(messages, llmTools);
      messages.push(msg);
      if (!msg.tool_calls) return { reply: msg.content ?? "", toolCalls };
      for (const tc of msg.tool_calls) {
        const started = Date.now();
        let args: Record<string, unknown> = {};
        let text: string;
        let ok = false;
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          const r = await client.callTool({ name: tc.function.name, arguments: args }, undefined, { timeout: config.toolTimeoutMs + 2000 });
          const content = (r.content as { type: string; text?: string }[]) ?? [];
          text = content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
          ok = !r.isError;
        } catch (err) {
          text = `Tool call failed: ${(err as Error).message}`;
        }
        toolCalls.push({ name: tc.function.name, arguments: args, ok, durationMs: Date.now() - started, result: text.slice(0, 1500) });
        messages.push({ role: "tool", tool_call_id: tc.id, content: text.slice(0, RESULT_CHARS) });
      }
    }
    return { reply: "I stopped after the maximum number of tool-calling steps. Here is what I did so far.", toolCalls };
  } catch (err) {
    return { reply: "", toolCalls, error: (err as Error).message };
  } finally {
    await client.close().catch(() => {});
    await pool.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1", [rows[0].id]);
  }
}
