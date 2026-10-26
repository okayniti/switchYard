# Demo script (≈7 minutes)

Record in segments and cut together. Timings are targets. Commands are exact; run them from
the repo root in **Git Bash**.

Users: **A = admin** (`admin@switchyard.local`), **B = member** (`member@switchyard.local`).

---

## Before recording (off-camera)

```bash
bash scripts/demo-reset.sh          # starts cluster, make up, waits for Ready, prints URLs + logins
make gateway-admin-password         # A and B dashboard passwords  -> copy to a notepad, OFF-CAMERA
make admin-password                 # WooCommerce admin password   -> OFF-CAMERA
make llm-key LLM_API_KEY=...        # only if chat says no key     -> OFF-CAMERA
claude mcp remove switchyard 2>/dev/null   # clean Claude Code config from earlier runs
```

- **Browser:** window 1 logged in as **A** at http://yard.localtest.me; a private window logged
  in as **B**; a tab at http://shop.localtest.me/shop/; a tab at http://shop.localtest.me/wp-admin/
  (already logged in).
- **Terminal 1** (kubectl, big font) and **terminal 2** (Claude Code, in an empty folder,
  e.g. `mkdir /tmp/demo && cd /tmp/demo`).
- In A's dashboard → **Servers**: woo, shipping and everything all **Connected**.

### Never on camera (secrets)

| Don't show | Show instead |
|------------|--------------|
| `make gateway-admin-password`, `make admin-password`, `make llm-key` | run them before recording; paste passwords from your notepad off-screen |
| `kubectl get secret … -o yaml/json`, `-o jsonpath='{.data…}'`, `base64 -d` | `kubectl get secrets -n platform` (names only) or `kubectl describe secret gateway -n platform` (key names and byte sizes, no values) |
| `kubectl exec … env` / `printenv` on the gateway | nothing; say "env comes from `secretKeyRef`" and show the template |
| browser password-manager popups, `~/.claude.json` | dismiss or close them first |

**B's API key appears on screen** when it's generated and in the `claude mcp add` command.
That's acceptable only because the demo **revokes it** in step 6. Also run
`claude mcp remove switchyard` after recording.

---

## 1. Intro and architecture (0:00–0:30)

Show the README's architecture (or `docs/DESIGN.md` "Architecture at a glance").

> "Switchyard is WooCommerce hosting with a team MCP gateway, all on Kubernetes from one Helm
> chart. Three namespaces: `store` has WordPress and MariaDB; `mcp` has three upstream MCP
> servers: woo-mcp, which I wrote, a shipping server, and the official reference server;
> `platform` has the gateway, which also serves the dashboard and chat, and Postgres. Every
> client, including the chat, goes through the gateway's single `/mcp` endpoint."

## 2. Kubernetes tour and NetworkPolicy proof (0:30–1:30), terminal 1

```bash
kubectl get ns,pods,pvc,ingress,netpol -A | grep -vE 'kube-system|kube-public|kube-node-lease|default '
```

> "Two Ingresses: the storefront and the gateway. Everything else is ClusterIP. PVCs for
> MariaDB, WordPress and Postgres. One NetworkPolicy: only the gateway may reach woo-mcp."

```bash
kubectl get deploy woo-mcp -n mcp -o yaml | grep -A12 -E 'readinessProbe|resources:' | head -30   # probes + limits
```

NetworkPolicy proof, both ways. The `sleep 12` matters: k3s adds a new pod to the allow-list
a few seconds after it starts.

```bash
# DENIED: a pod in the store namespace
kubectl run np-deny -n store --rm -i --restart=Never --image=curlimages/curl:8.16.0 -- \
  sh -c 'sleep 12; curl -sS -m 5 http://woo-mcp.mcp.svc.cluster.local:8080/healthz; echo " exit=$?"'

# ALLOWED: a pod in platform labelled like the gateway
kubectl run np-allow -n platform --rm -i --restart=Never --image=curlimages/curl:8.16.0 \
  --labels=app.kubernetes.io/name=gateway,app.kubernetes.io/instance=switchyard -- \
  sh -c 'sleep 12; curl -sS -m 5 http://woo-mcp.mcp.svc.cluster.local:8080/healthz; echo " exit=$?"'
```

Expected: the first prints `Failed to connect … exit=7` (k3s rejects it), the second
`{"ok":true} exit=0`.

## 3. Storefront: COD checkout and the order in wp-admin (1:30–2:15), browser

1. http://shop.localtest.me/shop/ → **Add to cart** on *Brass Diya* → **View cart** →
   **Proceed to checkout**.
2. Billing: any name, `1 MG Road`, `Bengaluru`, state *Karnataka*, PIN `560001`, an email, a
   phone → **Cash on delivery** → **Place order**. Note the order number.
3. wp-admin tab → **WooCommerce → Orders**: the order is there, status *Processing*.

## 4. Chat as user A (2:15–3:15), A's dashboard → Chat

Prompt 1:

```
Create a product called Masala Chai Kit priced at 499 rupees.
```

