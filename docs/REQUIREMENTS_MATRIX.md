# Requirements Matrix

Maps every mandatory requirement and Definition-of-Done line in [ASSIGNMENT.md](ASSIGNMENT.md) to the component that satisfies it, the files where it lives, and how it is verified. Status and evidence are filled in as phases complete (final pass in Phase 6).

Status: ⬜ not started · 🟨 in progress · ✅ verified (evidence linked)

## 1. Definition of Done (two users: A = admin, B = member)

| ID | Requirement (brief) | Component | File(s) | Verification | Status |
|----|---------------------|-----------|---------|--------------|--------|
| DOD-1 | Storefront: add to cart, check out with COD | store chart, setup Job enables COD | `charts/switchyard/charts/store/templates/setup-job.yaml` | Manual checkout at `http://shop.localtest.me` (video) | ⬜ |
| DOD-2 | Order visible in WooCommerce admin | stock WC admin | — | Manual: WC → Orders (video) | ⬜ |
| DOD-3 | Chat as A: create product with name + price → appears on storefront | chat → gateway → woo-mcp `create_product` | `apps/gateway/src/chat/*`, `apps/woo-mcp/src/tools/createProduct.ts` | `make dod` check 2 + manual in video | ⬜ |
| DOD-4 | Hand-placed order, then chat "orders today" returns it | woo-mcp `list_orders` (today in Asia/Kolkata) | `apps/woo-mcp/src/tools/listOrders.ts` | `make dod` check 3 + manual | ⬜ |
| DOD-5 | External client with only gateway URL + B's key sees tools of every enabled server | gateway `/mcp` | `apps/gateway/src/mcp/*` | `make dod` check 1; Claude Code / Inspector in video | ⬜ |
| DOD-6 | B asks the orders question from the external client | as DOD-4 | — | Claude Code in video | ⬜ |
| DOD-7 | One prompt needing tools from two upstreams | woo-mcp + shipping-mcp | `apps/shipping-mcp/*` | `make dod` check 4 + video | ⬜ |
| DOD-8 | Revoke B's key → next call rejected | per-request key lookup, session teardown | `apps/gateway/src/auth/apiKeys.ts` | `make dod` check 5 (401) | ⬜ |
| DOD-9 | Disable a server → tools disappear from chat **and** external client | tool cache rebuild + list-changed notification | `apps/gateway/src/upstreams/toolCache.ts` | `make dod` check 6 | ⬜ |
| DOD-10 | Kill an upstream pod → others keep working; dashboard shows Unreachable | per-upstream isolation, timeouts, health loop | `apps/gateway/src/upstreams/health.ts` | `make dod` check 7 + dashboard in video | ⬜ |
| DOD-11 | Every call above in audit log under the right user | single `executeToolCall` path | `apps/gateway/src/audit/*` | `make dod` check 8 | ⬜ |

## 2. Mandatory requirements

### Kubernetes and Helm

| ID | Requirement | Component | File(s) | Verification | Status |
|----|-------------|-----------|---------|--------------|--------|
| K8S-1 | Runs on local Kubernetes (k3d) | k3d cluster | `scripts/k3d-up.sh`, `Makefile` | `make up` from clean | ⬜ |
| K8S-2 | Deployable to VPS (k3s) with the same charts | umbrella chart | `charts/switchyard/values-prod.yaml` | `helm template -f values-prod.yaml` renders; VPS deploy if time allows | ⬜ |
| K8S-3 | Helm only, no Kustomize; local/prod differ only by values | umbrella chart | `values-local.yaml`, `values-prod.yaml` | `grep -r kustomiz` empty; values diff in DESIGN.md | ⬜ |
| K8S-4 | Everything in-cluster: store, DB, woo-mcp, gateway, dashboard | all subcharts | `charts/switchyard/charts/*` | `kubectl get pods -A` | ⬜ |
| K8S-5 | PVCs for store DB and WordPress content | store chart | `mariadb-statefulset.yaml`, `wordpress-pvc.yaml` | `kubectl get pvc -n store`; data survives pod delete | ⬜ |
| K8S-6 | Storefront + dashboard via Ingress with stable URLs; local domain approach documented | Traefik Ingress, `*.localtest.me` | `ingress.yaml` per chart, README | `curl shop.localtest.me`, `yard.localtest.me` | ⬜ |
| K8S-7 | Readiness + liveness on every workload; requests + limits | every Deployment/StatefulSet (Jobs: limits only) | all templates | `scripts/check-probes` / kubeconform + jq in `make lint` | ⬜ |
| K8S-8 | No hardcoded secrets; credentials in K8s Secrets | Secrets via `lookup` / `existingSecret` | `templates/*secret*.yaml` | gitleaks full-history scan; `grep` for literals | ⬜ |

