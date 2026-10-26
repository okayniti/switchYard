// First-boot data. Inserts are "if missing", so restarts never overwrite what an admin changed in
// the dashboard. Seeded servers are recorded in seed_state, so a seed an admin deleted stays deleted.
import bcrypt from "bcryptjs";
import { config } from "./config.js";
import { encrypt } from "./crypto.js";
import { pool } from "./db.js";

async function seedUser(email: string, password: string, role: "admin" | "member"): Promise<void> {
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING", [email.toLowerCase(), hash, role]);
  if (r.rowCount) console.log(`seeded ${role} ${email}`);
}

async function seedServer(slug: string, name: string, url: string, auth?: { type: "bearer"; credential: string }): Promise<void> {
  const first = await pool.query("INSERT INTO seed_state (key) VALUES ($1) ON CONFLICT DO NOTHING", [`server:${slug}`]);
  if (!first.rowCount) return; // seeded before (and possibly edited or deleted by an admin since)
  await pool.query(
    "INSERT INTO servers (slug, name, url, auth_type, credential_enc) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (slug) DO NOTHING",
    [slug, name, url, auth?.type ?? "none", auth ? encrypt(auth.credential) : null],
  );
  console.log(`seeded server ${slug} -> ${url}`);
}

export async function seed(): Promise<void> {
  await seedUser(config.admin.email, config.admin.password, "admin");
  await seedUser(config.member.email, config.member.password, "member");
  await seedServer("woo", "WooCommerce store", config.seeds.wooUrl);
  if (!config.seeds.shippingToken) console.warn("SHIPPING_MCP_TOKEN is empty; the shipping server will be unauthorized");
  await seedServer("shipping", "Shipping rates", config.seeds.shippingUrl, { type: "bearer", credential: config.seeds.shippingToken });
  await seedServer("everything", "MCP Everything (reference)", config.seeds.everythingUrl);
}
