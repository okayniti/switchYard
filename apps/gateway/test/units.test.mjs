// Unit tests for the pure parts of the gateway. config.ts validates env at import time, so set
// dummy values first. The pg Pool is lazy: nothing here opens a DB connection.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

Object.assign(process.env, {
  DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
  GATEWAY_ENC_KEY: randomBytes(32).toString("base64"),
  ADMIN_EMAIL: "a@x", ADMIN_PASSWORD: "x", MEMBER_EMAIL: "m@x", MEMBER_PASSWORD: "x",
});
const { encrypt, decrypt, newApiKey, sha256, safeEqual } = await import("../dist/crypto.js");
const { exposedName } = await import("../dist/upstreams.js");

test("credentials round-trip through AES-256-GCM with a fresh IV each time", () => {
  const a = encrypt("shipping-token-123");
  const b = encrypt("shipping-token-123");
  assert.notEqual(a, b);
  assert.equal(decrypt(a), "shipping-token-123");
  assert.equal(a.includes("shipping-token"), false);
});

test("tampered ciphertext is rejected (GCM auth tag)", () => {
  const buf = Buffer.from(encrypt("secret"), "base64");
  buf[buf.length - 1] ^= 1;
  assert.throws(() => decrypt(buf.toString("base64")));
});

test("API keys: syk_ + 256 bits, stored only as SHA-256", () => {
  const k = newApiKey();
  assert.match(k.key, /^syk_[A-Za-z0-9_-]{43}$/);
  assert.equal(k.prefix, k.key.slice(0, 12));
  assert.equal(k.hash, sha256(k.key));
  assert.match(k.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(newApiKey().key, k.key);
});

test("safeEqual compares exactly", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});

test("tools are always namespaced <slug>__<tool>, so same-named tools don't collide", () => {
  assert.equal(exposedName("woo", "search"), "woo__search");
  assert.equal(exposedName("shipping", "search"), "shipping__search");
  assert.equal(exposedName("everything", "get-env"), "everything__get-env");
});

test("names over 64 chars or with odd characters are shortened deterministically", () => {
  const long = exposedName("everything", "x".repeat(80));
  assert.match(long, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.ok(long.startsWith("everything__x"));
  assert.equal(long, exposedName("everything", "x".repeat(80)));
  assert.notEqual(long, exposedName("everything", "x".repeat(81)));
  assert.match(exposedName("svc", "tool.with.dots"), /^svc__tool_with_dots_[0-9a-f]{8}$/);
});
