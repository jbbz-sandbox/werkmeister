#!/bin/bash
# Build next-hello + rest-hello Docker images and deploy them to OrbStack Kubernetes.
# OrbStack shares its image store with its k8s cluster, so a local `docker build` is
# all the "push" needed — helm upgrade + rollout restart then run the fresh image.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Guard: never deploy to a non-orbstack cluster by accident.
CTX="$(kubectl config current-context)"
if [ "$CTX" != "orbstack" ]; then
  echo "Refusing to deploy: kube context is '$CTX', expected 'orbstack'." >&2
  echo "Run: kubectl config use-context orbstack" >&2
  exit 1
fi

# app | image tag | helm values file
APPS=(
  "rest-hello|rest-hello:local|charts/rest-hello.values.yaml"
  "next-hello|next-hello:local|charts/next-hello.values.yaml"
)

for entry in "${APPS[@]}"; do
  IFS='|' read -r app image values <<< "$entry"

  echo "==> Building $image"
  docker build -t "$image" "apps/$app"

  echo "==> Deploying $app"
  helm upgrade --install "$app" charts/webapp -f "$values"

  # Static :local tag + IfNotPresent means helm won't recreate pods on bytes-only
  # changes — force it so the new image actually runs.
  kubectl rollout restart "deployment/$app"
done

for entry in "${APPS[@]}"; do
  IFS='|' read -r app _ _ <<< "$entry"
  kubectl rollout status "deployment/$app" --timeout=120s
done

echo "Done. next-hello + rest-hello are live on orbstack."
