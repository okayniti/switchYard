import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

Object.assign(process.env, {
  DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
  GATEWAY_ENC_KEY: randomBytes(32).toString("base64"),
  ADMIN_EMAIL: "a@x", ADMIN_PASSWORD: "x", MEMBER_EMAIL: "m@x", MEMBER_PASSWORD: "x",
});
const { retryDelayMs } = await import("../dist/chat.js");

test("429 delay comes from Retry-After when present", () => {
  assert.equal(retryDelayMs("3", ""), 3000);
});

test("otherwise from the provider's 'try again in' hint (Groq formats)", () => {
  const groq = "Rate limit reached ... Please try again in 172.5ms. Need more tokens?";
  assert.equal(retryDelayMs(null, groq), 250); // clamped up to the minimum
  assert.equal(retryDelayMs(null, "Please try again in 4.2s."), 4200);
  assert.equal(retryDelayMs(null, "Please try again in 1m2.5s."), 20_000); // clamped down
});

test("falls back to 2 s when there is no hint", () => {
  assert.equal(retryDelayMs(null, "slow down"), 2000);
  assert.equal(retryDelayMs("not-a-number", "slow down"), 2000);
});
