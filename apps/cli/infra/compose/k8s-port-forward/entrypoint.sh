#!/bin/bash
# k8s Port-Forward Entrypoint
# Runs inside a Docker container to forward k8s services onto the Docker network.
# Each forward listens on the remote service's native port so Docker DNS aliases
# (e.g., k8s-frontend:8080) work transparently.

set -euo pipefail

# Colors for container logs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# How long to wait for the cluster at startup before giving up and letting the
# restart policy try again. Overridable because the boot race this covers is a
# property of the host, not of this script.
CLUSTER_WAIT_ATTEMPTS="${CLUSTER_WAIT_ATTEMPTS:-30}"
CLUSTER_WAIT_INTERVAL="${CLUSTER_WAIT_INTERVAL:-10}"

# Service definitions: name|listen_port|remote_port|namespace|pod_prefix|health_path
# listen_port = unique port inside this container (avoids conflicts when
#   multiple k8s services use the same remote_port, e.g. 3001)
# remote_port = the port inside the k8s pod
# health_path = which probe proves the forward alive: an HTTP path, `redis`,
#   `postgres`, or empty for TCP-only (see probe.sh)
#
# Other containers reach these via: k8s-forwards:<listen_port>
# Feature containers reference these ports through environment variable
# configuration.
#
# The table is NOT hardcoded here — it is generated from ~/.sandbox/services.yaml
# by `sandbox connect` (src/lib/k8s_forwards.ts) and mounted at /tmp/forwards.
# This keeps the container, services.yaml, and shared-infra.yml ports/aliases in
# lockstep. Blank lines and #-comments in the file are ignored.
FORWARDS_FILE="${FORWARDS_FILE:-/tmp/forwards}"
if [ ! -f "$FORWARDS_FILE" ]; then
    echo -e "${RED}FATAL: forward table $FORWARDS_FILE not found.${NC}" >&2
    echo "Run 'sandbox connect' on the host to generate it (from ~/.sandbox/services.yaml)." >&2
    exit 1
fi
FORWARDS=()
while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in ''|'#'*) continue ;; esac
    FORWARDS+=("$_line")
