#!/usr/bin/env bash
# Create the local k3d cluster. Idempotent: an existing cluster is only trimmed.
#
# k3s ships Traefik (ingress), local-path (storage) and a NetworkPolicy controller,
# which is exactly what the VPS (k3s) runs — that is the local/prod parity argument.
# metrics-server is disabled: nothing here uses it (no HPA), and it costs memory on an
# 8 GB laptop.
set -euo pipefail

CLUSTER="${CLUSTER:-switchyard}"
K3S_IMAGE="${K3S_IMAGE:-rancher/k3s:v1.35.5-k3s1}"

trim_existing() {
  # k3s re-applies its bundled addons on every start unless a <manifest>.skip file exists.
  local node="k3d-$CLUSTER-server-0"
  docker exec "$node" sh -c '
    d=/var/lib/rancher/k3s/server/manifests/metrics-server
    [ -d "$d" ] && for f in "$d"/*.yaml; do touch "$f.skip"; done; true'
  kubectl delete apiservice v1beta1.metrics.k8s.io --ignore-not-found >/dev/null
  kubectl -n kube-system delete deployment,service metrics-server --ignore-not-found >/dev/null
  echo "metrics-server disabled"
}

if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  echo "k3d cluster '$CLUSTER' already exists"
  trim_existing
  exit 0
fi

# Host ports 80/443 -> the k3d load balancer -> Traefik, so *.localtest.me
# (public DNS for 127.0.0.1) reaches the Ingress without any port numbers.
# --api-port pins the API to 127.0.0.1: on Docker Desktop for Windows the default
# kubeconfig server (host.docker.internal) can resolve to an unreachable address.
k3d cluster create "$CLUSTER" \
  --image "$K3S_IMAGE" \
  --servers 1 \
  --agents 0 \
  --api-port 127.0.0.1:6550 \
  -p "80:80@loadbalancer" \
  -p "443:443@loadbalancer" \
  --k3s-arg "--disable=metrics-server@server:0" \
  --wait

kubectl config use-context "k3d-$CLUSTER"
kubectl get nodes -o wide
