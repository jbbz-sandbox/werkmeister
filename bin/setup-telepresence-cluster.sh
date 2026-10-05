#!/bin/bash
# One-time cluster bootstrap: install telepresence's traffic-manager into the
# OrbStack k8s cluster.
#
# This is NOT part of `sandbox setup` on purpose: `sandbox setup` provisions
# per-developer machine state (CLI binaries, certs, /etc/hosts). This installs
# a workload into the shared cluster itself, so it only needs to run once per
# cluster, not once per developer machine.
#
# Symptom this fixes: `sandbox intercept <feature> -s <service>` failing with
#   telepresence connect: error: traffic manager not found, if it is not
#   installed, please run 'telepresence helm install'.
#
# Usage: bin/setup-telepresence-cluster.sh

set -euo pipefail

NAMESPACE="ambassador"

CTX="$(kubectl config current-context)"
if [ "$CTX" != "orbstack" ]; then
  echo "Refusing to install: kube context is '$CTX', expected 'orbstack'." >&2
  echo "Run: kubectl config use-context orbstack" >&2
  exit 1
fi

if ! command -v telepresence >/dev/null 2>&1; then
  echo "telepresence CLI not found on PATH. Run 'sandbox setup' first." >&2
  exit 1
fi

if kubectl get deployment traffic-manager -n "$NAMESPACE" >/dev/null 2>&1; then
  echo "traffic-manager already installed in namespace '$NAMESPACE' — nothing to do."
  exit 0
fi

echo "Installing telepresence traffic-manager into the orbstack cluster..."
telepresence helm install

echo "Waiting for traffic-manager to become ready..."
kubectl -n "$NAMESPACE" rollout status deployment/traffic-manager --timeout=60s

echo ""
echo "Done. You can now run: sandbox intercept <feature> -s <service>"
