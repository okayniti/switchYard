import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const key = Buffer.from(config.encKey, "base64");
if (key.length !== 32) {
  console.error("GATEWAY_ENC_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  process.exit(1);
}

// Upstream credentials at rest: AES-256-GCM, stored as base64(iv | tag | ciphertext).
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decrypt(stored: string): string {
  const buf = Buffer.from(stored, "base64");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

// API keys and session tokens are 256-bit random values, so a fast SHA-256 is the right hash:
// there is nothing to brute-force, and it is checked on every request (bcrypt would be slow).
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = `syk_${randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, 12), hash: sha256(key) };
}

export const randomToken = () => randomBytes(32).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