### WooCommerce MCP server

| ID | Requirement | Component | File(s) | Verification | Status |
|----|-------------|-----------|---------|--------------|--------|
| WOO-1 | Written by us; no existing WC MCP server/plugin | woo-mcp | `apps/woo-mcp/` | code review; plugin list in WP shows only WooCommerce | ⬜ |
| WOO-2 | MCP over Streamable HTTP | woo-mcp | `apps/woo-mcp/src/server.ts` | Inspector / SDK client script | ⬜ |
| WOO-3 | Tools: list products, create product, list orders, get order, update order status | woo-mcp | `apps/woo-mcp/src/tools/*` | vitest + live call per tool | ⬜ |
| WOO-4 | Not reachable from outside the cluster; only the gateway can call it | ClusterIP + NetworkPolicy | `charts/.../woo-mcp/templates/networkpolicy.yaml` | curl from `store` ns pod times out; from gateway-labelled pod works | ⬜ |
| WOO-5 | Document how it talks to the store and why | DESIGN.md | `docs/DESIGN.md` | doc review | ⬜ |

### Gateway

| ID | Requirement | Component | File(s) | Verification | Status |
|----|-------------|-----------|---------|--------------|--------|
| GW-1 | Admin add / edit / disable / remove Streamable HTTP upstreams with optional static credential (header or bearer) | servers API + dashboard | `apps/gateway/src/api/servers.ts`, `apps/dashboard/src/pages/Servers*` | API tests + click-through | ⬜ |
| GW-2 | One MCP endpoint; list returns every enabled server's tools; calls routed correctly | aggregator / router | `apps/gateway/src/mcp/*` | `make dod` check 1, 4 | ⬜ |
| GW-3 | Documented tool-name collision scheme | `<slug>__<tool>` naming | `apps/gateway/src/mcp/naming.ts`, DESIGN.md | `woo__search` and `shipping__search` both listed | ⬜ |
| GW-4 | Slow/dead upstream doesn't break listing or other calls; timeouts with clear error | cached `tools/list`, 15 s per-call timeout | `apps/gateway/src/mcp/executeToolCall.ts` | `make dod` check 7; test with a hanging upstream | ⬜ |
| GW-5 | Upstream credentials never reach browser or MCP client | write-only credential, AES-GCM at rest | `apps/gateway/src/crypto.ts`, servers API | network-response grep in Phase 4 | ⬜ |
| GW-6 | ≥3 upstreams: woo-mcp + two others | woo-mcp, shipping-mcp, everything-mcp | `charts/.../{woo,shipping,everything}-mcp` | dashboard shows 3 Connected | ⬜ |

### Team and access

| ID | Requirement | Component | File(s) | Verification | Status |
|----|-------------|-----------|---------|--------------|--------|
| TEAM-1 | Two roles: admin (servers + members) and member (uses tools) | role middleware | `apps/gateway/src/auth/authz.ts` | member gets 403 on admin routes (test) | ⬜ |
| TEAM-2 | Per-user API keys; revocable; stored hashed | `api_keys` table, SHA-256 | `apps/gateway/src/auth/apiKeys.ts` | DB query shows only hashes; revoke test | ⬜ |
| TEAM-3 | Admin can **issue** or revoke members' keys (user story A4) | keys API + Members page | `apps/gateway/src/api/keys.ts` | see conflict C-1 | ⬜ |
| TEAM-4 | Audit log: user, server, tool, timestamp, duration, outcome; visible in dashboard | `audit_log` + Audit page | `apps/gateway/src/audit/*`, `apps/dashboard/src/pages/Audit*` | `make dod` check 8 + screenshot | ⬜ |

### Chat agent

| ID | Requirement | Component | File(s) | Verification | Status |
|----|-------------|-----------|---------|--------------|--------|
| CHAT-1 | Dashboard chat uses an LLM to call tools through the gateway; shows which tools it called | chat loop + tool chips | `apps/gateway/src/chat/*`, `apps/dashboard/src/pages/Chat*` | live demo | ⬜ |
| CHAT-2 | Acts as the logged-in user; calls audited under that user | short-lived per-user token → own `/mcp` | `apps/gateway/src/chat/internalClient.ts` | audit rows with `source=chat` | ⬜ |
| CHAT-3 | LLM key is a K8s Secret like everything else | `llm` Secret | `charts/.../gateway/templates/secret.yaml` | `kubectl get secret` keys only | ⬜ |

### Deliverables and submission

