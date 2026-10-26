# Environment variables (apps ⇄ chart contract)

This file is the only coordination point between the apps (`apps/`) and the Helm chart
(`charts/`). App code reads exactly these names. Anything marked **secret** must come from a
Kubernetes Secret (`valueFrom.secretKeyRef`), never from a values file.

Every app listens on `PORT` (default **8080**), runs as the non-root `node` user (uid 1000), and
serves `GET /healthz` → `200 {"ok":true}` for readiness and liveness probes. MCP endpoints are at
`/mcp` (Streamable HTTP).

## woo-mcp (namespace `mcp`, ClusterIP only)

| Name | Required | Secret | Example / default | Notes |
|------|----------|--------|-------------------|-------|
| `PORT` | no | | `8080` | |
| `WC_URL` | yes | | `http://wordpress.store.svc.cluster.local` | Where requests are sent (in-cluster Service). |
| `WC_HOME` | no | | `http://shop.localtest.me` (default: `WC_URL`) | The store's public home URL (`siteurl`). WooCommerce builds the OAuth1 signature base from `get_home_url()`, not from the Host we hit, so this must match the WordPress `home` option. |
| `WC_KEY` | yes | **yes** | Secret `woocommerce-api-key`, key `consumer-key` | `ck_…` |
| `WC_SECRET` | yes | **yes** | Secret `woocommerce-api-key`, key `consumer-secret` | `cs_…` |
| `STORE_TZ` | no | | `Asia/Kolkata` | Used to resolve `date: "today"` in `list_orders`. |

## shipping-mcp (namespace `mcp`, ClusterIP only)

| Name | Required | Secret | Example / default | Notes |
|------|----------|--------|-------------------|-------|
| `PORT` | no | | `8080` | |
| `SHIPPING_TOKEN` | yes | **yes** | random 32+ chars | Bearer token every `/mcp` request must present. The gateway gets the same value as `SHIPPING_MCP_TOKEN`. |

## everything-mcp (namespace `mcp`, ClusterIP only)

Off-the-shelf `@modelcontextprotocol/server-everything@2.0.0 streamableHttp`; listens on `PORT`
(`3001` default), endpoint `/mcp`. No app code from us. It has no `/healthz`, so probe with
`tcpSocket` on the port.

## gateway (namespace `platform`; serves `/mcp`, `/api/*` and the dashboard UI)

Probes: liveness `GET /healthz` (process up), readiness `GET /readyz` (also checks Postgres; 503 if the DB is down). Upstream health never affects either probe.

One Service, two Ingress hosts: `hosts.dashboard` (UI + `/api`) and `hosts.mcp` (`/mcp`). Both route
to the same gateway Service port 8080.

| Name | Required | Secret | Example / default | Notes |
|------|----------|--------|-------------------|-------|
| `PORT` | no | | `8080` | |
| `DATABASE_URL` | yes | **yes** | `postgres://gateway:…@postgres.platform.svc.cluster.local:5432/gateway` | SQL migrations run on startup. |
| `SESSION_SECRET` | no (unused) | | | Not read. Sessions are random 256-bit tokens stored as SHA-256 in Postgres, so nothing needs signing. Safe to keep or drop. |
| `GATEWAY_ENC_KEY` | yes | **yes** | 32 random bytes, base64 (`openssl rand -base64 32`) | AES-256-GCM key for upstream credentials at rest. |
| `ADMIN_EMAIL` | yes | | `admin@switchyard.local` | Seeded admin (created if missing). |
| `ADMIN_PASSWORD` | yes | **yes** | | |
| `MEMBER_EMAIL` | yes | | `member@switchyard.local` | Seeded member. |
| `MEMBER_PASSWORD` | yes | **yes** | | |
| `WOO_MCP_URL` | no | | `http://woo-mcp.mcp.svc.cluster.local:8080/mcp` | Seed for server `woo` (only inserted if missing). |
| `SHIPPING_MCP_URL` | no | | `http://shipping-mcp.mcp.svc.cluster.local:8080/mcp` | Seed for server `shipping`. |
| `SHIPPING_MCP_TOKEN` | yes | **yes** | same value as shipping-mcp `SHIPPING_TOKEN` | Stored encrypted as the `shipping` bearer credential. |
| `EVERYTHING_MCP_URL` | no | | `http://everything-mcp.mcp.svc.cluster.local:3001/mcp` | Seed for server `everything`. |
| `PUBLIC_MCP_URL` | no | | `http://mcp.localtest.me/mcp` | Shown in the dashboard's `claude mcp add` command. |
| `MCP_ALLOWED_ORIGINS` | no | | `http://yard.localtest.me` | Comma-separated origins allowed to call `/mcp` from a browser (set to the dashboard URL, `http(s)://<hosts.dashboard>`). Requests without an `Origin` header (CLI clients) are always allowed. |
| `UPSTREAM_ALLOWED_HOSTS` | no | | `*.svc.cluster.local` | Comma-separated host patterns (`*.suffix` or exact) that skip the SSRF address check. Every other upstream host is resolved and refused if it maps to loopback, link-local/metadata or unspecified. |
| `LLM_BASE_URL` | no | | `https://api.groq.com/openai/v1` | Any OpenAI-compatible Chat Completions endpoint. |
| `LLM_MODEL` | no | | `llama-3.3-70b-versatile` | |
| `LLM_API_KEY` | yes (for chat) | **yes** | | Chat returns a clear error if unset. |
| `COOKIE_SECURE` | no | | `false` local, `true` prod (TLS) | |
| `HEALTH_INTERVAL_MS` | no | | `15000` | Upstream health-check period. |
| `TOOL_TIMEOUT_MS` | no | | `15000` | Per tool call timeout. |
| `SELF_MCP_URL` | no | | `http://127.0.0.1:8080/mcp` | Where the chat agent connects to the gateway's own `/mcp`. |

### Egress the gateway needs (for NetworkPolicies)

- `mcp` namespace: woo-mcp :8080, shipping-mcp :8080, everything-mcp :3001
- Postgres :5432 (same namespace)
- kube-dns :53
- 443 to the LLM provider (and any external upstream an admin adds)
