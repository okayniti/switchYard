# System design and tradeoffs

## Architecture at a glance

```
             browser / MCP client (Claude Code, Cursor, Inspector)
                 │ shop.*            │ yard.*  (UI + /api)    │ mcp.*/mcp
                 ▼                   ▼                         ▼
          ┌──────────────── Traefik Ingress (k3s built-in) ─────────────────┐
          │                                                                 │
  ns store│ wordpress (Deployment) ──► mariadb (StatefulSet)                │
          │      ▲  REST /wc/v3 (OAuth1, HTTP)                              │
  ns mcp  │ woo-mcp ◄─┐  shipping-mcp ◄─┐  everything-mcp ◄─┐  ClusterIP   │
          │           │  NetworkPolicy  │  bearer token     │  only        │
  ns      │           └──────────── gateway (Deployment) ───┘               │
  platform│                        ├─ /mcp, /api, dashboard UI, chat agent  │
          │                        └─► postgres (StatefulSet)               │
          └─────────────────────────────────────────────────────────────────┘
```

Gateway internals (aggregation, routing, naming/collisions, failure handling, auth, audit,
chat loop) are described in the gateway section below.

## Gateway

One Node process (`apps/gateway`, Express 5, MCP TypeScript SDK 1.32.1) plays both MCP roles:

- **Client side** ([upstreams.ts](../apps/gateway/src/upstreams.ts)): one long-lived MCP `Client`
  per enabled upstream.
- **Server side** ([mcp.ts](../apps/gateway/src/mcp.ts)): one `/mcp` endpoint for every team
  member.

It also serves `/api/*` for the dashboard, the dashboard itself, and `/healthz` + `/readyz`.
Postgres holds users, sessions, key hashes, servers (with encrypted credentials) and the audit log.

### Tool aggregation, routing and name collisions

**Aggregation.** The gateway keeps a **tool cache**: the union of the tool lists of every server
that is enabled and currently Connected. The cache is refreshed by the health loop (every 15 s),
immediately after any admin change, and when an upstream sends `notifications/tools/list_changed`.
`tools/list` on `/mcp` is answered **from the cache only**. It never waits on an upstream, so a
slow or dead server can't stall or break the listing of the others.

**Naming (the collision scheme).** Every tool is exposed as `<server slug>__<tool name>`, for
every server, not only when names clash:

| Upstream | Upstream tool | Exposed as |
|----------|---------------|------------|
| woo | `search` | `woo__search` |
| shipping | `search` | `shipping__search` |
| everything | `echo` | `everything__echo` |

- **Why always, not only on collision:** names are deterministic. Adding a server never renames
  a tool that clients, prompts or audit queries already use.
- **Why `__`:** slugs are `^[a-z][a-z0-9_]{1,15}$` (enforced by a DB `CHECK`), and MCP clients
  accept `[a-zA-Z0-9_-]{1,64}`. The first `__` in a name ends the slug.
- **Too long or odd characters:** if `<slug>__<tool>` is over 64 characters or contains other
  characters, it is truncated and suffixed with 8 hex chars of its SHA-256. That is deterministic
  too, and the router keeps the exposed→original mapping.
- **Provenance:** each description is prefixed with the server's display name, e.g.
  `[WooCommerce store] List orders, newest first…`, so a model and a human can see where a tool
  comes from.

**Routing.** `tools/call` for `woo__list_orders` goes to `executeToolCall`
([execute.ts](../apps/gateway/src/execute.ts)), the single function both `/mcp` and the chat agent
use:

1. Look the exposed name up in the cache → server `woo`, upstream tool `list_orders`.
2. If it isn't there, explain why: unknown server, server disabled by an admin, or server
   unreachable (with the reason and when it was last checked).
3. Forward `tools/call` with the original name over that server's client, with a timeout.
4. Return the upstream's result unchanged (including `isError` results).
5. Write one `audit_log` row: user, API key, source (`mcp` or `chat`), server, tool, timestamp,
   duration, outcome, error text, and the first 500 chars of the arguments.

Failures are returned as **tool results with `isError: true`** and a sentence a person can act on,
not as protocol errors, so an MCP client or the LLM sees the reason:

```
Server 'shipping' is unreachable (connection refused, last checked 2026-10-26T11:45:02Z).
Other servers are unaffected.
```

### Timeouts and failure handling

The rule: **one bad upstream only ever affects its own tools.**