done < "$FORWARDS_FILE"
if [ ${#FORWARDS[@]} -eq 0 ]; then
    echo -e "${RED}FATAL: forward table $FORWARDS_FILE has no entries.${NC}" >&2
    exit 1
fi

MONGO_POD_PREFIX="percona-mongodb-clust-rs0"
MONGO_USER="${MONGO_USER:-sb-dev-rw-group}"

# log NAME MESSAGE
# Writes a timestamped, service-prefixed line to container stdout
# (visible in 'docker logs sandbox-k8s-forwards').
log() {
    local name="$1"
    local msg="$2"
    local ts
    ts=$(date '+%Y-%m-%d %H:%M:%S')
    printf '%s  %-24s  %s\n' "$ts" "[$name]" "$msg"
}

# check_health lives in probe.sh, which the compose healthcheck also runs
# directly — the two must not drift, so there is one copy.
source /usr/local/bin/probe.sh

# Find the MongoDB primary pod by querying the replica set
find_mongo_primary() {
    local namespace="$1"
    local primary_pod=""

    if [ -z "${MONGO_PASSWORD:-}" ]; then
        echo "[mongo] MONGO_PASSWORD not set — skipping primary detection" >&2
    else
        echo "[mongo] Finding primary via ${MONGO_POD_PREFIX}-0..." >&2
        local mongo_stderr primary_host mongo_exit
        mongo_stderr=$(mktemp /tmp/mongo-primary.XXXXXX)
        primary_host=$(kubectl exec -n "$namespace" "${MONGO_POD_PREFIX}-0" -- \
            mongosh -u "$MONGO_USER" -p "$MONGO_PASSWORD" \
            --authenticationDatabase admin --quiet \
            --eval "db.isMaster().primary" 2>"$mongo_stderr")
        mongo_exit=$?

        if [ -n "$primary_host" ] && [ "$mongo_exit" -eq 0 ]; then
            # e.g. percona-mongodb-clust-rs0-2.percona-mongodb-clust-rs0.psmdb.svc.cluster.local:27017
            primary_pod=$(echo "$primary_host" | cut -d'.' -f1)
            echo "[mongo] Found primary: $primary_pod" >&2
        else
            echo "[mongo] Primary detection failed (mongosh exit=$mongo_exit). Diagnostics:" >&2
            sed 's/^/[mongo]   /' "$mongo_stderr" >&2
        fi
        rm -f "$mongo_stderr"
    fi

    # Fallback: if primary detection failed, pick first available rs0 pod
    if [ -z "$primary_pod" ]; then
        echo "[mongo] Falling back to first available mongod pod (writes may fail on secondary)" >&2
        primary_pod=$(kubectl get pods -n "$namespace" -l "app.kubernetes.io/component=mongod" \
            --field-selector=status.phase=Running --request-timeout=10s \
            -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
    fi

    echo "$primary_pod"
}

find_pod() {
    local namespace="$1"
    local pod_prefix="$2"

    if [ -z "$pod_prefix" ]; then
        pod_prefix="$namespace"
    fi

    # Special handling for MongoDB — find the primary replica set member
    if [ "$pod_prefix" = "$MONGO_POD_PREFIX" ]; then
        find_mongo_primary "$namespace"
        return
    fi

    kubectl get pods -n "$namespace" \
        --field-selector=status.phase=Running --request-timeout=10s \
        -o jsonpath="{.items[?(@.metadata.name)].metadata.name}" 2>/dev/null | \
        tr ' ' '\n' | grep "^${pod_prefix}" | head -1
}

# find_kube_resource NAMESPACE POD_PREFIX
# Returns a kubectl port-forward target: "deployment/<name>" or "pod/<name>".
# Prefers deployment-based forwarding — when a deployment rolls new pods the
# reconnect targets the same deployment name instead of having to re-discover
# a new pod name, eliminating the "No pod found" gap during rollouts.
find_kube_resource() {
    local namespace="$1"
    local pod_prefix="$2"

    if [ -z "$pod_prefix" ]; then
        pod_prefix="$namespace"
    fi

    # MongoDB requires special primary-detection logic — stay pod-based.
    if [ "$pod_prefix" = "$MONGO_POD_PREFIX" ]; then
        local pod
        pod=$(find_mongo_primary "$namespace")
        [ -n "$pod" ] && echo "pod/$pod"
        return
    fi

    # Try a deployment whose name starts with pod_prefix first.
    local deploy_name
    deploy_name=$(kubectl get deployments -n "$namespace" --request-timeout=10s \
        -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | \
        grep "^${pod_prefix}" | head -1)
    if [ -n "$deploy_name" ]; then
        echo "deployment/$deploy_name"
        return
    fi

    # Fall back to pod discovery (handles services with no matching deployment).
    local pod
    pod=$(find_pod "$namespace" "$pod_prefix")
    [ -n "$pod" ] && echo "pod/$pod"
}

start_forward() {
    local name="$1"
    local listen_port="$2"
    local remote_port="$3"
    local namespace="$4"
    local pod_prefix="$5"
    local health_path="${6:-}"

    (
        set +e  # Don't let kubectl/auth failures kill the restart loop
        local fail_count=0
        local last_failed_resource=""

        while true; do
            local resource
            resource=$(find_kube_resource "$namespace" "$pod_prefix") || resource=""

            if [ -z "$resource" ]; then
                log "$name" "No target found in namespace '$namespace' — retrying in 30s"
                sleep 30
                continue
            fi

            # If the same resource keeps failing (spot node preempted but pod still shows Running),
            # back off to let k8s reschedule before trying again.
            if [ "$resource" = "$last_failed_resource" ] && [ "$fail_count" -ge 3 ]; then
                log "$name" "Resource $resource failed $fail_count times consecutively — backing off 60s for k8s rescheduling"
                sleep 60
                fail_count=0
                continue
            fi

            log "$name" "Connecting: :${listen_port} → ${resource}:${remote_port} (ns: ${namespace})"
            kubectl port-forward -n "$namespace" --address 0.0.0.0 "$resource" "${listen_port}:${remote_port}" \
                >> /dev/null 2>&1 &
            local kube_pid=$!

            # Wait up to 30s for the port to bind (TCP only — fast)
            local ready=0
            for _ in $(seq 1 30); do
                if nc -z 127.0.0.1 "$listen_port" 2>/dev/null; then
                    ready=1; break
                fi
                sleep 1
            done

            if [ "$ready" -eq 0 ]; then
                log "$name" "FAIL: port :${listen_port} never bound (${resource}) — killing kubectl pid $kube_pid"
                kill "$kube_pid" 2>/dev/null
                wait "$kube_pid" 2>/dev/null || true
                last_failed_resource="$resource"
                ((fail_count++)) || true
                sleep 5
                continue
            fi

            log "$name" "Tunnel ready: :${listen_port} → ${resource}:${remote_port}"
            # Resource connected — reset stale tracking
            last_failed_resource=""
            fail_count=0

            # Monitor: every 45s verify the tunnel is still healthy. This is
            # what restarts a forward that went dead under us; probe.sh picks
            # the probe from health_path.
            # Log a heartbeat every 4 checks (~3 min) so the log confirms the tunnel is alive.
            local check_count=0
            while kill -0 "$kube_pid" 2>/dev/null; do
                sleep 45
                local health_detail
                if ! health_detail=$(check_health "$listen_port" "$health_path"); then
                    log "$name" "FAIL: health check returned $health_detail — restarting kubectl pid $kube_pid"
                    kill "$kube_pid" 2>/dev/null
                    break
                fi
                ((check_count++)) || true
                if [ $((check_count % 4)) -eq 0 ]; then
                    log "$name" "Alive [$health_detail] (check #${check_count}, ${resource})"
                fi
            done

            wait "$kube_pid" 2>/dev/null || true
            log "$name" "Port-forward exited — restarting in 5s"
            sleep 5
        done
    ) &

    echo -e "  ${GREEN}+${NC} $name: 0.0.0.0:${listen_port} -> ${namespace}:${remote_port}"
}

# Verify kubectl can reach the cluster.
#
# Retried, then fatal — never `sleep infinity`. This container starts with
# Docker, which on a host reboot races the cluster's own startup, so the first
# check losing that race is routine. Sleeping on failure kept the container Up
# and idle forever: a happily-sleeping process is not a failure, so
# `restart: unless-stopped` never fired and every forward stayed dead until
# someone restarted it by hand (observed: 30 hours, against a cluster that was
# healthy the whole time). Exiting non-zero hands the retry to the restart
# policy, which is what makes this self-healing.
echo -e "${CYAN}Verifying cluster access...${NC}"
cluster_reachable=""
for attempt in $(seq 1 "$CLUSTER_WAIT_ATTEMPTS"); do
    if kubectl cluster-info --request-timeout=10s > /dev/null 2>&1; then
        cluster_reachable=1
        break
    fi
    echo -e "${YELLOW}Cluster not reachable (attempt ${attempt}/${CLUSTER_WAIT_ATTEMPTS}) — retrying in ${CLUSTER_WAIT_INTERVAL}s...${NC}"
    sleep "$CLUSTER_WAIT_INTERVAL"
done
if [ -z "$cluster_reachable" ]; then
    echo -e "${RED}Cannot reach Kubernetes cluster after $((CLUSTER_WAIT_ATTEMPTS * CLUSTER_WAIT_INTERVAL))s. Check kubeconfig and credentials.${NC}"
    exit 1
fi
echo -e "${GREEN}Cluster access verified.${NC}"
echo ""

echo -e "${CYAN}Starting k8s port-forwards...${NC}"
echo ""

for entry in "${FORWARDS[@]}"; do
    IFS='|' read -r name listen_port remote_port namespace pod_prefix health_path <<< "$entry"
    start_forward "$name" "$listen_port" "$remote_port" "$namespace" "$pod_prefix" "$health_path"
done

echo ""
echo -e "${GREEN}All port-forwards started. Container will stay alive.${NC}"

# Keep container running and forward SIGTERM to children
trap 'echo "Shutting down port-forwards..."; kill $(jobs -p) 2>/dev/null; exit 0' SIGTERM SIGINT

# Wait for all background jobs (using wait with no args waits for all)
while jobs &>/dev/null; do
    wait -n 2>/dev/null || true
done
echo "All port-forwards have exited."