| ID | Requirement | File(s) | Status |
|----|-------------|---------|--------|
| DEL-1 | README: local setup, VPS setup, place an order, connect an MCP client, use chat | `README.md` | ⬜ |
| DEL-2 | Source for dashboard, gateway, woo-mcp, chat agent | `apps/*` | ⬜ |
| DEL-3 | Helm charts + local and prod values | `charts/switchyard/*` | ⬜ |
| DEL-4 | Design & tradeoffs note: architecture, aggregation/routing/failure handling, production changes | `docs/DESIGN.md` | ⬜ |
| DEL-5 | Threat model: shared credentials, no token passthrough, manipulative tool descriptions, member-vs-member | `docs/THREAT_MODEL.md` | ⬜ |
| DEL-6 | List of attempted bonus / stand-out items and where they are | `README.md` | ⬜ |
| SUB-1 | Demo video covering the six required sections | `docs/DEMO_SCRIPT.md` | ⬜ |
| SUB-2 | Submit video + repo via the form | https://forms.gle/nftwgyNeenSDmiRb6 | ⬜ |

## 3. Conflicts and gaps: PLAYBOOK vs ASSIGNMENT vs current upstream reality

Rule: where PLAYBOOK conflicts with ASSIGNMENT, ASSIGNMENT wins.

| # | Where | Issue | Resolution |
|---|-------|-------|------------|
| C-1 | PLAYBOOK §2.7 REST table (`/api/keys` = own keys only) and §2.9 Members page ("revoke keys") | Brief user story *admin 4*: "Invite team members and **issue** or revoke their API keys". The playbook only lets admins revoke, not issue. | **Assignment wins.** Add `POST /api/users/:id/keys` (admin only, key shown once to the admin) and an "Issue key" button on Members. Members can still create their own keys (member story 1). |
| C-2 | PLAYBOOK §2.1 says Node 22 everywhere | The official `@modelcontextprotocol/server-everything@2.0.0` requires **Node ≥ 24**. Node 22 is now in maintenance LTS; Node 24 is active LTS. | Use Node 24 for all images (everything-mcp needs it anyway). Local dev on Node 22 still works for our packages (SDK v2 needs Node ≥ 20). *Needs your approval.* |
| C-3 | PLAYBOOK §2.1 / §2.7 assume `@modelcontextprotocol/sdk` (v1) with stateful `Mcp-Session-Id` sessions | The SDK's stable line is now **v2**, as split packages (`@modelcontextprotocol/server`, `/client`, `/node`, `/express` at 2.3.x). It implements MCP spec **2026-07-28**, which is session-less (`server/discover`, version sent on every request, `subscriptions/listen` for change notifications). v2 still serves 2025-11-25 clients with sessions and `initialize`. | **Decision needed** (see PROGRESS.md "Open decisions"). Recommended: SDK v2. Support both protocol eras at the gateway: session binding to key applies to 2025-era clients, and per-request bearer re-validation covers both. `notifications/tools/list_changed` for 2025 clients and `subscriptions/listen` for 2026 clients. |
| C-4 | PLAYBOOK §2.7 "Validate the `Origin` header" | SDK v2 Express adapter does DNS-rebinding protection by **Host** header allowlist (`hostHeaderValidation`). | Use both: Host allowlist from Helm values, plus Origin check when present. No conflict with the brief. |
| C-5 | Brief: "Readiness and liveness checks on every workload" | Probes are meaningless on run-to-completion Jobs (setup Job, DB dump Job). | Long-running workloads get both probes; Jobs get requests/limits plus `activeDeadlineSeconds` and `backoffLimit`. Document this in DESIGN.md. |
| C-6 | PLAYBOOK §2.10 / Makefile | Helm installed is **v4.3.1** (the playbook was written against Helm 3). | `lookup`, hooks, `helm rollback`, `helm history` all still exist in Helm 4. Verify hook delete policy and `lookup` behaviour in Phase 1. |
| C-7 | PLAYBOOK schedule (Phase 1 on 17 Oct) | Work starts 22 Oct; deadline 26 Oct 23:59 IST. | Compress phases. Core DoD only until `make dod` is green. Part 4 differentiators are likely limited to items the core already gives us (SSRF guard, encrypted credentials, NetworkPolicies, non-root), which count as stand-out #6. |
| C-8 | PLAYBOOK §2.3 exposes `mcp.localtest.me` via Ingress | Not a conflict. The brief requires the gateway's MCP endpoint to be reachable by external clients; only upstreams must be internal. | Keep. |

No other conflicts found. Brief items the playbook already covers: COD checkout, ≥3 upstreams, header-or-bearer credential, roles, hashed keys, audit fields, LLM key as Secret, VPS via values.