| Situation | What the gateway does | What the client sees |
|-----------|-----------------------|----------------------|
| Upstream slow on a call | the call is aborted after **15 s** (`TOOL_TIMEOUT_MS`) | `isError`: "Tool 'x' timed out after 15002 ms on server 'y'. Other servers are unaffected." |
| Upstream dead (pod killed, refused, DNS fails) | the next health check (≤ 15 s) marks it **Unreachable** with a reason; its tools drop out of the cache; open sessions get `tools/list_changed` | its tools disappear; a direct call gets "unreachable (connection refused…)" |
| Upstream comes back | the next health check reconnects from scratch; tools return; `list_changed` again | its tools reappear |
| Upstream restarted and forgot our MCP session | it answers HTTP 404; the call never ran there, so the gateway reconnects and **retries once** | nothing; the call succeeds |
| Upstream returns a JSON-RPC error (bad args) | passed through as a tool error; the server stays Connected | the upstream's message |
| Admin disables a server | status **Disabled**, tools removed, `list_changed` sent | "Server 'x' is disabled by an admin." |
| Upstream rejects our credential | **Unreachable**, reason "rejected credentials (HTTP 401)" | dashboard shows why |

**Health loop.** Every 15 s (`HEALTH_INTERVAL_MS`), all servers are checked **in parallel**, each
with `tools/list` under a **5 s** timeout. Success = Connected and a fresh tool snapshot. Failure =
Unreachable plus a short reason (connection refused, DNS lookup failed, timed out, HTTP 401/404…)
and the time of the check, which is what the dashboard shows. On failure the client object is
thrown away, so recovery never depends on resuming a half-broken connection.

**Why only a 404 is retried.** A timeout or a dropped connection may have reached the upstream
and run the tool (for example `create_product`), so retrying could do it twice. A 404 for our
session id means the upstream rejected the request before running anything.

**Isolation from Kubernetes probes.** The gateway's readiness checks only Postgres, and liveness
only the process. An upstream outage never takes the gateway out of its Service.

**Notifying clients.** When the set of tool names in the cache changes, every open `/mcp` session
gets `notifications/tools/list_changed`. Clients that hold a session (Claude Code, MCP Inspector)
re-list tools. The chat agent lists tools at the start of every request, so it always sees the
current set.

**Limits.** MCP sessions live in the gateway's memory, so it runs as **one replica**; after a
restart the gateway answers old session ids with 404, and the MCP spec requires the client to
start a new session. Running several replicas would
need sticky sessions at the Ingress or the SDK's session-less mode.

### Users, API keys and upstream credentials

Three different kinds of secret, stored three different ways, because they are used differently:

| Secret | Stored as | Why |
|--------|-----------|-----|
| Dashboard password | **bcrypt** (cost 10) | low-entropy, chosen by a person: needs a slow hash |
| Gateway API key `syk_…` (32 random bytes) | **SHA-256** + 12-char display prefix | high-entropy, so nothing to brute-force; checked on every `/mcp` request, where bcrypt's ~50 ms would be paid on every call |
| Upstream credential (bearer token or custom header) | **AES-256-GCM** ciphertext (`iv ‖ tag ‖ ct`) | the gateway must send the original value upstream, so it needs reversible encryption, not a hash |

- **Dashboard sessions:** login sets an `httpOnly`, `SameSite=Lax` cookie (`Secure` with TLS)
  holding a random 256-bit token; the DB stores only its SHA-256, with a 12 h expiry. A login for
  an unknown email still runs a bcrypt compare, so response time doesn't reveal which emails exist.
- **API keys are shown once** (on creation) and can be revoked by their owner or by an admin. The
  `/mcp` check is `key_hash = sha256(presented) AND revoked_at IS NULL AND not expired`, run on
  **every request**, so a revoked key fails on its very next call even inside an open session.
  Revoking also closes that key's open sessions, but that is cleanup, not the enforcement.
- **Sessions are bound to their key.** A request that presents key B with a session opened by
  key A is rejected (403).
- **Upstream credentials are write-only.** The admin types one in when adding or editing a server.
  The API stores the ciphertext and from then on only reports `hasCredential: true`; there is no
  endpoint that returns it. It is decrypted in memory only when building that upstream's client.
  The master key `GATEWAY_ENC_KEY` is a Kubernetes Secret (see Secrets above).
- **Origin check on `/mcp`:** before anything else, a request carrying an `Origin` header that
  isn't in `MCP_ALLOWED_ORIGINS` (default the dashboard origin) is refused with 403, as the MCP
  Streamable HTTP spec requires against DNS rebinding. CLI clients send no `Origin` and pass.
