import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

Object.assign(process.env, {
  DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
  GATEWAY_ENC_KEY: randomBytes(32).toString("base64"),
  ADMIN_EMAIL: "a@x", ADMIN_PASSWORD: "x", MEMBER_EMAIL: "m@x", MEMBER_PASSWORD: "x",
});
const { connectWithRetry } = await import("../dist/db.js");

test("retries until Postgres accepts a connection", async () => {
  let calls = 0;
  const client = await connectWithRetry(10_000, async () => {
    if (++calls < 3) throw new Error("ECONNREFUSED");
    return "client";
  });
  assert.equal(client, "client");
  assert.equal(calls, 3); // waited 0.5 s + 1 s in between
});

test("gives up with the last error after the deadline", async () => {
  let calls = 0;
  const started = Date.now();
  await assert.rejects(connectWithRetry(1_200, async () => { calls++; throw new Error("ECONNREFUSED"); }), /ECONNREFUSED/);
  assert.ok(calls >= 2 && Date.now() - started < 3_000);
});
