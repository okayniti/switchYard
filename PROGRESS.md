# PROGRESS

Deadline: **26 Oct 2026, 23:59 IST** (submit the afternoon of 26 Oct).
Plan: [PLAYBOOK.md](PLAYBOOK.md) · Requirements: [docs/ASSIGNMENT.md](docs/ASSIGNMENT.md) · Matrix: [docs/REQUIREMENTS_MATRIX.md](docs/REQUIREMENTS_MATRIX.md)

## Phases

- [x] Phase 0 — Ground truth: requirements matrix, pinned versions, this file
- [ ] Phase 1 — Scaffold, cluster, store (tag `phase-1-store`)
- [ ] Phase 2 — woo-mcp (tag `phase-2-woo-mcp`)
- [ ] Phase 3 — Gateway core, shipping-mcp, everything-mcp (tag `phase-3-gateway`)
- [ ] Phase 4 — Dashboard (tag `phase-4-dashboard`)
- [ ] Phase 5 — Chat agent (tag `phase-5-chat`)
- [ ] Phase 6 — `make dod` green + hardening (tag `phase-6-dod-green`)
- [ ] Phase 7 — Differentiators, only if DoD is green (tag `phase-7-standout`)
- [ ] Phase 8 — Docs (tag `phase-8-docs`)
- [ ] Phase 9 — Demo, record, submit (tag `v1.0.0-submission`)

## Pinned versions

Checked on 22 Oct 2026 against npm, Docker Hub, wordpress.org and GitHub releases.

| Component | Version | Notes |
|-----------|---------|-------|
| MCP spec | **2026-07-28** (latest); 2025-11-25 still supported | 2026-07-28 is session-less: `server/discover`, per-request version, `subscriptions/listen` |
| MCP TS SDK v2 (chosen, gated in Phase 2) | `@modelcontextprotocol/server@2.3.1`, `@modelcontextprotocol/client@2.3.1`, `@modelcontextprotocol/node@2.1.1`, `@modelcontextprotocol/express@2.0.2` | Classes: low-level `Server`, `McpServer`, `NodeStreamableHTTPServerTransport`, `Client`, `StreamableHTTPClientTransport`; `sendToolListChanged()` exists |
| MCP TS SDK v1 (fallback) | `@modelcontextprotocol/sdk@1.32.1` | `LATEST_PROTOCOL_VERSION = 2025-11-25`; `StreamableHTTPServerTransport`, `StreamableHTTPClientTransport`, `Server` |
| everything server | `@modelcontextprotocol/server-everything@2.0.0` | Start: `npx @modelcontextprotocol/server-everything streamableHttp`; endpoint `:3001/mcp` (`PORT` overrides); **Node ≥ 24**; serves both protocol eras |
| MCP Inspector | `@modelcontextprotocol/inspector@2.12.0` | for manual verification |
| Node.js | **24.22.1** (Active LTS "Krypton"): images, `engines`, `.nvmrc` | everything-mcp needs ≥ 24; local machine still has 22.19.0 |
| pnpm | 10.34.7 | |
| Express | 5.3.0 | |
| Zod | 4.6.7 | SDK v2 depends on zod ^4.2 |
| WordPress image | `wordpress:7.1.3-php8.3-apache` | WP core 7.1.3 |
| WooCommerce | 11.2.1 | requires WP ≥ 7.0, PHP ≥ 7.4; tested to 7.1.3; zip baked into image |
| WP-CLI | 2.12.0 | |
| MariaDB | `mariadb:11.8.9` | 11.8 is the current LTS line |
| Postgres | `postgres:18.6-alpine` | |
| nginx-unprivileged | `nginxinc/nginx-unprivileged:1.31.7-alpine` | dashboard |
| k3d | 5.9.0 | default k3s `v1.35.5-k3s1` |
| Helm | 4.3.1 | Helm 4. Re-check `lookup` and hook behaviour in Phase 1 |
| kubectl | 1.36.1 | |
| kubeconform | 0.8.0 | `make lint` |
| gitleaks | 8.30.1 | hook uses `gitleaks git --pre-commit --staged` (`protect` is deprecated) |
| Docker | 29.6.1 | |

## Decisions (approved 22 Oct)

1. **Push:** the repo goes private before the first push; push `main` at the end of every session after that. PLAYBOOK.md and CLAUDE.md stay in the repo. No history rewrites.
2. **Node 24 LTS** in every image, in `engines`, and in `.nvmrc`.
3. **MCP SDK v2** (`@modelcontextprotocol/server` + `/client` 2.3.1), validated in Phase 2 against these gates:
   - (a) a low-level `Server` serves `tools/list` and `tools/call` dynamically;
   - (b) `Client` connects to a Streamable HTTP upstream with a static auth header;
   - (c) a tools `list_changed` notification reaches MCP Inspector and Claude Code, or those clients re-list tools in a way that satisfies DoD #9.

   **Fallback:** if any gate fails or takes more than ~45 min, switch to `@modelcontextprotocol/sdk@1.32.1` and record why here.
   - Gate (a): ⬜
   - Gate (b): ⬜
   - Gate (c): ⬜
4. **Revocation doesn't depend on sessions.** Every MCP request re-validates the bearer key against the DB, so a revoked key fails on its next request, whether or not a session exists. Closing sessions bound to that key is cleanup on top of that, not the enforcement.
5. **Admins can issue keys for members** (matrix C-1). Accepted.
6. **Jobs** get requests/limits plus `activeDeadlineSeconds`/`backoffLimit` instead of probes. Accepted.
7. **Helm 4:** verify `lookup`, hooks, `history` and `rollback` in Phase 1.

## TODO

- [ ] Phase 8: add a "How I used AI" section to README.md (Claude Code as pair programmer, PLAYBOOK/CLAUDE.md as the plan, what I verified myself).

## Repo setup notes

- Pre-commit secret scan is tracked in `.githooks/pre-commit`. After cloning, enable it with `git config core.hooksPath .githooks`.
- Pushing uses Git Credential Manager (browser login on the first push). GitHub CLI isn't installed and isn't needed.