- **Roles:** `admin` manages servers and members and sees the whole audit log; `member` uses the
  tools, manages their own keys and sees their own audit rows. Every `/api` route checks the
  session and role on the server; the dashboard hiding a button is only convenience.

### Chat agent

The chat runs in the gateway backend, so the browser never sees the LLM key or any upstream
credential. **It is a real MCP client of the gateway's own `/mcp`:**

1. `POST /api/chat` (session cookie) mints a **10-minute `chat` API key for the logged-in user**.
2. It connects to `http://127.0.0.1:8080/mcp` with that key and lists tools, through the same auth
   and the same cache as any external client.
3. It calls the LLM (any OpenAI-compatible Chat Completions API; Groq `llama-3.3-70b-versatile`
   by default) with the tools and a system prompt that includes the current time in Asia/Kolkata.
4. For each tool call the model asks for, it calls `tools/call` on `/mcp`, and feeds the result
   back (capped at 4,000 characters).
5. It repeats until the model answers in text, at most **8 iterations**, then revokes the key.

So the agent can do exactly what that user can do, and every call it makes is in the audit log
under that user with `source = chat`. The response lists every tool call (name, arguments,
duration, ok/error, result preview), which the dashboard shows. An LLM error (bad key, rate
limit, timeout) comes back as a clear message and nothing crashes.

## Kubernetes

Everything is in **one Helm chart**, `charts/switchyard`. `values-local.yaml` (k3d) and
`values-prod.yaml` (k3s on a VPS) are the only differences between environments. Both run
k3s, so the ingress controller (Traefik), storage class (`local-path`) and NetworkPolicy
enforcement (kube-router) are the same locally and in production.

### Namespaces: one per trust zone

| Namespace | Workloads | Reachable from outside? |
|-----------|-----------|-------------------------|
| `store` | WordPress (Deployment), MariaDB (StatefulSet), setup Job | storefront only, via Ingress `shop.*` |
| `mcp` | woo-mcp, shipping-mcp, everything-mcp (Deployments) | **no**: ClusterIP Services only, no Ingress |
| `platform` | gateway (Deployment; also serves the dashboard), Postgres (StatefulSet) | gateway only, via Ingress `yard.*` (UI + `/api`) and `mcp.*/mcp` |

Namespaces are the boundaries the NetworkPolicy selects on (`kubernetes.io/metadata.name`),
and they keep Secrets scoped: a pod can only mount Secrets from its own namespace.

### Public vs internal, and how it is enforced

**What is public:** three Ingress hosts. Traefik routes by `Host` header to exactly two
Services: `wordpress` (storefront) and `gateway` (dashboard, `/api`, `/mcp`).

**What is internal, and the two layers that keep it internal:**

1. **No route in.** Every other Service is `type: ClusterIP`. No NodePort, no LoadBalancer
   and no Ingress points at the MCP servers, MariaDB or Postgres, so nothing outside the
   cluster can address them. Upstream URLs are cluster DNS names
   (`woo-mcp.mcp.svc.cluster.local:8080`) that only resolve inside the cluster.
2. **NetworkPolicy inside the cluster.** `woo-mcp-allow-gateway-only` selects the woo-mcp
   pods and allows ingress only from pods labelled `app.kubernetes.io/name=gateway` **and** in
   namespace `platform` (both selectors in one `from` entry, which means AND), on its port.
   Selecting a pod with a policy denies every other source.

**Verified:**

| From | Request | Result |
|------|---------|--------|
| a gateway-labelled pod in `platform` | `GET woo-mcp.mcp:8080/healthz` | `{"ok":true}` |
| a pod in `store` | same | refused (`curl` exit 7) |

- k3s's kube-router **rejects** denied connections rather than dropping them, so they fail
  instantly instead of timing out.
- **Gotcha:** kube-router adds a *new* pod's IP to the allow-list a few seconds after the pod
  starts (≈10 s observed). A throwaway test pod that connects immediately is refused even when
  allowed, so wait ~10 s first. Long-running pods such as the gateway are unaffected.
- Kubelet health probes still reach woo-mcp: k3s permits node-originated traffic.

The other upstreams rely on ClusterIP plus their own auth. shipping-mcp requires a static
bearer token that only the gateway holds (Secret `shipping-mcp-token`, mirrored into `mcp` and
`platform`). The same allow-from-gateway pattern extends to them, and default-deny per
namespace is the next hardening step.

### Secrets

- **Every credential is a Kubernetes Secret, generated by Helm in-cluster. None is in git**
  (a gitleaks pre-commit hook scans every commit).
