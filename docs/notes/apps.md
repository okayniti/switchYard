# Apps: woo-mcp, shipping-mcp, gateway, dashboard (plain English)

Built 26 Oct with `@modelcontextprotocol/sdk@1.32.1` (SDK v1; the v2 experiment was dropped for
time). Node 24 in images, TypeScript, pnpm workspace. Env names: [docs/ENV.md](../ENV.md).

## The three upstream MCP servers

| Server | What it is | Auth the gateway uses |
|--------|------------|-----------------------|
| `woo` → woo-mcp (ours) | WooCommerce products and orders | none (only reachable in-cluster) |
| `shipping` → shipping-mcp (ours) | Fixed INR rate table: quotes, zones | static bearer token |
| `everything` → server-everything | Official MCP reference server (16 demo tools) | none |

**woo-mcp** ([apps/woo-mcp/src](../../apps/woo-mcp/src)) has 6 tools: `list_products`,
`create_product`, `list_orders`, `get_order`, `update_order_status`, `search`.

- **How it talks to the store:** the WooCommerce REST API v3, in-cluster over plain HTTP. Over
  HTTP, WooCommerce only accepts OAuth 1.0a signatures (Basic auth needs HTTPS), so
  [wc.ts](../../apps/woo-mcp/src/wc.ts) signs every request with HMAC-SHA256. We call
  `/?rest_route=/wc/v3/...` so the path is always `/`, which keeps the signature simple and avoids
  permalink redirects. Why REST over WP-CLI: it is the supported, permission-checked API, needs no
  shell access into the WordPress pod, and the key is scoped to WooCommerce.
- **"Orders today":** `list_orders {date: "today"}` works out today's midnight-to-midnight in
  Asia/Kolkata, converts to UTC, and queries with `dates_are_gmt=true`, so the store's own timezone
  setting can't shift the result ([dates.ts](../../apps/woo-mcp/src/dates.ts)).
- **Stateless:** every POST `/mcp` gets a fresh server object. A restart loses nothing.

**shipping-mcp** checks `Authorization: Bearer <SHIPPING_TOKEN>` with a constant-time compare and
returns 401 otherwise. It exists to show the gateway holding an upstream credential that members
never see. Its `search` tool deliberately has the same name as woo-mcp's.

## The gateway ([apps/gateway/src](../../apps/gateway/src))

One Express process serves `/mcp` (MCP clients), `/api/*` (dashboard), the dashboard files, and
`/healthz` + `/readyz`.

### How a tool call travels

1. Client sends `tools/call` for `woo__list_orders` to `/mcp` with `Authorization: Bearer syk_...`.
2. [mcp.ts](../../apps/gateway/src/mcp.ts) hashes the key (SHA-256) and looks it up: not revoked,
   not expired. This happens on **every** request, so revoking works on the very next call even
   inside an open session. The session must also belong to that same key.
3. The low-level MCP `Server` hands the call to `executeToolCall`
   ([execute.ts](../../apps/gateway/src/execute.ts)).
4. The name is split into server `woo` and tool `list_orders`. The
   [UpstreamManager](../../apps/gateway/src/upstreams.ts) holds one MCP client per server, with
   that server's credential attached (decrypted from the DB only there).
5. The call is forwarded with a 15 s timeout. Whatever happens (ok, tool error, timeout,
   unreachable, unknown tool), one `audit_log` row is written: user, server, tool, time, duration,
   outcome, error, truncated args.
6. The result goes back to the client. The client's API key is never sent upstream.

### Name collisions

Every tool is exposed as `<server slug>__<tool>`, always, not only when names clash. So
`woo__search` and `shipping__search` coexist, and adding a server never renames existing tools.
Names longer than 64 characters are truncated with a short hash.

### Slow or dead upstreams

- `tools/list` is answered from a cache; it never waits on an upstream.
- Every 15 s each server is checked with `tools/list` (5 s timeout). Pass = **Connected**; fail =
  **Unreachable** with a reason (connection refused, DNS failed, timed out, HTTP 401, ...); admin
  turned it off = **Disabled**.
- On failure the client is thrown away and rebuilt on the next check. That is also how we recover
  when an upstream pod restarts and our MCP session id stops existing. A call that gets HTTP 404
  (session gone) is retried once on a fresh connection, because the upstream never ran it.
- When the set of tools changes (server disabled, died, came back), every open client session gets
  `notifications/tools/list_changed`, so Claude Code / Inspector re-list.
- Calls to a dead server fail fast with e.g. "Server 'shipping' is unreachable (connection
  refused ...). Other servers are unaffected."

### Users, keys, credentials

- Two roles: **admin** (manages servers and members, sees all audit rows) and **member** (uses
  tools, manages own keys, sees own audit rows). Checked server-side on every `/api` route.
- Dashboard login: bcrypt passwords; the cookie is a random token, and only its SHA-256 is stored.
- API keys: `syk_` + 32 random bytes, shown once, stored as SHA-256. SHA-256 (not bcrypt) because
  the key is random and long, so there is nothing to brute-force, and it is checked on every call.
- Upstream credentials: AES-256-GCM encrypted in Postgres with `GATEWAY_ENC_KEY` from a Secret.
  The API only ever says `hasCredential: true`.
- The admin and one member are seeded from env on first boot. Admins add more members with an
  initial password and can issue or revoke anyone's keys.

### Chat agent ([chat.ts](../../apps/gateway/src/chat.ts))

For each chat message the gateway mints a 10-minute API key for the logged-in user, connects to
its **own** `/mcp` with it like any external client, and revokes it at the end. So the agent can
only do what that user can, and its calls are audited under that user (marked `chat`). The loop:
list tools → ask the LLM (any OpenAI-compatible API, Groq by default) → run the tool calls it asks
for → feed results back (max 4,000 chars each) → repeat, at most 8 times. The reply includes every
tool call made, which the dashboard shows.

### Dashboard ([apps/gateway/web](../../apps/gateway/web))

One React page, built by Vite into `dist/public` and served by the gateway (same origin, so the
session cookie is simple). Tabs: Servers, My keys, Members (admin), Audit log, Chat.

## Containers

All three images: multi-stage build from the repo root (to use the pnpm lockfile), run as uid 1000
(`node`), app files owned by root so the process can't modify its own code, `/healthz` for probes.

## Verified locally (26 Oct, before Kubernetes)

- woo-mcp against the real store: all 6 tools; `get_order 999999` → clear 404 error.
- shipping-mcp: 401 without or with a wrong token, 200 with the right one.
- Gateway with all three upstreams: 25 tools; member gets 403 on admin routes; disable shipping →
  `list_changed` received and its calls say "disabled by an admin"; revoke a key mid-session → next
  call 401; stop everything-mcp → "unreachable (connection refused)" while others keep working, and
  it reconnects after restart; audit rows have the right user; members see only their own.

Unit tests (`pnpm -r test`, built-in `node:test`, no extra dependencies): woo-mcp 10 (IST day
ranges incl. DST; OAuth1 signature verified by a fake store the way WooCommerce checks it),
shipping-mcp 5 (zones, billing), gateway 6 (AES-GCM, API keys, tool naming).

## Known limits

- MCP sessions live in gateway memory, so run one gateway replica (a second replica would need
  sticky sessions or a shared session store).
- No SSRF guard on "add server" yet: an admin can point the gateway at any URL.
- Members are added by an admin with an initial password, not by an emailed invite link.
