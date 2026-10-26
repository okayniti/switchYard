import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

Object.assign(process.env, {
  DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
  GATEWAY_ENC_KEY: randomBytes(32).toString("base64"),
  ADMIN_EMAIL: "a@x", ADMIN_PASSWORD: "x", MEMBER_EMAIL: "m@x", MEMBER_PASSWORD: "x",
});
const { deniedCallLabel } = await import("../dist/mcp.js");

test("a denied tool call is labelled with its gateway tool name, server and args", () => {
  const body = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "woo__list_orders", arguments: { date: "today" } } };
  assert.deepEqual(deniedCallLabel(body), { tool: "woo__list_orders", serverSlug: "woo", args: '{"date":"today"}' });
});

test("other requests are labelled with their JSON-RPC method", () => {
  assert.deepEqual(deniedCallLabel({ method: "tools/list" }), { tool: "tools/list", serverSlug: null, args: null });
  assert.deepEqual(deniedCallLabel([{ method: "initialize" }, { method: "tools/list" }]), { tool: "initialize", serverSlug: null, args: null });
});

test("garbage bodies don't throw and are still labelled", () => {
  assert.equal(deniedCallLabel(undefined).tool, "(unknown request)");
  assert.equal(deniedCallLabel({ method: "tools/call", params: { name: 42 } }).tool, "tools/call");
  assert.equal(deniedCallLabel({ method: "tools/call", params: { name: "nounderscore" } }).serverSlug, null);
  assert.equal(deniedCallLabel({ method: "tools/call", params: { name: "x".repeat(500) } }).tool.length, 200);
});
