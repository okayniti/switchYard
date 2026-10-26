// REST API for the dashboard. Every route checks the session and role server-side; hiding a
// button in the UI is never the access control. Upstream credentials are write-only: no
// response ever includes one, only `hasCredential`.
import bcrypt from "bcryptjs";
import express, { type Request, type Response } from "express";
import { login, logout, requireAdmin, requireUser } from "./auth.js";
import { chat } from "./chat.js";
import { config } from "./config.js";
import { encrypt, newApiKey } from "./crypto.js";
import { pool } from "./db.js";
import { closeSessionsForKey } from "./mcp.js";
import { checkUpstreamUrl } from "./ssrf.js";
import { upstreams } from "./upstreams.js";

const SLUG_RE = /^[a-z][a-z0-9_]{1,15}$/;
const bad = (res: Response, error: string) => res.status(400).json({ error });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function validUrl(u: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(u).protocol);
  } catch {
    return false;
  }
}

async function createKey(userId: number, name: string) {
  const k = newApiKey();
  const { rows } = await pool.query(
    "INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, prefix, created_at",
    [userId, name || "default", k.prefix, k.hash],
  );
  return { ...rows[0], key: k.key }; // the only time the full key is ever returned
}

const listKeys = async (userId: number) =>
  (
    await pool.query(
      "SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = $1 AND kind = 'user' ORDER BY created_at DESC",
      [userId],
    )
  ).rows;

