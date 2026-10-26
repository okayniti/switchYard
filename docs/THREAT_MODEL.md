# Threat model

Scope: one WooCommerce store, three upstream MCP servers, and the gateway (REST API, `/mcp`,
dashboard, chat agent) on one Kubernetes cluster. Actors: **admin**, **member**, an
**external MCP client** holding a member's key, an **upstream MCP server** (possibly malicious
or compromised), and **anyone on the internet** who can reach the public Ingress hosts.

**Trust anchor:** the gateway pod. It holds every upstream credential (decrypted in memory),
the AES master key and the DB password. If it's compromised, everything it can reach is
exposed. That is why only it may reach woo-mcp (NetworkPolicy), and why it has no Kubernetes
API access (`automountServiceAccountToken: false`, no RBAC).

Sections marked *(gateway)* are owned by the gateway session and describe code in `apps/gateway`.

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

*(gateway: implementation details.)*

The gateway terminates authentication, then calls each upstream with **its own**
per-upstream credential. The MCP authorization spec forbids token passthrough:

- **Audience confusion:** the member's key was issued for the gateway, not for any upstream.
  An upstream that accepted it couldn't tell what it was authorized for.
- **Replay / lateral movement:** a malicious or compromised upstream that received client
  tokens could replay them against the gateway or other upstreams.
- **Loss of control:** policy, revocation and audit live at the gateway. Passthrough lets
  the upstream make those decisions, and lets a revoked key keep working wherever it was
  copied.

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

*(gateway: description review/pinning, server-name provenance in tool names and
descriptions, description length caps, visible tool-call chips in chat, iteration cap, role
permissions on write tools.)*

**Infrastructure mitigations (implemented):**

- **Containment of a malicious upstream pod.** Every MCP server runs non-root with a
  read-only root filesystem, all capabilities dropped and no service-account token. It can't
  touch the Kubernetes API or other workloads' Secrets.
- **woo-mcp is the only path to store data.** It reaches the store only through the
  WooCommerce REST API with a `shop_manager` key; no MCP server has DB credentials. Its
  ingress is restricted to the gateway.
- **An upstream added by URL is a network risk too.** *(gateway: SSRF guard; reject
  link-local/metadata and private ranges except allow-listed cluster hosts; no redirects.)*
  Default-deny egress per namespace is the planned next hardening step.

**Residual risk.** Injection through tool *results* can be bounded (provenance, caps,
visible calls, least-privilege tools, human confirmation for writes), but not fully solved.

## 4. What one team member can do to another

*(gateway: server-side authorization: members can't list or revoke others' keys, change
roles, read others' audit entries, or see others' chat; admins can issue and revoke keys.)*

**What a member *can* do to others (shared state):**

- Change **shared store data** through write tools (create products, change order
  status). Mitigation: role-based tool permissions, plus the per-user audit log that shows
  who did it.
- **Exhaust shared capacity:** upstream API rate limits, the LLM quota, or cluster CPU via
  expensive calls. Mitigation: *(gateway: per-key rate limits)*. Every workload has Kubernetes
  CPU/memory **limits**, so one hot pod can't starve the rest of the node.

**Infrastructure guarantees:**
- Members have no Kubernetes access and no access to Secrets.
- The only public entry points are the storefront and the gateway (Ingress); everything else
  is ClusterIP.

---

## Also considered

| Threat | Status |
|--------|--------|
| **Compromised admin account** | Can add a malicious upstream, issue keys and disable servers. *(gateway: audit of admin actions; key revocation.)* It **can't** read upstream credentials back (write-only API) or reach Kubernetes Secrets. |
| **SSRF via server URL** | *(gateway: DNS-resolved IP checks, re-checked on every connect against DNS rebinding.)* |
| **DNS rebinding against `/mcp`** | *(gateway: Host/Origin validation.)* Ingress only routes the configured hostnames. |
| **Where the master key lives** | `GATEWAY_ENC_KEY`: 32 random bytes generated by Helm into Secret `gateway` in `platform`, injected as an env var into the gateway pod only. It's stable across upgrades (`lookup`) and never in git. If you lose it, the stored upstream credentials can't be decrypted, so back up the Secret. |
| **Compromised gateway pod** | Exposes everything it holds (see "Trust anchor"). Bounded by NetworkPolicy, non-root, read-only FS, no Kubernetes API access. |
| **Secrets in git** | Prevented by the gitleaks pre-commit hook on every commit; a full-history scan runs before submission. |
| **Public exposure of internal services** | Only `wordpress` and `gateway` Services are behind Ingress; MariaDB, Postgres and all MCP servers are ClusterIP. |
| **Store outbound abuse** | `WP_HTTP_BLOCK_EXTERNAL` blocks WordPress outbound HTTP; plugin auto-updates and the theme/plugin file editor are disabled. |
