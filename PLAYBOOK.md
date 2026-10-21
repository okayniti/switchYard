# PLAYBOOK — Switchyard

**Switchyard** is a WooCommerce hosting platform with a Team MCP Gateway on Kubernetes. It is the Urumi AI FDE Internship Round 1 submission.

Repo: https://github.com/okayniti/switchYard
Deadline: **26 Oct 2026, 11:59 PM IST**. Submit on the afternoon of 26 Oct, not at midnight.

> Every client enters the yard through one `/mcp` endpoint. Each tool call is switched onto the right upstream track. A closed track (disabled server) or a broken line (dead upstream) never stops the rest of the yard.

---

## HOW THIS FILE IS USED

1. `PLAYBOOK.md` (this file) lives at the repo root.
2. The assignment brief is pasted verbatim into `docs/ASSIGNMENT.md`.
3. The contents of **Appendix A** go into `CLAUDE.md` at the repo root. Claude Code loads it every session.
4. Work happens one phase per Claude Code session, using the prompt from **Part 5**.
5. Run `/clear` between phases. State carries over through `PROGRESS.md` and git history.
6. Use plan mode (Shift+Tab) for Sessions 0, 3 and 7. The design gets approved before code is written.

**Schedule:**

| Date | Phase |
|------|-------|
| 17 Oct | Phase 1: store |
| 18 Oct | Phase 2: woo-mcp |
| 19–20 Oct | Phase 3: gateway |
| 21 Oct | Phase 4: dashboard |
| 22 Oct | Phase 5: chat |
| 23 Oct | Phase 6: `make dod` green |
| 24 Oct | Phase 7: VPS and differentiators |
| 25 Oct | Phase 8: docs |
| 25–26 Oct | Phase 9: rehearse, record and submit |

**Priority law (from the brief):** a working core beats an unfinished bonus. Nothing from Part 4 or the multi-store bonus starts until `make dod` passes end to end.

---

## PART 0 — COMMIT DISCIPLINE (non-negotiable, applies to every phase)

The git history is part of the submission. Evaluators and founders will read it in Round 2. A history of small, honest, well-described commits shows how the work was done. It also lets any broken step be reverted on its own, and it makes the live walkthrough easy ("here's the commit where I added timeouts").

### The rule

**Commit after every single step, however small.** One logical change is one commit. Examples of a single commit:

- adding a file
- adding one Helm template
- adding probes to one Deployment
- adding one MCP tool
- adding one test
- fixing one bug
- renaming one thing
- updating one doc section
- bumping one version
- adding one value to `values-local.yaml`

If a change can be described in one short sentence without "and", it is one commit. If the description needs "and", split it.

### When to commit

- Immediately after a step is done and verified (it builds, lints, or its test passes). Never batch several steps into one commit at the end.
- Before starting anything risky. That leaves a clean point to return to.
- After every fix found during verification. Each fix is its own `fix:` commit. Don't amend it silently into an earlier commit.
- After every update to `PROGRESS.md` or `docs/notes/*`, as a `docs:` commit.
- A work-in-progress commit is allowed only when stopping mid-step at the end of a session: `wip(scope): ...`. The next session's first commit completes it.

### Message format (Conventional Commits)

```
<type>(<scope>): <imperative summary, ≤72 chars>

<optional body: why, not what; mention verification done>
```

**Types:**

| Type | Use for |
|------|---------|
| `feat` | new capability |
| `fix` | bug fix |
| `chore` | tooling, deps, config |
| `docs` | documentation |
| `test` | tests |
| `refactor` | no behaviour change |
| `build` | Dockerfiles, images |
| `ci` | CI config |
| `perf` | performance |
| `security` | hardening |

**Scopes:** `repo`, `store`, `wp-image`, `woo-mcp`, `shipping-mcp`, `everything-mcp`, `gateway`, `auth`, `audit`, `upstreams`, `chat`, `dashboard`, `helm`, `netpol`, `postgres`, `dod`, `vps`, `docs`.

**Good examples:**

- `feat(woo-mcp): add list_orders tool with server-side "today" in Asia/Kolkata`
- `fix(store): use rest_route query form to avoid canonical redirect`
- `chore(helm): add resource requests and limits to mariadb statefulset`
- `test(gateway): cover tools/list when one upstream times out`
- `security(gateway): reject server URLs resolving to link-local addresses`

**Bad examples:** `update`, `fixes`, `wip`, `final`, `added stuff and fixed bugs`.

### Safety rules for git

