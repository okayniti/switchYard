SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c

CLUSTER   ?= switchyard
RELEASE   ?= switchyard
CHART     := charts/switchyard
VALUES    ?= $(CHART)/values-local.yaml
TAG       ?= dev

# Our apps (built from the repo root with apps/<name>/Dockerfile) and their values keys.
APPS      := woo-mcp shipping-mcp gateway
key_woo-mcp      := wooMcp
key_shipping-mcp := shippingMcp
key_gateway      := gateway

# An app is built only once its Dockerfile exists; one whose image is missing is
# installed with <key>.enabled=false, so `make up` works while apps are still being written.
image_exists = $(shell docker image inspect switchyard-$(1):$(TAG) >/dev/null 2>&1 && echo yes)
DISABLED_FLAGS = $(foreach a,$(APPS),$(if $(call image_exists,$(a)),,--set $(key_$(a)).enabled=false))

.PHONY: help up down cluster images import install status admin-password gateway-admin-password llm-key dod

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-24s %s\n", $$1, $$2}'

up: cluster images import install ## Create cluster, build + import images, helm install local

cluster: ## Create the k3d cluster with host ports 80/443 (idempotent)
	CLUSTER=$(CLUSTER) bash scripts/k3d-up.sh

images: ## Build all local images, ONE AT A TIME (8 GB laptop), then prune build cache
	docker build -t switchyard-wordpress:$(TAG) images/wordpress
	docker build -t switchyard-everything-mcp:$(TAG) images/everything-mcp
	@for a in $(APPS); do \
	  if [ -f apps/$$a/Dockerfile ]; then \
	    echo "building switchyard-$$a:$(TAG)"; \
	    docker build -f apps/$$a/Dockerfile -t switchyard-$$a:$(TAG) . ; \
	  else echo "skip $$a: apps/$$a/Dockerfile not found"; fi; \
	done
	docker builder prune -f >/dev/null
	@echo "build cache pruned"

import: ## Import switchyard images into k3d one at a time (lower peak memory)
	@for img in $$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^switchyard-.*:$(TAG)$$'); do \
	  echo "importing $$img"; k3d image import -c $(CLUSTER) $$img >/dev/null; \
	done

# LLM key: `make up LLM_API_KEY=...` stores it in the llm Secret; it is never echoed or committed.
install: ## helm upgrade --install with local values
	@echo "helm upgrade --install $(RELEASE) $(CHART) -f $(VALUES) $(DISABLED_FLAGS)$(if $(LLM_API_KEY), --set-string gateway.llm.apiKey=***)"
	@helm upgrade --install $(RELEASE) $(CHART) -f $(VALUES) $(DISABLED_FLAGS) \
	  $(if $(LLM_API_KEY),--set-string gateway.llm.apiKey=$(LLM_API_KEY)) \
	  --wait --wait-for-jobs --timeout 15m

llm-key: ## Set ONLY the LLM key Secret and restart the gateway: make llm-key LLM_API_KEY=...
	@test -n "$(LLM_API_KEY)" || { echo "usage: make llm-key LLM_API_KEY=<key>" >&2; exit 1; }
	@# Manifest goes to kubectl on stdin, so the key never appears in the echoed command.
	@# Later `make install` runs without LLM_API_KEY keep it (the template reuses it via lookup).
	@printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: llm\n  namespace: platform\ntype: Opaque\ndata:\n  api-key: %s\n' \
	  "$$(printf '%s' '$(LLM_API_KEY)' | base64 | tr -d '\n')" | kubectl apply -f - 2>&1 | grep -v last-applied-configuration
	kubectl rollout restart deployment/gateway -n platform
	kubectl rollout status deployment/gateway -n platform --timeout=180s

admin-password: ## Print the WordPress admin login (user: admin)
	@kubectl get secret wordpress-admin -n store -o jsonpath='{.data.admin-password}' | base64 -d; echo

gateway-admin-password: ## Print the dashboard admin + member passwords
	@echo -n "admin  (admin@switchyard.local):  "; kubectl get secret gateway -n platform -o jsonpath='{.data.admin-password}' | base64 -d; echo
	@echo -n "member (member@switchyard.local): "; kubectl get secret gateway -n platform -o jsonpath='{.data.member-password}' | base64 -d; echo

dod: ## Run the Definition-of-Done checks against the cluster (ONLY=3,6 to pick)
	@ADMIN_PASSWORD="$$(kubectl get secret gateway -n platform -o jsonpath='{.data.admin-password}' | base64 -d)" \
	 MEMBER_PASSWORD="$$(kubectl get secret gateway -n platform -o jsonpath='{.data.member-password}' | base64 -d)" \
	 ONLY="$(ONLY)" node --experimental-strip-types --no-warnings scripts/dod.ts

status: ## Show what is running
	kubectl get pods,pvc,svc,ingress,networkpolicy -n store
	kubectl get pods,pvc,svc,ingress,networkpolicy -n mcp
	kubectl get pods,pvc,svc,ingress,networkpolicy -n platform

down: ## Delete the k3d cluster (destroys all PVC data)
	k3d cluster delete $(CLUSTER)
