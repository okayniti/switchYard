#!/usr/bin/env bash
# Bring the local cluster to a clean, demo-ready state and print every URL and login.
#
#   bash scripts/demo-reset.sh            # keep data: start cluster, re-run make up, wait, print
#   bash scripts/demo-reset.sh --wipe     # DESTROYS all data (cluster + PVCs), then rebuilds
#
# Extra args are passed to make, e.g. LLM_API_KEY=... (stored in the llm Secret, never echoed).
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${CLUSTER:-switchyard}"
WIPE=false
MAKE_ARGS=()
for a in "$@"; do
  case "$a" in
    --wipe) WIPE=true ;;
    *) MAKE_ARGS+=("$a") ;;
  esac
done

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

api_ok() { kubectl get namespace default --request-timeout=5s >/dev/null 2>&1; }

if $WIPE; then
  step "WIPE: deleting cluster '$CLUSTER' and ALL its data (store orders, products, gateway DB)"
  read -r -p "Type 'wipe' to confirm: " answer
  [ "$answer" = wipe ] || { echo "aborted"; exit 1; }
  k3d cluster delete "$CLUSTER" || true
fi

if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  step "starting cluster (no-op if running)"
  k3d cluster start "$CLUSTER" >/dev/null
  kubectl config use-context "k3d-$CLUSTER" >/dev/null
  # Docker Desktop on Windows: after a Docker restart the k3d load balancer can keep the
  # server's old IP (kubectl then gets EOF / TLS timeouts). Restarting it re-resolves.
  for i in $(seq 1 12); do api_ok && break; sleep 5; done
  if ! api_ok; then
    echo "API unreachable: restarting k3d load balancer"
    docker restart "k3d-$CLUSTER-serverlb" >/dev/null
    port="$(docker port "k3d-$CLUSTER-serverlb" 6443/tcp | head -1 | sed 's/.*://')"
    kubectl config set-cluster "k3d-$CLUSTER" --server="https://127.0.0.1:$port" >/dev/null
    for i in $(seq 1 24); do api_ok && break; sleep 5; done
    api_ok || { echo "Kubernetes API still unreachable"; exit 1; }
  fi
fi

step "make up (cluster, images, k3d import, helm upgrade --install)"
make up "${MAKE_ARGS[@]}"

step "waiting for every workload to be Ready"
for ns in store mcp platform; do
  kubectl wait --for=condition=Ready pods --all -n "$ns" \
    --field-selector=status.phase!=Succeeded --timeout=300s >/dev/null
done
for ns in store mcp platform; do kubectl get pods -n "$ns" --no-headers | sed "s/^/$ns  /"; done

step "smoke checks"
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$1" || true; }
echo "storefront   http://shop.localtest.me/shop/      -> $(code http://shop.localtest.me/shop/)"
if kubectl get deploy gateway -n platform >/dev/null 2>&1; then
  echo "dashboard    http://yard.localtest.me/           -> $(code http://yard.localtest.me/)"
  echo "mcp endpoint http://mcp.localtest.me/mcp         -> $(code http://mcp.localtest.me/mcp) (401 without a key is correct)"
fi

secret() { kubectl get secret "$2" -n "$1" -o jsonpath="{.data.$3}" 2>/dev/null | base64 -d 2>/dev/null || echo "(not deployed)"; }

step "URLs and logins"
cat <<EOF
Storefront        http://shop.localtest.me/        (place a COD order here)
WooCommerce admin http://shop.localtest.me/wp-admin/
                  user: admin   password: $(secret store wordpress-admin admin-password)
Dashboard         http://yard.localtest.me/
                  admin  (user A): admin@switchyard.local   password: $(secret platform gateway admin-password)
                  member (user B): member@switchyard.local  password: $(secret platform gateway member-password)
MCP endpoint      http://mcp.localtest.me/mcp      (Bearer <API key from the dashboard>)
                  claude mcp add --transport http switchyard http://mcp.localtest.me/mcp \\
                    --header "Authorization: Bearer <key>"
EOF
if [ -z "$(secret platform llm api-key 2>/dev/null)" ] || [ "$(secret platform llm api-key)" = "(not deployed)" ]; then
  echo
  echo "NOTE: no LLM key set, so chat will report an error. Re-run with: bash scripts/demo-reset.sh LLM_API_KEY=..."
fi
