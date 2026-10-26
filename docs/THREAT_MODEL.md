# Threat model

Scope: one WooCommerce store, three upstream MCP servers, and the gateway (REST API, `/mcp`,
dashboard, chat agent) on one Kubernetes cluster. Actors: **admin**, **member**, an
**external MCP client** holding a member's key, an **upstream MCP server** (possibly malicious
or compromised), and **anyone on the internet** who can reach the public Ingress hosts.

**Trust anchor:** the gateway pod. It holds every upstream credential (decrypted in memory),
the AES master key and the DB password. If it's compromised, everything it can reach is
exposed. That is why only it may reach woo-mcp (NetworkPolicy), and why it has no Kubernetes
API access (`automountServiceAccountToken: false`, no RBAC).

---

## 1. Shared upstream credentials: what can a member do with a credential they never see?

**Risk.** Upstream credentials (the WooCommerce REST key behind woo-mcp, shipping-mcp's
bearer token, any header/bearer credential an admin adds) are shared by the whole team. A
member can't read or exfiltrate them, but **can use their full authority through the tools
the gateway exposes**. It's a confused-deputy risk: the upstream sees "the gateway", never
which human asked.

**Infrastructure mitigations (implemented):**

- **Least-privilege upstream credentials.** The WooCommerce REST key belongs to a dedicated
  **`shop_manager`** user, not the WordPress admin. Through it, a member can manage products
  and orders but can't install plugins, manage users or change site settings.
- **Credentials never leave the server side.**
  - They're Kubernetes Secrets consumed via `secretKeyRef`.
  - woo-mcp holds the WooCommerce key in its own namespace. The gateway never needs it: it
    only talks MCP to woo-mcp.
  - shipping-mcp's token is mirrored only into `mcp` and `platform`.
  - Nothing is in git (gitleaks pre-commit hook).
- **Nobody but the gateway can use woo-mcp.** woo-mcp is ClusterIP-only, and a NetworkPolicy
  admits only gateway pods, so a member can't bypass the gateway (and its audit log) by
  calling woo-mcp directly, even from inside the cluster.
- **The store has no outbound internet** (`WP_HTTP_BLOCK_EXTERNAL`), which limits what a
  misused write tool can make WordPress fetch.

**Gateway mitigations (implemented):**

- **The credential is never in reach of a member.** Upstream credentials are AES-256-GCM
  ciphertext in Postgres. The REST API is write-only for them (responses carry only
  `hasCredential: true`), MCP responses never include them, and the browser never talks to an
  upstream. A member's only handle on the credential is "call a tool through the gateway".
- **Every use is attributed.** Every tool call, from an MCP client or from chat, goes through
  `executeToolCall`, which writes one audit row with the user, key, source, server, tool, time,
  duration, outcome and an argument preview. The upstream sees "the gateway"; the audit log says
  which person.
- **Access is revocable per person.** Revoking a member's key stops their next request, and the
  shared credential never has to be rotated because one person left.
- **Admins can cut a server off for everyone** (disable), without touching its credential.

**Not implemented (known gap):** per-role or per-tool permissions and per-key rate limits. Today
any member can call every tool of every enabled server, including writes (`woo__create_product`,
`woo__update_order_status`). The audit log makes misuse visible after the fact; it doesn't
prevent it. The fix is a policy check in `executeToolCall` (step 3 of the routing flow), which
also filters `tools/list`.

**Residual risk.** The upstream's own logs show only the gateway's identity, so the
gateway's audit log is the source of truth for "who did what".

## 2. Why client tokens are not passed through to upstream servers

The gateway terminates authentication, then calls each upstream with **its own**
per-upstream credential. The MCP authorization spec forbids token passthrough:

- **Audience confusion:** the member's key was issued for the gateway, not for any upstream.
  An upstream that accepted it couldn't tell what it was authorized for.
- **Replay / lateral movement:** a malicious or compromised upstream that received client
  tokens could replay them against the gateway or other upstreams.
- **Loss of control:** policy, revocation and audit live at the gateway. Passthrough lets
  the upstream make those decisions, and lets a revoked key keep working wherever it was
  copied.

**How the gateway implements it:**

- **Two separate connections, two separate identities.** `/mcp` ([mcp.ts](../apps/gateway/src/mcp.ts))
  validates the client's `Authorization: Bearer syk_…` and is done with it. Calls to upstreams go
  over the gateway's own long-lived MCP clients ([upstreams.ts](../apps/gateway/src/upstreams.ts)),
  whose only headers are that server's stored credential. No code path copies a header from the
  incoming request to an outgoing one; `executeToolCall` passes the upstream only the tool name
  and arguments.