- **Generated once, then stable.** Templates call `lookup` to read the existing Secret and
  reuse its values, so `helm upgrade` never rotates a password that is already baked into a
  database on a PVC. Values are random (`randAlphaNum`; `randBytes 32` for the gateway's
  AES-256 key).
- **Mirrored where two namespaces need the same value**, because pods can't read Secrets
  across namespaces: `woocommerce-api-key` in `store` (the setup Job registers it) and `mcp`
  (woo-mcp signs with it); `shipping-mcp-token` in `mcp` and `platform`.
- **Consumed only via `secretKeyRef`**, so values never appear in a manifest. The gateway's
  `DATABASE_URL` uses Kubernetes `$(PGPASSWORD)` expansion.
- **LLM key:** passed at install (`make up LLM_API_KEY=…` → `--set-string`, never echoed),
  stored in Secret `llm`, and kept by `lookup` when later installs omit it.
- **Production:** store secrets use `existingSecret` (created out-of-band; see README). They
  survive a reinstall and don't depend on `lookup`.
- **`helm.sh/resource-policy: keep`** is set on the store Secrets and PVC, so `helm
  uninstall` can't orphan data whose password was just deleted.
- **No component talks to the Kubernetes API.** Every pod has
  `automountServiceAccountToken: false`, and no RBAC is granted to anything.

### Persistent storage

| PVC | Size (local / prod) | Holds | Notes |
|-----|---------------------|-------|-------|
| `data-mariadb-0` (StatefulSet `volumeClaimTemplates`) | 2Gi / 5Gi | store database | bound to the pod identity `mariadb-0` and kept if the pod is deleted |
| `wordpress-content` | 2Gi / 5Gi | WordPress core + `wp-content` (uploads, plugins) | `ReadWriteOnce`, so the Deployment uses `strategy: Recreate`; the setup Job mounts it too (same node; single-node is a documented limit) |
| `data-postgres-0` | 1Gi / 5Gi | gateway DB (users, key hashes, servers, audit log) | |

The storage class is `local-path` (k3s). It is node-local, so it suits a single node. On a
managed or multi-node cluster you change `global.storageClassName` to a CSI class; no template
changes.

**local-path gotcha:** its volumes are root-owned `0777` host directories and ignore
`fsGroup`. A non-root container can write into the volume root but can't `chmod` it, and the
WordPress entrypoint's first-boot copy needs that. An init container running as `www-data`
creates `html/`, which WordPress then mounts as a `subPath`, so it owns its directory.

### Probes

Every long-running container has **readiness and liveness** probes:

| Workload | Readiness | Liveness | Why |
|----------|-----------|----------|-----|
| MariaDB | `healthcheck.sh --connect --innodb_initialized` | same | ships with the image; a **startup** probe allows 5 min for first-boot init |
| WordPress | `GET /wp-login.php` | `tcpSocket :8080` | readiness exercises PHP + DB, so a broken store leaves the Service. Liveness deliberately does **not** depend on the DB: a DB outage would otherwise restart every WordPress pod (a restart storm) |
| Postgres | `pg_isready` | `pg_isready` | plus a startup probe |
| woo-mcp, shipping-mcp | `GET /healthz` | `GET /healthz` | upstream health never affects probes |
| everything-mcp | `tcpSocket` | `tcpSocket` | third-party server with no HTTP health route |
| gateway | `GET /readyz` (also checks Postgres) | `GET /healthz` | a dead **upstream** never makes the gateway unready; isolation is the point |

