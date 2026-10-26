// Dashboard login. The session cookie is a random 256-bit token (httpOnly, SameSite=Lax); the DB
// stores only its SHA-256. Authorization for every /api route is enforced here, server-side.
import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { randomToken, sha256 } from "./crypto.js";
import { pool } from "./db.js";

export interface SessionUser {
  id: number;
  email: string;
  role: "admin" | "member";
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

const COOKIE = "sy_session";
const TTL_MS = 12 * 60 * 60 * 1000;
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

function readCookie(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export async function login(email: string, password: string, res: Response): Promise<SessionUser | null> {
  const { rows } = await pool.query("SELECT id, email, role, password_hash FROM users WHERE email = $1", [email.toLowerCase().trim()]);
  const u = rows[0];
  // Compare against a dummy hash when the user doesn't exist, so timing doesn't reveal which emails exist.
  const ok = await bcrypt.compare(password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !ok) return null;
  const token = randomToken();
  await pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [sha256(token), u.id, new Date(Date.now() + TTL_MS)]);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: config.cookieSecure, maxAge: TTL_MS, path: "/" });
  return { id: u.id, email: u.email, role: u.role };
}

export async function logout(req: Request, res: Response): Promise<void> {
  const token = readCookie(req);
  if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  res.clearCookie(COOKIE, { path: "/" });
}

export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = readCookie(req);
  if (token) {
    const { rows } = await pool.query<SessionUser>(
      "SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()",
      [sha256(token)],
    );
    req.user = rows[0];
  }
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) return void res.status(401).json({ error: "Not logged in" });
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) return void res.status(401).json({ error: "Not logged in" });
  if (req.user.role !== "admin") return void res.status(403).json({ error: "Admins only" });
  next();
}