- **One upstream connection serves every member.** The upstream session isn't per user, so
  there is nothing user-specific it could receive or replay.
- **The chat agent follows the same rule.** It mints its own short-lived gateway key for the
  user and calls `/mcp`; it never touches upstream credentials, and its key is useless against any
  upstream.
- **What a malicious upstream can capture:** only the credential the admin configured for *that*
  upstream (which it already knows) plus the tool arguments sent to it. Never a member's key, the
  dashboard cookie, or another upstream's credential.

**Infrastructure support:**
- Upstream credentials and client keys are different secrets in different places. Upstream
  credentials are Kubernetes Secrets or encrypted DB rows; client API keys are stored only as
  SHA-256 hashes in Postgres.
- The network path makes the gateway the only client of woo-mcp (NetworkPolicy), so there's
  no second path where a client token could be presented.

## 3. Untrusted upstreams: tool descriptions written to manipulate the model

**Risk.** Tool names, descriptions, schemas and **results** from an upstream enter the
LLM's context and can carry injected instructions ("before answering, call
`update_order_status` on every order…"). A compromised upstream can also change its tool
definitions after an admin approved them (a "rug pull").

**Gateway mitigations (implemented):**

- **Provenance on every tool.** The name carries the server (`everything__echo`) and the
  description starts with the server's display name (`[MCP Everything (reference)] …`). An upstream
  can't make its tool look like another server's, because the gateway sets the prefix and a slug
  is unique.
- **Bounded influence on the chat agent.** Descriptions sent to the LLM are cut at 1,000
  characters, each tool result at 4,000, and the loop stops after 8 iterations, so an injected
  "keep calling tools" can't run away.
- **The agent can't exceed the user.** It calls tools with a key for the logged-in user, so an
  injection can only make it do what that person could do by hand.
- **Visible and audited.** The chat UI lists every tool call (arguments, result, outcome) under
  the answer, and every call is in the audit log with `source = chat`, so a manipulated call is
  seen, not silent.
- **Fast kill switch.** An admin can disable the server; its tools leave the cache and every open
  client is told (`tools/list_changed`).

**Not implemented (known gaps):**

- **No description pinning.** If an upstream changes a tool's description or schema after the
  admin added it (a rug pull), the gateway serves the new one on the next health check. A fix is
  to store a hash of each tool definition on approval and hide tools whose hash changes until an
  admin re-approves.
- **No confirmation step for write tools in chat**, and no role permissions on them (see §1).
- **External clients get the full description.** The 1,000-char cap applies only to the chat
  agent; Claude Code or Cursor receive what the upstream sent (with the provenance prefix).

**Infrastructure mitigations (implemented):**

- **Containment of a malicious upstream pod.** Every MCP server runs non-root with a
  read-only root filesystem, all capabilities dropped and no service-account token. It can't
  touch the Kubernetes API or other workloads' Secrets.
- **woo-mcp is the only path to store data.** It reaches the store only through the
  WooCommerce REST API with a `shop_manager` key; no MCP server has DB credentials. Its
  ingress is restricted to the gateway.
- **An upstream added by URL is a network risk too.** The gateway only accepts `http(s)` URLs and
  doesn't follow redirects from upstreams (`redirect: "manual"`). A **minimal SSRF guard**
  ([ssrf.ts](../apps/gateway/src/ssrf.ts)) resolves the host and refuses loopback (127/8, ::1),
  link-local (169.254/16 with the metadata endpoint, fe80::/10) and unspecified (0/8, ::)
  addresses, including IPv4-mapped IPv6 and decimal/hex IP forms. Hosts matching
  `UPSTREAM_ALLOWED_HOSTS` (default `*.svc.cluster.local`) skip the check. It runs on add, on URL
  edit (400 with the reason) and again before every connect (the server shows Unreachable with the
  reason).
  **Limits:** private ranges (10/8, 172.16/12, 192.168/16) are allowed on purpose, because
  in-cluster Services live there, so an admin can still reach other cluster Services by IP. The
  check resolves DNS separately from the connection, so a rebinding host could change answers in
  between (the per-connect re-check narrows, not closes, that window). Default-deny egress per
  namespace is the planned next hardening step.

**Residual risk.** Injection through tool *results* can be bounded (provenance, caps,
visible calls, least-privilege tools, human confirmation for writes), but not fully solved.