**Run-to-completion Jobs get no probes** (they're meaningless there). The setup Job is
bounded by `activeDeadlineSeconds: 600` and `backoffLimit: 3`, and every wp-cli call inside it
has a 120 s timeout that names any slow call in the log.

### Requests and limits

Every container, including init containers and the Job, has CPU/memory **requests** (what
the scheduler reserves) and **limits** (the ceiling; exceeding the memory limit gets the
container OOM-killed rather than starving its neighbours). Local sizes are small so the
whole stack fits in about 4 GB of Docker memory. `values-prod.yaml` raises them.

| Workload | Requests | Limits |
|----------|----------|--------|
| MariaDB | 100m / 256Mi | 1 / 512Mi |
| WordPress | 100m / 192Mi | 1 / 512Mi |
| setup Job | 100m / 128Mi | 1 / 512Mi |
| Postgres | 50m / 128Mi | 500m / 384Mi |
| gateway | 100m / 192Mi | 1 / 512Mi |
| woo-mcp | 50m / 96Mi | 500m / 256Mi |
| shipping-mcp | 25m / 64Mi | 250m / 192Mi |
| everything-mcp | 25m / 96Mi | 500m / 256Mi |

### Container hardening (every workload)

- `runAsNonRoot`, with explicit UIDs (www-data 33, mysql 999, postgres 70, node 1000)
- `allowPrivilegeEscalation: false`
- `capabilities: drop: [ALL]`
- `seccompProfile: RuntimeDefault`
- `readOnlyRootFilesystem: true`, with `emptyDir` volumes only for the paths that must be
  writable (`/tmp`, Apache's run/lock dirs, `/run/mysqld`, `/var/run/postgresql`)

**WordPress needed one change to run non-root:** unprivileged processes can't bind port 80,
so the image's Apache listens on **8080** and the Service maps 80 → 8080.

### Why a custom WordPress image

`images/wordpress` is the official `wordpress:7.1.3-php8.3-apache` (pinned by digest) plus:

- **wp-cli 2.12.0**, verified against its SHA-512, for the setup Job
- **WooCommerce 11.2.1** zip, verified by SHA-256 (`ADD --checksum`)
- Apache on 8080 as `www-data`

Tradeoff: one more image to build, in exchange for **nothing downloaded at runtime**
(reproducible, works with outbound HTTP blocked) and a clear upgrade path. A WooCommerce bump
means a new image, then `helm upgrade`; the setup Job installs the new version only when it
differs, then runs `wp wc update`. The store also sets `WP_HTTP_BLOCK_EXTERNAL`: it needs no
internet, and blocking it removed a source of hung requests.

### Store setup Job

A Helm `post-install,post-upgrade` hook with `before-hook-creation` delete policy, so the
last run's logs stay inspectable. Every step is idempotent:

- **WordPress core:** install only if missing.
- **WooCommerce:** install only if the version differs, then activate.
- **Settings:** Asia/Kolkata, INR, store address, onboarding skipped, "coming soon" off.
- **Payments:** Cash on Delivery enabled via WooCommerce's settings API.
- **Products:** 5 seeded, keyed by SKU.
- **REST key:** registered for a dedicated **`shop_manager`** user (least privilege, not
  admin), written exactly as WooCommerce's own `WC_Auth::create_keys` writes it
  (`hmac_sha256(key, 'wc-api')`, `truncated_key`), delete-then-insert.

`scripts/check-store-idempotency.sh` asserts that two upgrades leave Secrets, products, users,
keys and settings identical.

### Why woo-mcp talks to the store through the REST API

| Option | Verdict |
|--------|---------|
| **WooCommerce REST API v3** (chosen) | A versioned, documented contract. WooCommerce's own validation, hooks, stock handling and HPOS order storage all still run. The credential is a scoped API key bound to a `shop_manager` user, not WP admin. Needs no Kubernetes RBAC and no access to the WordPress pod. |
| WP-CLI via `kubectl exec` | woo-mcp would need `pods/exec` RBAC (effectively a shell in the store), and it would be parsing CLI text output. Rejected. |
| Direct MySQL | bypasses WooCommerce's business logic (stock, order notes, hooks), couples us to the schema, and needs DB credentials in the `mcp` namespace. Rejected. |

**Auth over plain HTTP:** in-cluster traffic is HTTP, and WooCommerce only accepts Basic auth
or query-string keys over HTTPS. Over HTTP it requires **OAuth 1.0a one-legged HMAC-SHA256
signatures**.
- The signature base string uses the store's **public** home URL (`get_home_url()`), not the
  Service hostname the request is sent to, so woo-mcp gets both `WC_URL` (where to send) and
  `WC_HOME` (what to sign).
- Requests use the `?rest_route=/wc/v3/...` form, which avoids WordPress canonical redirects.
- Proven from inside the cluster: signed → 200, unsigned → 401
  (`scripts/wc-rest-smoke.mjs`).

### What changes for production

Only values (see README, "Production-like deployment"):

- **DNS/hosts:** `global.hosts` → real domain or `sslip.io`
- **Ingress:** same Traefik, plus TLS via cert-manager (`global.tls`)
- **Storage class:** `global.storageClassName`
- **Secrets:** `existingSecret`, created out-of-band; `global.createNamespaces: false`
- **Images:** `ghcr.io/...:<git-sha>`
- **Resources:** larger requests/limits

Upgrade with `helm upgrade` and inspect with `helm history`. Roll back with `helm rollback`:
data is on PVCs and secrets are stable, so a rollback only swaps Pod specs and re-runs the
idempotent setup Job.
