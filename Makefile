SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c

CLUSTER   ?= switchyard
RELEASE   ?= switchyard
CHART     := charts/switchyard
VALUES    ?= $(CHART)/values-local.yaml
TAG       ?= dev

# Images built locally and imported into k3d (values-local.yaml uses these tags).
IMAGES := switchyard-wordpress:$(TAG)

.PHONY: help up down cluster images import install status admin-password

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-16s %s\n", $$1, $$2}'

up: cluster images import install ## Create cluster, build + import images, helm install local

cluster: ## Create the k3d cluster (idempotent)
	CLUSTER=$(CLUSTER) bash scripts/k3d-up.sh

images: ## Build local images
	docker build -t switchyard-wordpress:$(TAG) images/wordpress

import: ## Import local images into k3d
	k3d image import -c $(CLUSTER) $(IMAGES)

install: ## helm upgrade --install with local values
	helm upgrade --install $(RELEASE) $(CHART) -f $(VALUES) --wait --timeout 15m

admin-password: ## Print the WordPress admin login (user: admin)
	@kubectl get secret wordpress-admin -n store -o jsonpath='{.data.admin-password}' | base64 -d; echo

status: ## Show what is running
	kubectl get ns,pods,pvc,svc,ingress,networkpolicy -A -l app.kubernetes.io/part-of=switchyard

down: ## Delete the k3d cluster (destroys all PVC data)
	k3d cluster delete $(CLUSTER)
