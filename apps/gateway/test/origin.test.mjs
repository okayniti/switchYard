import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

Object.assign(process.env, {
  DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
  GATEWAY_ENC_KEY: randomBytes(32).toString("base64"),
  ADMIN_EMAIL: "a@x", ADMIN_PASSWORD: "x", MEMBER_EMAIL: "m@x", MEMBER_PASSWORD: "x",
  MCP_ALLOWED_ORIGINS: "http://yard.localtest.me, https://yard.example.com/",
});
const { originAllowed, parseOrigins } = await import("../dist/origin.js");

const allowed = parseOrigins("http://yard.localtest.me, https://yard.example.com/, not a url");

test("no Origin header (CLI clients) is allowed", () => {
  assert.equal(originAllowed(undefined, allowed), true);
});

test("listed origins are allowed, after normalization", () => {
  assert.equal(originAllowed("http://yard.localtest.me", allowed), true);
  assert.equal(originAllowed("https://yard.example.com", allowed), true);
  assert.equal(originAllowed("HTTP://YARD.LOCALTEST.ME:80", allowed), true);
});

test("anything else is rejected", () => {
  assert.equal(originAllowed("http://evil.example", allowed), false);
  assert.equal(originAllowed("https://yard.localtest.me", allowed), false); // scheme matters
  assert.equal(originAllowed("http://yard.localtest.me:8080", allowed), false); // port matters
  assert.equal(originAllowed("null", allowed), false);
  assert.equal(originAllowed("", allowed), false);
});

test("/mcp answers a foreign Origin with 403 before touching auth or the DB", async () => {
  const express = (await import("express")).default;
  const { mcpRouter } = await import("../dist/mcp.js");
  const app = express().use("/mcp", mcpRouter());
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const bad = await fetch(url, { method: "POST", body, headers: { ...headers, origin: "http://evil.example" } });
  assert.equal(bad.status, 403);
  assert.match((await bad.json()).error.message, /Origin http:\/\/evil\.example is not allowed/);
  const noKey = await fetch(url, { method: "POST", body, headers: { ...headers, origin: "http://yard.localtest.me" } });
  assert.equal(noKey.status, 401); // allowed origin moves on to the API-key check
  server.close();
});
