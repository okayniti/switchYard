// executeToolCall: the one path every tool call takes, whether it comes from an external MCP client
// or from the chat agent (which itself calls /mcp). It routes the call, turns every failure into a
// clear isError result, and writes exactly one audit_log row per call, whatever the outcome.
import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { pool } from "./db.js";
import { upstreams } from "./upstreams.js";

export interface CallContext {
  userId: number;
  email: string;
  apiKeyId: number;
  source: "mcp" | "chat";
}

const errorResult = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

export async function executeToolCall(ctx: CallContext, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const started = Date.now();
  const target = upstreams.resolve(name);
  let result: CallToolResult;
  let error: string | null = null;

  if (!target) {
    error = upstreams.explainMissing(name);
    result = errorResult(error);
  } else {
    try {
      result = await upstreams.callTool(target, args);
      if (result.isError) {
        const first = result.content?.[0];
        error = first?.type === "text" ? first.text.slice(0, 500) : "tool returned an error";
      }
    } catch (err) {
      if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
        error = `Tool '${name}' timed out after ${Date.now() - started} ms on server '${target.slug}'. Other servers are unaffected.`;
      } else {
        error = `Call to server '${target.slug}' failed: ${(err as Error).message}. Other servers are unaffected.`;
      }
      result = errorResult(error);
    }
  }

  await pool
    .query(
      `INSERT INTO audit_log (user_id, user_email, api_key_id, source, server_slug, tool, duration_ms, outcome, error, args_preview)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [ctx.userId, ctx.email, ctx.apiKeyId, ctx.source, target?.slug ?? name.split("__")[0], name, Date.now() - started, error ? "error" : "ok", error, JSON.stringify(args ?? {}).slice(0, 500)],
    )
    .catch((err) => console.error("audit write failed:", err));
  return result;
}
