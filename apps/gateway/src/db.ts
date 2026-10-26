// Postgres pool + a minimal migration runner: apply migrations/*.sql in filename order, once each,
// inside a transaction, under an advisory lock so two starting replicas can't race.
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

// On first boot the gateway can start before Postgres accepts connections. Retry with
// exponential backoff (0.5 s, 1 s, 2 s … capped at 5 s) for up to ~60 s before giving up.
export async function connectWithRetry(deadlineMs = 60_000, connect = () => pool.connect()): Promise<pg.PoolClient> {
  const start = Date.now();
  for (let attempt = 1, delay = 500; ; attempt++, delay = Math.min(delay * 2, 5_000)) {
    try {
      return await connect();
    } catch (err) {
      if (Date.now() - start + delay > deadlineMs) throw err;
      console.warn(`postgres not ready (attempt ${attempt}: ${(err as Error).message}); retrying in ${delay} ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function migrate(): Promise<void> {
  const client = await connectWithRetry();
  try {
    await client.query("SELECT pg_advisory_lock(42424242)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`migration applied: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(42424242)").catch(() => {});
    client.release();
  }
}