- **Never commit secrets.** Before the first commit, set up a pre-commit hook running `gitleaks protect --staged` (or an equivalent secret scan). Also add a `.gitignore` covering `.env*`, `*.local.yaml` secret overrides, `node_modules`, `dist` and `kubeconfig*`.
- Never `git push --force`. Never rewrite pushed history. Never squash at the end — the granular history *is* the point.
- Never backdate or fabricate commits. History must reflect real work.
- Work on `main` (single developer, linear history). Use a short-lived branch only for a risky experiment, and merge with `--no-ff` so the experiment stays visible.
- **Push to `origin main` at the end of every session** (after the session's checks pass). Also push at any natural milestone mid-session, so work is never lost.
- Tag phase milestones: `git tag -a phase-1-store -m "..."`, `phase-2-woo-mcp`, and so on, plus `v1.0.0-submission` at the end. Push tags too.
- At the end of each session, report `git log --oneline` for that session's commits.

---

## PART 1 — WHAT IS ACTUALLY BEING GRADED

The Definition of Done is the grading rubric. Every line must be demonstrable live with **two users**: A = admin, B = member.

| # | DoD check | Satisfied by |
|---|-----------|--------------|
| 1 | Storefront: add to cart, check out with COD | store chart; setup Job enables COD |
| 2 | Order visible in WooCommerce admin | stock WC admin |
| 3 | Chat (A): "create product X at ₹Y" → it appears on the storefront | chat → gateway → woo-mcp `create_product` |
| 4 | Manual order, then chat "what orders came in today?" returns it | woo-mcp `list_orders`; store TZ is Asia/Kolkata |
| 5 | External client (Claude Code / Cursor / Inspector), with only the gateway URL and B's key, sees all enabled tools | gateway `/mcp` endpoint (Streamable HTTP) |
| 6 | B asks the orders question from the external client | as #4 |
| 7 | One prompt needs tools from two upstreams | woo + shipping (§2.4) |
| 8 | Revoke B's key → next call rejected | per-request key lookup + session teardown |
| 9 | Disable a server → its tools vanish from chat and the external client | cache rebuild + `notifications/tools/list_changed` |
| 10 | Kill an upstream pod → others keep working; dashboard shows Unreachable | per-upstream isolation, timeouts, health loop |
| 11 | Every call above is in the audit log, attributed to the right user | single audited `executeToolCall` path |

### Easy-to-forget mandatory items

- Helm only, no Kustomize. `values-local.yaml` + `values-prod.yaml`, same charts.
- Everything in-cluster: WordPress, MariaDB, woo-mcp, gateway, dashboard, the gateway DB, and any upstreams you host.
- PVCs for MariaDB and WordPress content.
- Ingress with stable URLs for the storefront and dashboard. The local domain approach is documented.
- Readiness and liveness probes, plus requests and limits, on **every** workload. Jobs get limits too.
- No secrets in source. Everything goes in Kubernetes Secrets, including the LLM key.
- woo-mcp is written by us and speaks Streamable HTTP. Its tools: list products, create product, list orders, get order, update order status.
- woo-mcp is **not reachable from outside the cluster**: ClusterIP plus a NetworkPolicy, shown both ways.
- At least 3 upstreams. A documented collision scheme. Timeouts with clear errors.
- Upstream credentials never reach the browser or an MCP client. API keys are hashed. Two roles.
- Deliverables:
  - README covering local setup, VPS setup, and how to order, connect a client and use chat
  - DESIGN note
  - THREAT MODEL note (four specific questions, see Part 6)
  - a list of the bonus and stand-out items attempted

### Disqualifying mistakes

- Installing an existing WooCommerce MCP server or plugin.
- woo-mcp exposed via Ingress or NodePort.
- The chat agent calling upstreams directly.
- Plaintext keys in the DB.
- Secrets committed to git.
- A demo you can't explain.

---

## PART 2 — ARCHITECTURE DECISIONS (made; don't relitigate without a concrete reason)

### 2.1 Stack

**Language: TypeScript everywhere**, in a pnpm workspace monorepo.

- The official `@modelcontextprotocol/sdk` is the reference implementation for both the Streamable HTTP server and client transports.
- One language means one toolchain and shared types.

**Gateway:** Node 22 + Express (the most MCP SDK examples use it) + Postgres via `pg`, with plain SQL migrations run at startup. Zod for validation.

**Dashboard:** React + Vite + TypeScript, served by an `nginx-unprivileged` container. It calls only the gateway's `/api/*`.

**Cluster:** k3d locally and k3s on the VPS. The parity argument:

- same distro
- same Traefik ingress (ingress-nginx is retired upstream, so Traefik is also the forward-looking choice)
- same `local-path` storage
- same built-in NetworkPolicy enforcement

**Local domains** use `*.localtest.me` (public DNS that resolves to 127.0.0.1), with an `/etc/hosts` fallback documented:

| Host | Serves |
|------|--------|
| `shop.localtest.me` | storefront |
| `yard.localtest.me` | dashboard + `/api` |
| `mcp.localtest.me` | the gateway's MCP endpoint |

k3d is created with `-p "80:80@loadbalancer" -p "443:443@loadbalancer"`.

**Names:**

- Helm release: `switchyard`
- Images: `switchyard-gateway`, `switchyard-dashboard`, `switchyard-woo-mcp`, `switchyard-shipping-mcp`, `switchyard-wordpress`

**Verify before coding, then pin all versions:**

- the latest stable `@modelcontextprotocol/sdk` and its current Streamable HTTP class names and options
- the current MCP spec revision
- WordPress and WooCommerce versions
- the MCP "everything" reference server package and how to start it in Streamable HTTP mode

### 2.2 Repository layout

```
switchYard/
├── CLAUDE.md  PLAYBOOK.md  PROGRESS.md  README.md  Makefile  .gitignore
├── apps/
│   ├── gateway/          # REST API + MCP endpoint + upstream client pool + chat agent
│   ├── dashboard/        # React SPA
│   ├── woo-mcp/          # our WooCommerce MCP server
│   └── shipping-mcp/     # second upstream, requires a bearer credential
├── images/wordpress/     # official wordpress + wp-cli + pinned WooCommerce baked in
├── charts/switchyard/    # umbrella chart
│   ├── Chart.yaml  values.yaml  values-local.yaml  values-prod.yaml
│   └── charts/ store/ woo-mcp/ shipping-mcp/ everything-mcp/ gateway/ dashboard/ postgres/
├── scripts/  dod.ts  k3d-up.sh  demo-reset.sh
└── docs/ ASSIGNMENT.md  DESIGN.md  THREAT_MODEL.md  REQUIREMENTS_MATRIX.md  DEMO_SCRIPT.md  VPS.md  notes/
```

### 2.3 Namespaces and network

| Namespace | Workloads | Public? |
|-----------|-----------|---------|
| `store` | WordPress Deployment (PVC), MariaDB StatefulSet (PVC), setup Job | storefront via Ingress |
| `mcp` | woo-mcp, shipping-mcp, everything-mcp | **no** — ClusterIP only |
| `platform` | gateway, dashboard, Postgres (PVC) | dashboard + `/mcp` via Ingress |

**NetworkPolicies:** default-deny ingress and egress per namespace, then these allows:

- `mariadb` accepts traffic only from `wordpress` and the setup Job.
- `woo-mcp` accepts ingress only from `app=gateway` pods in `platform`. Its egress goes only to the `wordpress` Service and kube-dns.
- `shipping-mcp` and `everything-mcp` accept ingress only from the gateway.
- The gateway's egress goes to the `mcp` namespace, Postgres, kube-dns, and 443 for the LLM provider and approved external upstreams.
- Postgres accepts traffic only from the gateway.
- Ingress controller (Traefik) to wordpress, dashboard and gateway is allowed.

**Proof for the video:** curl `woo-mcp.mcp:3000/mcp` from a throwaway pod in `store`. It times out. The same call from a gateway-labelled pod works.

**All containers** get `runAsNonRoot`, `allowPrivilegeEscalation: false`, all capabilities dropped, and `readOnlyRootFilesystem` where feasible (with an `emptyDir` for `/tmp`). Document honestly where WordPress/Apache needs exceptions.

### 2.4 Upstreams (3 + optional 4th)

1. **woo-mcp** — ours, in-cluster, uses the WooCommerce REST API v3.
2. **shipping-mcp** — ours, in-cluster. It **requires a static bearer token** that only the gateway holds. Its tools are deterministic:
   - `quote_shipping(city | pincode, weight_kg)`
   - `list_zones`
   - `search` (searches zones)

   The cross-server demo prompt: *"List today's orders and get a shipping quote for each to its billing city."*
3. **everything-mcp** — the official MCP reference "everything" server, run in-cluster in Streamable HTTP mode. It proves the gateway works with a third-party implementation, not just our own code.
4. *(Optional)* a public no-auth remote MCP server, such as DeepWiki's. It shows an external upstream and motivates the SSRF allowlist.

**Collision demo:** woo-mcp and shipping-mcp both expose `search`. Through the gateway they appear as `woo__search` and `shipping__search`.

### 2.5 woo-mcp (apps/woo-mcp)

**Endpoints:**

- Streamable HTTP at `POST/GET/DELETE /mcp`
- `/healthz` for liveness
- `/readyz` for readiness (checks that WP REST is reachable)

**Why the REST API** (this goes in DESIGN.md):

- It is a versioned contract, and WooCommerce's own validation and hooks still run.
- The API key is scoped, not WP admin.
- There's no exec inside the WP pod and no RBAC.

**Rejected alternatives:**

- WP-CLI via exec: needs broad `pods/exec` RBAC and means parsing brittle output.
- Direct MySQL: bypasses WooCommerce logic and couples us to the schema.

**Tools** (Zod schemas, concise descriptions, compact outputs that strip WC's bulky payloads):

- `list_products({search?, status?, per_page?=20, page?})`
- `create_product({name, regular_price, description?, sku?, stock_quantity?, status?="publish"})` — **`regular_price` is a string**.
- `list_orders({date?: "today" | "YYYY-MM-DD", after?, before?, status?, per_page?, page?})` — "today" is computed server-side in the store timezone.
- `get_order({id})`
- `update_order_status({id, status})` — `status` is an enum.
- `search({query})` — product search.

**Errors** become `isError: true` results with readable text, never stack traces.

**Gotchas:**

- **WC consumer-key auth over plain HTTP requires OAuth 1.0a signing.** Basic auth and query-string keys are HTTPS-only, and in-cluster traffic is HTTP. Implement and unit-test one-legged HMAC-SHA256 signing, or use a maintained WC REST client library (a REST client is fine; only an existing *MCP server* is banned). Document the choice.
- **WordPress canonical redirects** can bounce internal calls to `siteurl`. Use `?rest_route=/wc/v3/...` and/or send the public `Host` header.
- **Timezone:** the setup Job sets `timezone_string=Asia/Kolkata`.

### 2.6 Store chart (charts/switchyard/charts/store)

**No Bitnami dependency.** It's a reproducibility risk. Instead, write simple templates:

- a MariaDB StatefulSet (official `mariadb` image)
- a WordPress Deployment

**Image `images/wordpress`:** official `wordpress:<pinned>-apache` + `wp-cli` + the pinned WooCommerce zip baked in. Nothing is downloaded at runtime.

**Setup Job:** a Helm `post-install,post-upgrade` hook with `before-hook-creation` delete policy. It is idempotent, uses the same image, and mounts the WP PVC (RWO on a single node is fine; document the limit). Steps:

1. Wait for the DB and `wp-config.php`.
2. Run `wp core is-installed || wp core install ... --skip-email`.
3. Activate WooCommerce. Set permalinks, Asia/Kolkata, INR and the store address, and skip onboarding.
4. Enable **Cash on Delivery**.
5. Seed about 5 products.
6. **Create the WC REST key with no RBAC.** Helm generates `ck_…`/`cs_…` into a Secret. The Job inserts them into `wp_woocommerce_api_keys` via `wp eval`, after deleting any row with the same description (idempotent). Check current WC source for the exact `wc_api_hash` and `truncated_key` format. woo-mcp reads the same Secret.

**Probes:**

- WordPress readiness: `httpGet /wp-login.php`.
- WordPress liveness: `tcpSocket :80`. Avoid DB-dependent liveness, which causes restart storms.
- MariaDB: the image's `healthcheck.sh --connect --innodb_initialized`.

### 2.7 Gateway (apps/gateway)

#### Postgres schema

- `users(id, email, name, role[admin|member], password_hash, created_at, disabled_at)`
- `invites(id, email, role, token_hash, expires_at, accepted_at)`
- `api_keys(id, user_id, name, prefix, key_hash, created_at, last_used_at, revoked_at)`
- `servers(id, slug, name, url, auth_type[none|bearer|header], auth_header_name, credential_ciphertext, credential_iv, credential_tag, enabled, status, last_error, last_checked_at, tools_snapshot jsonb, tools_hash, created_at)`
- `audit_log(id, ts, user_id, api_key_id, source[mcp|chat], server_slug, tool, duration_ms, outcome[success|error|timeout|denied|unavailable], error, args_preview)`
- later: `tool_policies`, `tool_pins` (Part 4)

#### Auth

- **API keys** are `syk_` + 32 random bytes in base64url, shown once.
  - The DB stores the **SHA-256** of the key plus an 8-character display prefix. SHA-256 rather than bcrypt is right here: the key is high-entropy and is checked on every request. Be ready to explain this.
  - Comparisons are constant-time.
- **Dashboard login** is email + password (argon2id or bcrypt) with an httpOnly, SameSite=Lax session cookie. The admin is seeded from a Secret on first boot.
- **Invites:** admin creates an invite, the invitee gets a token link, sets a password, and becomes a member.
- **Revocation is immediate.** The key is looked up on **every** MCP request. On revoke, the gateway closes MCP sessions bound to that key.

#### Upstream manager (client side)

- One long-lived `Client` + `StreamableHTTPClientTransport` per enabled upstream. Credentials are injected **only here**.
- Credentials are decrypted in memory from AES-256-GCM. The master key `GATEWAY_ENC_KEY` comes from a Secret.
- **Health loop** every 10–15 s per server: `ping`/`listTools` with a 3 s timeout. The outcome is `Connected`, `Unreachable` (with a reason: DNS / refused / timeout / 401 / protocol), or `Disabled`.
- **Upstream session loss** (the pod restarted, and its session now returns 404/400): drop the client and re-initialize transparently. Test this explicitly.
- **Tool cache** is the union of snapshots from Connected and enabled servers. When it changes, send `notifications/tools/list_changed` to every open downstream session. This is what makes DoD #9 live in Claude Code.

#### Aggregation and routing (server side)

- Use the SDK's **low-level `Server`**, not `McpServer`, which registers static tools. Handle `tools/list` and `tools/call` directly. Declare `capabilities.tools.listChanged = true`.
- **Naming:** expose every tool as `<serverSlug>__<toolName>`, always, not only on collision.
  - This is deterministic, so names don't change when a new server is added.
  - Slugs match `^[a-z][a-z0-9_]{1,15}$`.
  - The final name must satisfy `^[a-zA-Z0-9_-]{1,64}$`. If it's too long, truncate and add a short hash, recording the mapping.
  - Prefix each description with `[Server name]`.
- `tools/list` reads only the cache, so it never blocks on a slow upstream.
- **`tools/call` flow:**
  1. Parse the prefix.
  2. Check the server is enabled and Connected.
  3. Check policy.
  4. Forward with a **15 s AbortSignal timeout**.
  5. Return the result.

  Failures become `isError: true` with clear text, for example: `"Server 'shipping' is unreachable (connection refused at 14:02:11). Other servers are unaffected."` An unknown tool returns a JSON-RPC error.
- **One function, `executeToolCall(ctx, name, args)`, writes the audit row for every outcome.** Both `/mcp` and chat use it. Args previews are truncated to about 500 characters.
- **Downstream sessions:** stateful Streamable HTTP with `Mcp-Session-Id`. Each session is bound to its API key, and `Authorization: Bearer` is re-validated on every request. Validate the `Origin` header (spec guidance on DNS rebinding).
- **Never pass the client's token upstream.** The MCP spec forbids token passthrough.

#### SSRF guard on Add Server

- Resolve the host and reject link-local (169.254.0.0/16, which includes metadata endpoints), loopback and private ranges, **unless** the host matches `allowedInternalHosts` from Helm values (default `*.mcp.svc.cluster.local`).
- Re-check on every connect, to defend against DNS rebinding.
- Don't follow redirects.

#### REST API

| Route | Who | Notes |
|-------|-----|-------|
| `/api/auth/*`, `/api/me` | everyone | |
| `/api/keys` | own keys only | |
| `/api/users`, `/api/invites` | admin | |
| `/api/servers` CRUD + `/test` | admin | credential is **write-only**; responses only show `hasCredential: true` |
| `/api/audit` | admin: all; member: own | |
| `/api/chat` | everyone | |

Authorization is enforced server-side, not just hidden in the UI.

### 2.8 Chat agent

- It runs in the gateway backend. The browser never sees the LLM key or upstream credentials.
- **It is a real MCP client to the gateway's own `/mcp`.** It authenticates with a short-lived token minted for the logged-in user, so "everything goes through the gateway" is literally true. Audit rows show that user with `source=chat`.
- **Provider-agnostic:** OpenAI-compatible Chat Completions configured by `LLM_BASE_URL`, `LLM_MODEL`, and a key from a Secret. That covers Groq, Gemini's OpenAI-compatible endpoint, OpenRouter free models and Ollama. Verify current free-tier limits.
- **The loop:**
  1. Fetch the tool list each turn.
  2. Sanitize schemas for the provider (strip `$schema` and unsupported keywords).
  3. Call the model.
  4. Run tool calls via MCP.
  5. Feed results back, truncated to about 4k characters.
  6. Repeat for at most 8 iterations.

  The system prompt includes the current date and time in Asia/Kolkata.
- **The UI** shows a chip for each tool call: tool, server, args, duration, outcome and a truncated result.
- If the LLM is down or rate-limited, the chat shows a clear error and nothing crashes.

### 2.9 Dashboard

| Page | Contents |
|------|----------|
| Login, Accept invite | |
| **Servers** | name, URL, status badge + reason + last checked, tool count; expandable tool list with descriptions; add / edit / disable / remove / test |
| **Members** | invite, roles, revoke keys |
| **My API keys** | generate → shown once, with a copy button and a ready `claude mcp add` command |
| **Audit log** | filters by user / server / outcome; auto-refresh |
| **Chat** | |

Keep it plain and fast, with empty, loading and error states everywhere.

### 2.10 Helm: local vs prod (values only)

| Concern | values-local.yaml | values-prod.yaml |
|---------|-------------------|------------------|
| Hosts | `shop`/`yard`/`mcp` `.localtest.me` | `shop.<domain>` etc., or `*.<ip>.sslip.io` |
| TLS | off | cert-manager + Let's Encrypt (Traefik) |
| Images | local tags via `k3d image import` | `ghcr.io/okayniti/switchyard-*:<git-sha>`, multi-arch if the VPS is ARM |
| Storage | `local-path` | `local-path` (k3s), with a note on swapping storage class |
| Secrets | generated by Helm with `lookup`, stable across upgrades | `existingSecret:` names, created out-of-band by a documented script |
| Resources | small | slightly larger |

**Upgrade and rollback story:**

- Upgrade with `helm upgrade switchyard charts/switchyard -f values-prod.yaml --set gateway.image.tag=<sha>`, and inspect with `helm history`.
- Roll back with `helm rollback switchyard <rev>`.
- Migrations are additive, so rolling back app code stays compatible with the DB.
- Data on PVCs survives both directions.
- A WooCommerce bump means rebuilding the WP image. The `post-upgrade` Job then runs the DB update.
- Take a DB-dump Job before upgrading the store.

### 2.11 Makefile

| Target | Does |
|--------|------|
| `make up` | create k3d cluster, build and import images, helm install local |
| `make down` | tear down |
| `make dod` | run the DoD check script |
| `make test` | run tests |
| `make lint` | `helm lint`, `helm template \| kubeconform`, eslint, tsc |
| `make logs` | tail logs |
| `make admin-password` | print the seeded admin password |

### 2.12 Automated Definition of Done (`scripts/dod.ts`) — a differentiator

A TypeScript MCP SDK client run against the real cluster. It prints PASS/FAIL with evidence for each check:

1. User B lists tools from all three servers, and the collision names are present.
2. User A creates a product via the gateway, and it is visible on the storefront.
3. An order created via WC REST (standing in for manual checkout) is found in "today" orders by B.
4. The cross-server call works.
5. After B's key is revoked, the call returns 401.
6. After shipping is disabled, its tools are gone and `list_changed` is received.
7. After `kubectl delete pod` on everything-mcp, woo still works and the status flips to Unreachable.
8. Audit rows exist for each step, with the correct user.

The manual checkout and external-client steps are still shown by hand in the video.

---

## PART 3 — PHASE PLAN WITH EXPECTED COMMIT SEQUENCES

These are the *expected* commits per phase. Claude Code may add more (fixes, tests); it must never merge several into one. Each phase ends with:

1. a `docs(progress)` commit
2. a `docs(notes)` commit
3. a tag
4. a push

### Phase 1 — Scaffold, cluster, store (17 Oct)

1. `chore(repo): add .gitignore and editorconfig`
2. `chore(repo): add gitleaks pre-commit hook`
3. `docs(repo): add assignment brief, playbook and CLAUDE.md`
4. `chore(repo): initialize pnpm workspace`
5. `docs(progress): add PROGRESS.md with phase checklist`
6. `chore(repo): add k3d cluster create script`
7. `chore(repo): add Makefile with up/down targets`
8. `build(wp-image): add wordpress Dockerfile with wp-cli`
9. `build(wp-image): bake pinned WooCommerce plugin into image`
10. `chore(helm): scaffold switchyard umbrella chart`
11. `chore(helm): scaffold store subchart`
12. `feat(store): add mariadb secret generated with lookup`
13. `feat(store): add mariadb statefulset with pvc`
14. `feat(store): add mariadb service`
15. `chore(store): add mariadb probes and resource limits`
16. `feat(store): add wordpress deployment with pvc`
17. `feat(store): add wordpress service`
18. `chore(store): add wordpress probes and resource limits`
19. `feat(store): add storefront ingress on shop.localtest.me`
20. `feat(store): add setup job that installs wordpress core`
21. `feat(store): activate woocommerce and set INR + Asia/Kolkata in setup job`
22. `feat(store): enable cash on delivery in setup job`
23. `feat(store): seed sample products in setup job`
24. `feat(store): generate WC REST key secret and register it in setup job`
25. `chore(helm): add values-local.yaml`
26. `chore(helm): add values-prod.yaml stub`
27. `fix(...)` commits for anything found during `make up` verification, one each
28. `test(store): verify setup job idempotency across two helm upgrades` (a script or documented check)
29. `docs(notes): explain every k8s object in phase 1`
30. `docs(progress): mark phase 1 complete`
31. Then tag `phase-1-store` and push.

### Phase 2 — woo-mcp (18 Oct)

1. `chore(woo-mcp): scaffold package with tsconfig and vitest`
2. `feat(woo-mcp): add WC REST client with OAuth1 signing`
3. `test(woo-mcp): cover OAuth1 signature generation`
4. `feat(woo-mcp): use rest_route form to avoid canonical redirects`
5. `feat(woo-mcp): add streamable HTTP MCP server skeleton`
6. `feat(woo-mcp): add healthz and readyz endpoints`
7. `feat(woo-mcp): add list_products tool`
8. `feat(woo-mcp): add create_product tool`
9. `feat(woo-mcp): add list_orders tool with server-side today`
10. `feat(woo-mcp): add get_order tool`
11. `feat(woo-mcp): add update_order_status tool`
12. `feat(woo-mcp): add search tool`
13. `feat(woo-mcp): map WooCommerce errors to readable tool errors`
14. `test(woo-mcp): ...` — one commit per tool test
15. `build(woo-mcp): add non-root Dockerfile`
16. `chore(helm): add woo-mcp subchart with ClusterIP service`
17. `chore(woo-mcp): add probes and resource limits`
18. `security(netpol): default-deny in mcp namespace`
19. `security(netpol): allow woo-mcp ingress only from gateway`
20. `security(netpol): restrict woo-mcp egress to wordpress and dns`
21. `docs(design): explain REST API choice over WP-CLI and DB`
22. `docs(notes): MCP initialize/list/call flow with captured examples`
23. `docs(progress): mark phase 2 complete`
24. Then tag `phase-2-woo-mcp` and push.

### Phase 3 — Gateway core (19–20 Oct)

Commit after each item; a `test(...)` commit follows each feature where testable.

**Setup and data:**

- scaffold gateway package
- config loading from env
- Postgres subchart: secret, statefulset + PVC, service, probes, limits
- migration runner
- one migration per table

**Auth:**

- password hashing
- session login/logout
- admin seeding from secret
- invites (create, accept)
- API key create (returns once)
- key hashing and lookup
- key revoke
- authZ middleware for roles

**Upstreams:**

- AES-GCM credential encryption + key secret
- servers CRUD API with write-only credential
- SSRF guard
- upstream client pool
- health loop with reasons
- reconnect on session loss
- tool cache

**MCP endpoint:**

- low-level MCP server on `/mcp`
- bearer auth per request
- Origin validation
- session binding to key
- namespaced `tools/list`
- `tools/call` routing
- per-call timeout
- clear unavailable/timeout errors
- `list_changed` broadcast
- close sessions on key revoke

**Audit:**

- `executeToolCall` with audit row
- audit API

**Other upstreams:**

- shipping-mcp: scaffold, `quote_shipping`, `list_zones`, `search`, bearer auth requirement, Dockerfile, subchart, probes/limits, netpol
- everything-mcp: subchart in Streamable HTTP mode, probes/limits, netpol

**Wiring and docs:**

- seed three servers on first boot (woo first)
- gateway Dockerfile
- gateway subchart, ingress for `mcp.localtest.me`, probes, limits, netpol
- a `fix(...)` commit for each verification finding
- `docs(notes)`: trace one `tools/call` hop by hop, and where isolation is enforced
- `docs(progress)`
- tag `phase-3-gateway`, push

### Phase 4 — Dashboard (21 Oct)

Commit after each item:

- scaffold Vite app
- API client
- login page
- accept-invite page
- layout/nav
- servers list with status badges
- server tools view
- add-server form
- edit/disable/remove
- test-connection button
- members page
- invite flow UI
- my keys page with show-once modal
- `claude mcp add` snippet
- audit log table
- audit filters
- audit auto-refresh
- empty/loading/error states (one commit per page)
- nginx-unprivileged Dockerfile
- dashboard subchart + ingress `yard.localtest.me`, probes, limits, netpol
- `fix`es
- `docs(notes)`, `docs(progress)`
- tag `phase-4-dashboard`, push

### Phase 5 — Chat agent (22 Oct)

Commit after each item:

- LLM provider config + secret
- OpenAI-compatible client
- per-user short-lived internal token
- internal MCP client to own `/mcp`
- schema sanitizer + test
- tool loop with iteration cap
- result truncation
- system prompt with IST date
- `/api/chat` endpoint
- chat UI
- tool-call chips
- LLM-failure handling
- `fix`es
- `docs(notes)`, `docs(progress)`
- tag `phase-5-chat`, push

### Phase 6 — DoD automation + hardening (23 Oct)

Commit after each item:

- dod script scaffold
- one commit per DoD check
- `make dod` target
- each hardening finding as its own `fix`/`security` commit (probes, limits, securityContext, secrets scan, input validation)
- `make lint` target with helm lint + kubeconform
- requirements matrix with evidence
- `docs(progress)`
- tag `phase-6-dod-green`, push

### Phase 7 — Differentiators (24 Oct, only if DoD is green)

Commit after each item:

**VPS:**

- prod values: hosts, TLS, existingSecret
- secrets bootstrap script
- multi-arch image build
- `docs/VPS.md`
- one commit per real fix found while deploying

**Tool permissions:**

- migration
- policy evaluation + tests
- hide in `tools/list`
- reject in `tools/call`
- audit `denied`
- admin UI
- dod check

**Tool pinning:**

- migration
- hash on approve
- detect drift
- quarantine
- diff view
- poisoned-description Helm flag on shipping-mcp
- dod check

**Wrap-up:** tag `phase-7-standout`, push.

### Phase 8 — Docs (25 Oct)

One commit per section:

- README: local setup, VPS setup, place an order, connect a client, use chat, `make dod`, troubleshooting
- DESIGN: architecture diagram, aggregation/routing, failure handling, naming scheme, REST choice, local-vs-prod, upgrade/rollback
- THREAT_MODEL: one commit per question
- stand-out list

Then tag `phase-8-docs` and push.

### Phase 9 — Demo (25–26 Oct)

Commits:

- `scripts/demo-reset.sh`
- `docs/DEMO_SCRIPT.md`
- any last fixes
- final `docs(progress)`

Then:

- tag `v1.0.0-submission` and push
- run a secrets scan of the full history (`gitleaks detect`) before making the repo public

---

## PART 4 — DIFFERENTIATORS (only after `make dod` is green)

Do these in order and stop when time runs out.

1. **VPS deployment** (stand-out #1). The same charts run on k3s with TLS, which proves "same Helm charts, config only".
   - Needs ≥4 GB RAM.
   - Options, with current pricing to check: Oracle Cloud Always Free ARM, a small Hetzner instance, or cloud credits.
   - On ARM, build multi-arch images with `docker buildx`.
2. **Tool permissions** (stand-out #2). Members get read tools (`list_*`, `get_*`, `search`, `quote_*`); admins get everything.
   - Denied tools are **hidden from `tools/list` and rejected on direct calls**, audited as `denied`.
   - User A (admin) does the create-product DoD step.
3. **Tool-definition pinning against malicious upstreams.**
   - The admin approves a server's tools, and the gateway stores a hash of name + description + schema.
   - If a definition later changes (rug pull or tool poisoning), that tool is quarantined and flagged with a diff until re-approved.
   - Descriptions are length-capped and shown verbatim to the admin.
   - Demo: flip a Helm flag on shipping-mcp to serve a manipulative description. The tool disappears and the diff shows up.
4. **Observability:** `/metrics` with calls, errors and latency per server.
5. **Multi-store bonus:** only if 1–3 are done by 24 Oct. Otherwise state "not attempted" honestly in the README, with a short design paragraph.

---

## PART 5 — SESSION PROMPTS (paste one per Claude Code session)

Every prompt implicitly includes: *"Follow PLAYBOOK Part 0 commit discipline: commit after every single step, push and tag at the end, and show me `git log --oneline` for this session."*

### Session 0 — Ground truth (plan mode)

```
Read CLAUDE.md, PLAYBOOK.md and docs/ASSIGNMENT.md fully. Check `git status` and `git log`
to see the repo's current state (it may already contain a README or LICENSE from GitHub —
keep and build on them).
1. Produce docs/REQUIREMENTS_MATRIX.md mapping every mandatory requirement and DoD line in
   ASSIGNMENT.md -> component -> file(s) -> verification method. Flag any conflict between
   PLAYBOOK.md and ASSIGNMENT.md (the assignment wins).
2. Check and record current versions: @modelcontextprotocol/sdk (and its current Streamable
   HTTP server/client class names), the MCP "everything" reference server package and its
   streamable HTTP start command, WordPress image tags, WooCommerce, k3d, Helm, Node 22.
3. Create PROGRESS.md with phases 1–9 as checkboxes and a "Pinned versions" section.
Commit each file separately (Part 0), push, then stop and show me the matrix and conflicts.
```

### Session 1 — Scaffold + cluster + store

```
Execute PLAYBOOK Phase 1 (Part 3) using the design in §2.1–2.3, §2.6, §2.10–2.11. Follow the
expected commit sequence; commit after every step, plus one fix commit per issue found.
Verify for real: `make up`, curl https/http shop.localtest.me, run `helm upgrade` twice to prove
the setup Job is idempotent, and from inside the cluster call the WC REST API with the
generated key to prove the auth method works over HTTP. Paste real outputs. Give me the
storefront URL and how to read the admin password so I can do a manual COD checkout.
Write docs/notes/phase-1.md explaining every K8s object in plain English. Update PROGRESS.md.
Tag phase-1-store, push, show git log --oneline for this session.
```

### Session 2 — woo-mcp

```
Execute PLAYBOOK Phase 2 per §2.5. Follow the commit sequence. Handle the OAuth1-over-HTTP and
canonical-redirect gotchas with tests. Verify: vitest; port-forward and call every tool with MCP
Inspector or an SDK client script; prove a pod in the store namespace cannot reach woo-mcp.
Write docs/notes/phase-2.md showing the real initialize -> tools/list -> tools/call exchange
captured from this server. Update PROGRESS.md, tag phase-2-woo-mcp, push, show git log.
```

### Session 3 — Gateway core (plan mode first; may span two sessions)

```
Execute PLAYBOOK Phase 3 per §2.4 and §2.7, including shipping-mcp and everything-mcp. Show me
the plan first. Then implement in the order listed, committing after every item and its test.
Verify live: connect MCP Inspector to mcp.localtest.me/mcp with a key; list tools from all
three servers (show woo__search and shipping__search); call one tool per server; delete the
everything-mcp pod and show woo still works and status becomes Unreachable with a reason;
revoke the key and show the 401. Paste outputs. Write docs/notes/phase-3.md tracing one
tools/call hop by hop with function names, and where isolation is enforced.
If the session runs long, stop at a clean commit, mark progress in PROGRESS.md, push, and tell
me exactly where to resume. Tag phase-3-gateway when done.
```

### Session 4 — Dashboard

```
Execute PLAYBOOK Phase 4 per §2.9, committing after every item. Verify by clicking through
every page (use the browser tool if available) and confirm in network responses that no
upstream credential ever appears. Update PROGRESS.md, tag phase-4-dashboard, push, show git log.
```

### Session 5 — Chat agent

```
Execute PLAYBOOK Phase 5 per §2.8, committing after every item. Verify live: as admin "create a
product called Masala Chai Kit priced 499" -> visible on the storefront; after I place a COD
order by hand, "what orders came in today?" returns it; the cross-server prompt from §2.4 works;
the audit log shows source=chat under the right user. Tag phase-5-chat, push, show git log.
```

### Session 6 — DoD + skeptical evaluator

```
Execute PLAYBOOK Phase 6: build scripts/dod.ts per §2.12 (one commit per check) until `make dod`
is green. Then review like a skeptical evaluator, line by line against ASSIGNMENT.md and
REQUIREMENTS_MATRIX.md: probes, limits, securityContext on every workload, secret scan, helm
lint + kubeconform, bad inputs (invalid price, unknown tool, malformed JSON-RPC, expired session,
disabled user). Each finding is its own fix commit. Fill the matrix with evidence. Report the
three weakest remaining points. Tag phase-6-dod-green, push, show git log.
```

### Session 7 — Differentiators (plan mode first)

```
Only if `make dod` is green. Execute PLAYBOOK Phase 7 / Part 4 items 1–3 in order, committing
after every item. For the VPS, prepare prod values, scripts and docs/VPS.md, then walk me
through the commands I must run on the server myself — do not handle my cloud credentials or
create cloud resources. Add each feature to `make dod`. Tag phase-7-standout, push, show git log.
```

### Session 8 — Docs

```
Execute PLAYBOOK Phase 8 with one commit per document section. Every claim must match the code:
verify each by grepping or running it; no invented numbers. THREAT_MODEL.md must answer the four
questions in PLAYBOOK Part 6. Tag phase-8-docs, push, show git log.
```

### Session 9 — Demo rehearsal

```
Execute PLAYBOOK Phase 9: write scripts/demo-reset.sh and docs/DEMO_SCRIPT.md per Part 7, one
commit each. Run `gitleaks detect` on the full history and report. Tag v1.0.0-submission and
push. Then quiz me with 15 hard interview questions about this codebase (K8s internals, MCP
flow, credential path, isolation, failure modes, why the commit history looks the way it does)
and grade my answers.
```

---

## PART 6 — THREAT MODEL CONTENT (the brief asks these four)

### 1. Shared upstream credentials — what can a member do with a credential they never see?

**Risk:** a member can do whatever that credential permits *through the tools exposed to them*. The credential can't be exfiltrated, but its authority is shared — a confused-deputy risk.

**Mitigations:**

- least-privilege upstream keys
- per-role tool permissions
- per-user audit
- rate limits

**Residual:** the upstream only ever sees "the gateway", so our audit log is the source of truth.

### 2. Why client tokens are not passed through

The MCP spec forbids it, for three reasons:

- **Audience confusion:** the token was minted for the gateway, not the upstream.
- **Replay:** a compromised upstream could replay it against the gateway or other upstreams.
- **Lost control:** the gateway would lose policy and audit control.

So the gateway terminates auth and then uses its own per-upstream credential.

### 3. Untrusted upstreams and manipulative tool descriptions

**Risk:** descriptions and results enter the LLM context and can carry injected instructions.

**Mitigations:**

- admin review plus definition pinning and quarantine
- server-name provenance in names and descriptions
- description length caps
- permissions that limit what write tools can do
- the chat showing every tool call
- an iteration cap
- (future) human confirmation for write tools

**Residual:** tool *results* can also inject instructions. That can be bounded, not fully solved.

### 4. What one member can do to another

**Cannot** (state only what's actually implemented):

- see others' keys
- revoke others' keys or change roles (enforced server-side)
- read others' audit entries

**Can:**

- affect shared state through shared tools
- exhaust shared quotas (mitigated by per-key rate limits)

Chat history is per-user.

### Also cover

- a compromised admin account
- SSRF via server URL
- DNS rebinding on `/mcp` (the Origin check)
- where the encryption master key lives
- what a compromised gateway pod exposes: everything. It's the trust anchor, so it gets NetworkPolicies, and in the core design it has **no** K8s API access.

---

## PART 7 — DEMO VIDEO OUTLINE (12–15 min, record in segments)

1. **Intro (30 s):** what Switchyard is, plus the architecture diagram.
2. **K8s tour (2 min):**
   - `kubectl get ns,pods,pvc,ingress,netpol -A`
   - a Secret's keys (not values)
   - probes and limits in a manifest
   - woo-mcp shown unreachable from outside and from `store`
3. **Store:** COD checkout, then the order in WC admin.
4. **User A chat:**
   1. Create a product, then refresh the storefront.
   2. Place an order by hand.
   3. Ask "orders today".
   4. Point out the tool chips.
5. **User B external:**
   1. Generate a key.
   2. Run `claude mcp add ...`.
   3. Show all tools (`woo__search` vs `shipping__search`).
   4. Ask the orders question.
   5. Run the cross-server prompt.
6. **Control:**
   - revoke B's key → the next call fails
   - disable shipping → its tools vanish in both chat and Claude Code
   - delete the everything-mcp pod → woo still works, and the dashboard shows Unreachable with a reason
   - the audit log filtered by user
7. **MCP internals:** a call traced through the code, the collision scheme, timeouts.
8. **Security:** key hashing, credential encryption, member vs admin, the malicious-server pinning demo.
9. **Local → VPS:** the values diff, the TLS URL live, `helm history`, `helm rollback`.
10. **Wrap-up:** `make dod` green, and a glance at `git log --oneline --graph` with the phase tags.

---

## APPENDIX A — CLAUDE.md (paste into CLAUDE.md)

```markdown
# Switchyard — Urumi FDE Round 1 (Team MCP Gateway on Kubernetes)
Repo: https://github.com/okayniti/switchYard
Requirements source of truth: docs/ASSIGNMENT.md. Design and plan: PLAYBOOK.md. State: PROGRESS.md.
If PLAYBOOK.md conflicts with ASSIGNMENT.md, ASSIGNMENT.md wins — tell me about the conflict.

## Commit discipline (PLAYBOOK Part 0) — always
- Commit after EVERY step, however small. One logical change per commit. If the summary needs
  "and", split it.
- Conventional Commits: type(scope): imperative summary ≤72 chars. Body says why + what was verified.
- Commit only after the step builds/lints/tests. Each verification fix is its own fix: commit.
- Never batch, never squash, never amend pushed commits, never force-push, never backdate.
- Never commit secrets; the gitleaks pre-commit hook must stay enabled.
- Push to origin main at the end of every session and at milestones. Tag each phase.
- End every session by showing `git log --oneline` for that session.

## Engineering rules
- Core Definition of Done first. No bonus/stand-out work until `make dod` passes.
- Never claim something works without running it; paste real output as evidence.
- No secrets in source or committed values files; credentials only via Kubernetes Secrets.
- Do not install any existing WooCommerce MCP server or plugin. woo-mcp is ours.
- Upstream MCP servers are never exposed via Ingress/NodePort/LoadBalancer.
- Every workload: readiness + liveness probes, requests + limits, non-root unless impossible (document why).
- Every tool call — from /mcp or chat — goes through executeToolCall and is audited.
- Pin versions. Prefer boring, well-documented choices. Keep code explainable: I must defend
  every line in a live interview.
- Ask before: creating cloud resources, anything that costs money, deleting the cluster or PVCs,
  making the repo public.
- After each phase: update PROGRESS.md and write docs/notes/phase-N.md in plain English.
```

---

## APPENDIX B — Things only you can do

- [ ] Paste the brief into `docs/ASSIGNMENT.md`.
- [ ] Install Docker Desktop, k3d, kubectl, Helm, Node 22, pnpm, gitleaks and the GitHub CLI (`gh auth login`).
- [ ] Get a free LLM API key (Groq / Gemini / OpenRouter). It goes into a Secret only.
- [ ] Do the manual COD checkout yourself in Phase 1 and in the video.
- [ ] Create the VPS and DNS, and run the server-side commands yourself.
- [ ] Read every `docs/notes/phase-N.md`. Ask Claude Code to explain anything you can't explain to a founder.
- [ ] Run `gitleaks detect` on the full history before making the repo public.
- [ ] Record the video, upload it unlisted, and test the link in incognito.
- [ ] Submit via the form in the brief on the afternoon of 26 Oct.
