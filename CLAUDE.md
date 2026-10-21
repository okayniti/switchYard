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