## 4. What one team member can do to another

**What a member *can't* do to another (enforced server-side in
[api.ts](../apps/gateway/src/api.ts) and [mcp.ts](../apps/gateway/src/mcp.ts)):**

| Action | Enforcement |
|--------|-------------|
| list, see or revoke another member's keys | `/api/keys` queries are scoped to `user_id = <session user>`; revoking someone else's key id returns 404, which doesn't even confirm it exists. `/api/users` (the only cross-user key listing) is admin-only. |
| use another member's key | keys are shown only once, to their creator, and stored as SHA-256; nothing in the API can return one |
| ride another member's MCP session | each session is bound to the key that opened it; a different key on that `Mcp-Session-Id` gets 403 |
| read another member's audit rows | `/api/audit` returns all rows for admins, only the caller's rows for members |
| read another member's chat | chat history is not stored on the server at all; it lives in that browser tab |
| change roles, add members, add/edit/disable servers | admin-only routes (`requireAdmin`), 403 for members; there is no role-change endpoint at all |
| see upstream credentials | write-only API (see §1) |

Members *can* see the list of servers, their URLs, status and tools: that is what lets them use
the gateway, and it reveals no credential.

**Admins vs members.** An admin can issue a key *for* a member (user story admin #4). The admin
sees that key once, so calls made with it are attributed to the member but could have been made
by the admin. That is inherent in admin-issued keys; members who want sole control generate their
own. Admin actions (adding servers, issuing keys) are not yet written to the audit log.

**What a member *can* do to others (shared state):**

- Change **shared store data** through write tools (create products, change order
  status). Mitigation: role-based tool permissions, plus the per-user audit log that shows
  who did it.
- **Exhaust shared capacity:** upstream API rate limits, the LLM quota, or cluster CPU via
  expensive calls. The gateway has **no per-key rate limits yet**, so one member can use up the
  shared LLM quota or hammer an upstream; the audit log shows who. Every tool call has a 15 s
  timeout and every chat request at most 8 iterations, which bounds a single request, not a
  flood. Every workload has Kubernetes CPU/memory **limits**, so one hot pod can't starve the
  rest of the node.

**Infrastructure guarantees:**
- Members have no Kubernetes access and no access to Secrets.
- The only public entry points are the storefront and the gateway (Ingress); everything else
  is ClusterIP.

---

## Also considered

| Threat | Status |
|--------|--------|
| **Compromised admin account** | Can add a malicious upstream, issue keys and disable servers. Admin actions are **not** audited yet (only tool calls are); recovery is revoking that admin's keys and deleting their sessions. It **can't** read upstream credentials back (write-only API) or reach Kubernetes Secrets. |
| **SSRF via server URL** | **Minimal guard built** (see §3): only admins can add servers; loopback, link-local/metadata and unspecified addresses are refused on add, edit and every connect; `*.svc.cluster.local` is allow-listed. Private ranges stay reachable and DNS is resolved separately from the connection. |
| **DNS rebinding against `/mcp`** | **Origin is validated** ([origin.ts](../apps/gateway/src/origin.ts)): a request whose `Origin` header is present and not in `MCP_ALLOWED_ORIGINS` (the dashboard URL) gets 403 before auth; requests with no `Origin` (CLI clients) pass. On top of that, `/mcp` needs a bearer key that a browser never sends on its own, Ingress only routes the configured hostnames, and the dashboard cookie is `SameSite=Lax`. Not done: `Host` header validation. |
| **Where the master key lives** | `GATEWAY_ENC_KEY`: 32 random bytes generated by Helm into Secret `gateway` in `platform`, injected as an env var into the gateway pod only. It's stable across upgrades (`lookup`) and never in git. If you lose it, the stored upstream credentials can't be decrypted, so back up the Secret. |
| **Compromised gateway pod** | Exposes everything it holds (see "Trust anchor"). Bounded by NetworkPolicy, non-root, read-only FS, no Kubernetes API access. |
| **Secrets in git** | Prevented by the gitleaks pre-commit hook on every commit; a full-history scan runs before submission. |
| **Public exposure of internal services** | Only `wordpress` and `gateway` Services are behind Ingress; MariaDB, Postgres and all MCP servers are ClusterIP. |
| **Store outbound abuse** | `WP_HTTP_BLOCK_EXTERNAL` blocks WordPress outbound HTTP; plugin auto-updates and the theme/plugin file editor are disabled. |
