#!/usr/bin/env bash
# Proves the store setup is idempotent and that the Helm 4 behaviour we rely on holds:
#   - two `helm upgrade`s re-run the setup Job without duplicating products, users or API keys
#   - lookup keeps generated Secrets byte-for-byte stable across upgrades
#   - hook-delete-policy before-hook-creation leaves exactly one setup Job
#   - helm history / helm rollback work and the storefront survives a rollback
set -euo pipefail

RELEASE="${RELEASE:-switchyard}"
CHART="${CHART:-charts/switchyard}"
VALUES="${VALUES:-charts/switchyard/values-local.yaml}"
NS=store
fail() { echo "FAIL: $*" >&2; exit 1; }

wpx() { MSYS_NO_PATHCONV=1 kubectl exec -n "$NS" deploy/wordpress -c wordpress -- "$@"; }

snapshot() {
  # Secrets as hashes (never print values).
  for s in "$NS/mariadb" "$NS/wordpress-admin" "$NS/woocommerce-api-key" "mcp/woocommerce-api-key"; do
    printf '%s=%s\n' "$s" "$(kubectl get secret -n "${s%%/*}" "${s#*/}" -o jsonpath='{.data}' | sha256sum | cut -c1-12)"
  done
  echo "products=$(wpx wp wc product list --user=admin --format=count)"
  echo "users=$(wpx wp user list --format=count)"
  echo "api_keys=$(wpx wp eval 'global $wpdb; echo $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->prefix}woocommerce_api_keys");')"
  echo "cod=$(wpx wp wc payment_gateway get cod --field=enabled --user=admin)"
  echo "timezone=$(wpx wp option get timezone_string)"
  echo "currency=$(wpx wp option get woocommerce_currency)"
}

upgrade() { helm upgrade "$RELEASE" "$CHART" -f "$VALUES" --wait --wait-for-jobs --timeout 10m >/dev/null; }

echo "== before"; before="$(snapshot)"; echo "$before"
echo "== helm upgrade #1"; upgrade
echo "== helm upgrade #2"; upgrade
echo "== after"; after="$(snapshot)"; echo "$after"
[ "$before" = "$after" ] || { diff <(echo "$before") <(echo "$after") || true; fail "state changed across upgrades"; }
echo "PASS: identical state (secrets, products, users, api keys, settings) after two upgrades"

jobs="$(kubectl get jobs -n "$NS" -l app.kubernetes.io/name=store-setup --no-headers | wc -l)"
[ "$jobs" -eq 1 ] || fail "expected exactly 1 setup Job, found $jobs"
kubectl get job store-setup -n "$NS" -o jsonpath='{.status.succeeded}' | grep -qx 1 || fail "setup Job did not succeed"
echo "PASS: before-hook-creation left exactly one setup Job, and it succeeded"

echo "== helm history (last 3)"; helm history "$RELEASE" --max 3
cur="$(helm history "$RELEASE" --max 1 -o json | sed -E 's/.*"revision":([0-9]+).*/\1/')"
prev=$((cur - 1))
echo "== helm rollback to $prev"; helm rollback "$RELEASE" "$prev" --wait --timeout 10m >/dev/null
code="$(curl -s -o /dev/null -w '%{http_code}' http://shop.localtest.me/)"
[ "$code" = 200 ] || fail "storefront returned $code after rollback"
rolled="$(snapshot)"
[ "$before" = "$rolled" ] || { diff <(echo "$before") <(echo "$rolled") || true; fail "state changed after rollback"; }
echo "PASS: rollback to revision $prev kept the storefront up (200) and all state intact"
helm history "$RELEASE" --max 2
