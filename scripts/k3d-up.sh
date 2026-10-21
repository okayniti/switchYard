#!/usr/bin/env bash
# Create the local k3d cluster. Idempotent: does nothing if the cluster already exists.
#
# k3s ships Traefik (ingress), local-path (storage) and a NetworkPolicy controller,
# which is exactly what the VPS (k3s) runs — that is the local/prod parity argument.
set -euo pipefail

CLUSTER="${CLUSTER:-switchyard}"
K3S_IMAGE="${K3S_IMAGE:-rancher/k3s:v1.35.5-k3s1}"

if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  echo "k3d cluster '$CLUSTER' already exists"
  exit 0
fi

# Host ports 80/443 -> the k3d load balancer -> Traefik, so *.localtest.me
# (public DNS for 127.0.0.1) reaches the Ingress without any port numbers.
k3d cluster create "$CLUSTER" \
  --image "$K3S_IMAGE" \
  --servers 1 \
  --agents 0 \
  -p "80:80@loadbalancer" \
  -p "443:443@loadbalancer" \
  --wait

kubectl config use-context "k3d-$CLUSTER"
kubectl get nodes -o wide