export function apiRouter() {
  const r = express.Router();
  r.use(express.json({ limit: "1mb" }));

  // --- auth ---
  r.post("/auth/login", async (req, res) => {
    const user = await login(str(req.body?.email), String(req.body?.password ?? ""), res);
    if (!user) return void res.status(401).json({ error: "Wrong email or password" });
    res.json(user);
  });
  r.post("/auth/logout", async (req, res) => {
    await logout(req, res);
    res.json({ ok: true });
  });
  r.get("/me", requireUser, (req, res) => {
    res.json({ ...req.user, publicMcpUrl: config.publicMcpUrl });
  });

  // --- servers: everyone can see status and tools; only admins change them ---
  r.get("/servers", requireUser, (_req, res) => {
    res.json(upstreams.snapshot());
  });

  r.post("/servers", requireAdmin, async (req, res) => {
    const slug = str(req.body?.slug).toLowerCase();
    const name = str(req.body?.name) || slug;
    const url = str(req.body?.url);
    const authType = str(req.body?.authType) || "none";
    const authHeader = str(req.body?.authHeader) || null;
    const credential = str(req.body?.credential);
    if (!SLUG_RE.test(slug)) return void bad(res, "slug must be 2-16 chars: lowercase letter first, then a-z, 0-9, _");
    if (!validUrl(url)) return void bad(res, "url must be an http(s) URL");
    if (!["none", "bearer", "header"].includes(authType)) return void bad(res, "authType must be none, bearer or header");
    if (authType === "header" && !authHeader) return void bad(res, "authHeader is required when authType is header");
    if (authType !== "none" && !credential) return void bad(res, "credential is required for this authType");
    const blocked = await checkUpstreamUrl(url, config.upstreamAllowedHosts);
    if (blocked) return void bad(res, blocked);
    try {
      await pool.query("INSERT INTO servers (slug, name, url, auth_type, auth_header, credential_enc) VALUES ($1, $2, $3, $4, $5, $6)", [
        slug,
        name,
        url,
        authType,
        authHeader,
        authType === "none" ? null : encrypt(credential),
      ]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return void bad(res, `a server with slug '${slug}' already exists`);
      throw err;
    }
    await upstreams.reload();
    res.status(201).json(upstreams.snapshot().find((s) => s.slug === slug));
  });

  r.patch("/servers/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const cur = (await pool.query("SELECT * FROM servers WHERE id = $1", [id])).rows[0];
    if (!cur) return void res.status(404).json({ error: "No such server" });
    const b = req.body ?? {};
    const next = {
      name: b.name !== undefined ? str(b.name) || cur.name : cur.name,
      url: b.url !== undefined ? str(b.url) : cur.url,
      enabled: b.enabled !== undefined ? Boolean(b.enabled) : cur.enabled,
      auth_type: b.authType !== undefined ? str(b.authType) : cur.auth_type,
      auth_header: b.authHeader !== undefined ? str(b.authHeader) || null : cur.auth_header,
      // credential: a non-empty string replaces it, null clears it, absent keeps it.
      credential_enc: b.credential === null ? null : str(b.credential) ? encrypt(str(b.credential)) : cur.credential_enc,
    };
    if (!validUrl(next.url)) return void bad(res, "url must be an http(s) URL");
    if (next.url !== cur.url) {
      const blocked = await checkUpstreamUrl(next.url, config.upstreamAllowedHosts);
      if (blocked) return void bad(res, blocked);
    }
    if (!["none", "bearer", "header"].includes(next.auth_type)) return void bad(res, "authType must be none, bearer or header");
    if (next.auth_type === "none") next.credential_enc = null;
    await pool.query(
      "UPDATE servers SET name = $2, url = $3, enabled = $4, auth_type = $5, auth_header = $6, credential_enc = $7, updated_at = now() WHERE id = $1",
      [id, next.name, next.url, next.enabled, next.auth_type, next.auth_header, next.credential_enc],
    );
    await upstreams.reload();
    res.json(upstreams.snapshot().find((s) => s.id === id));
  });

  r.delete("/servers/:id", requireAdmin, async (req, res) => {
    const r2 = await pool.query("DELETE FROM servers WHERE id = $1", [Number(req.params.id)]);
    if (!r2.rowCount) return void res.status(404).json({ error: "No such server" });
    await upstreams.reload();
    res.json({ ok: true });
  });

  // --- my API keys ---
  r.get("/keys", requireUser, async (req, res) => {
    res.json(await listKeys(req.user!.id));
  });
  r.post("/keys", requireUser, async (req, res) => {
    res.status(201).json(await createKey(req.user!.id, str(req.body?.name)));
  });
  // Members revoke their own keys; admins can revoke anyone's.
  r.delete("/keys/:id", requireUser, async (req, res) => {
    const id = Number(req.params.id);
    const { rowCount } = await pool.query(
      "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL AND (user_id = $2 OR $3)",
      [id, req.user!.id, req.user!.role === "admin"],
    );
    if (!rowCount) return void res.status(404).json({ error: "No such active key" });
    closeSessionsForKey(id);
    res.json({ ok: true });
  });

  // --- members (admin) ---
  r.get("/users", requireAdmin, async (_req, res) => {
    const users = (await pool.query("SELECT id, email, role, created_at FROM users ORDER BY id")).rows;
    res.json(await Promise.all(users.map(async (u) => ({ ...u, keys: await listKeys(u.id) }))));
  });
  r.post("/users", requireAdmin, async (req, res) => {
    const email = str(req.body?.email).toLowerCase();
    const password = String(req.body?.password ?? "");
    const role = req.body?.role === "admin" ? "admin" : "member";
    if (!/^\S+@\S+$/.test(email)) return void bad(res, "a valid email is required");
    if (password.length < 8) return void bad(res, "password must be at least 8 characters");
    try {
      const { rows } = await pool.query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role, created_at", [
        email,
        await bcrypt.hash(password, 10),
        role,
      ]);
      res.status(201).json(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return void bad(res, "that email already has an account");
      throw err;
    }
  });
  r.post("/users/:id/keys", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const exists = await pool.query("SELECT 1 FROM users WHERE id = $1", [id]);
    if (!exists.rowCount) return void res.status(404).json({ error: "No such user" });
    res.status(201).json(await createKey(id, str(req.body?.name) || "issued by admin"));
  });

  // --- audit: admins see everything, members see their own calls ---
  r.get("/audit", requireUser, async (req, res) => {
    const admin = req.user!.role === "admin";
    const { rows } = await pool.query(
      `SELECT id, ts, user_email, source, server_slug, tool, duration_ms, outcome, error, args_preview
       FROM audit_log WHERE $1 OR user_id = $2 ORDER BY ts DESC LIMIT 200`,
      [admin, req.user!.id],
    );
    res.json(rows);
  });

  r.post("/chat", requireUser, async (req: Request, res: Response) => {
    const out = await chat(req.user!, req.body?.messages);
    res.status(out.error ? 502 : 200).json(out);
  });

  r.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  return r;
}