Point at the **tool-call chip** (`woo__create_product`, its arguments, duration, outcome).
Refresh http://shop.localtest.me/shop/: *Masala Chai Kit, ₹499* is listed.

Quickly buy it by hand on the storefront (COD, same address as step 3). Then prompt 2:

```
What orders came in today?
```

> "It called `woo__list_orders` with `date: today`. 'Today' is computed in Asia/Kolkata on
> the server, and both orders are there, including the Masala Chai Kit order I just placed."

## 5. External client as user B: Claude Code (3:15–4:45)

B's private window → **My keys** → **Generate key** → copy the ready `claude mcp add` command it
shows. In terminal 2:

```bash
claude mcp add --transport http switchyard http://mcp.localtest.me/mcp \
  --header "Authorization: Bearer syk_…paste B's key…"
claude
```

In Claude Code, run `/mcp` (shows `switchyard` connected and its tools), then:

```
List every tool you have from the switchyard server, grouped by upstream server.
```

> "Every tool is namespaced `<server>__<tool>`. Both woo-mcp and shipping-mcp have a tool
> called `search`; through the gateway they're `woo__search` and `shipping__search`, so they
> never collide."

```
What orders came in today?
```

Cross-server prompt (woo-mcp + shipping-mcp in one answer):

```
List today's orders and, for each one, get a shipping quote for a 1 kg parcel to its billing PIN code.
```

Point out the two different servers in the tool calls: `woo__list_orders`, then
`shipping__quote_shipping`.

## 6. Team and control (4:45–6:15)

**Revoke B's key.** In A's dashboard → **Members** → member@switchyard.local → **Revoke** on
B's key (or B does it on **My keys**). In Claude Code:

```
What orders came in today?
```

The call fails with an auth error. To show the raw HTTP response, in terminal 1:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://mcp.localtest.me/mcp \
  -H "Authorization: Bearer syk_…the revoked key…" -H "Content-Type: application/json" -d '{}'
# 401
```

**Re-connect B for the next step.** In **Members**, A clicks **Issue key** for B (user story
"admin issues keys"), then in terminal 2:

```bash
claude mcp remove switchyard
claude mcp add --transport http switchyard http://mcp.localtest.me/mcp --header "Authorization: Bearer syk_…new key…"
claude
```

**Disable shipping.** A → **Servers** → shipping → **Disable**. Status shows *Disabled*.
- In A's **Chat**: `What shipping tools do you have?` (no `shipping__*` tools).
- In Claude Code: `/mcp` or `List your switchyard tools` (`shipping__*` are gone; `woo__*` and
  `everything__*` remain).

Re-enable shipping afterwards (**Enable**).

**Kill an upstream pod.** Terminal 1:

```bash
kubectl scale deploy everything-mcp -n mcp --replicas=0     # kill it and keep it down
kubectl get pods -n mcp
```

(`kubectl delete pod -n mcp -l app.kubernetes.io/name=everything-mcp` also kills it, but the
Deployment replaces it within seconds, which may be before the 15 s health check notices.)

Within about 15 s, A → **Servers**: *everything* is **Unreachable** with a reason. In chat:

```
List 3 products from the store.
```

woo still works: one dead upstream doesn't affect the others. Bring it back:

```bash
kubectl scale deploy everything-mcp -n mcp --replicas=1
```

**Audit log.** A → **Audit log**:
- Filter by user **member@switchyard.local**: B's Claude Code calls (`source = mcp`). The
  request with the revoked key is refused (401) before any tool runs, so it's not a tool-call
  row. Check this before recording rather than claiming it on camera.
- Filter by **admin@switchyard.local**: A's chat calls (`source = chat`).
- Point at the columns: user, server, tool, time, duration and outcome
  (success / error / timeout / unavailable).

## 7. Local to production with Helm (6:15–7:00), terminal 1

```bash
git diff --no-index --stat charts/switchyard/values-local.yaml charts/switchyard/values-prod.yaml
git diff --no-index charts/switchyard/values-local.yaml charts/switchyard/values-prod.yaml | head -60
```

> "Same chart. Production changes values only: real hostnames, TLS through cert-manager,
> `existingSecret` instead of generated store secrets, ghcr images, larger limits. The steps
> are in `docs/VPS.md`. It's documented, not deployed."

```bash
helm history switchyard --max 6
```

> "Revision 28 is a real failed upgrade: production values applied to my laptop by mistake.
> Every Deployment got an invalid image; the rolling ones kept serving, WordPress went down.
> `helm rollback switchyard 27` brought everything back in 13 seconds, with data and secrets
> intact, because the data lives on PVCs and the generated secrets are stable."

Optional, only if the release is otherwise idle (it re-runs the store setup Job):

```bash
helm rollback switchyard <previous-revision> --wait
kubectl get pods -A | grep -vE 'kube-system|Completed'
```

---

## After recording

```bash
claude mcp remove switchyard     # removes B's (revoked/issued) key from Claude Code config
```

Revoke any key that appeared on camera and isn't revoked yet (the key A issued for B in step 6).
