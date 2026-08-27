#!/bin/bash
# Health probes for the k8s port-forwards. Two callers, one definition:
#
#   - entrypoint.sh sources this file and calls check_health on each forward
#     every 45s, restarting the kubectl process behind a failing one.
#   - the compose healthcheck runs this file directly (no args), probing every
#     forward in the table. Reading the generated table is what keeps the
#     healthcheck from drifting the way its hand-written port list did.
#
# Which probe runs is the forward's health column (services.yaml's
# `health_endpoint`), passed through the generated /tmp/forwards table:
#
#   /path      HTTP GET, 2xx-4xx passes
#   redis      RESP PING, must answer PONG
#   postgres   pg_isready — a real startup handshake, no credentials needed
#   (empty)    TCP connect only
#
# The empty case is the weak one and the reason the other two exist: a stale
# `kubectl port-forward` accepts the connection and never replies, so a TCP
# probe reports a dead forward as healthy (docs/known-issues.md).

# check_health PORT [HEALTH]
# Prints a result detail string to stdout; returns 0 if healthy.
check_health() {
    local port="$1"
    local health="${2:-}"

    case "$health" in
        "")
            if nc -z 127.0.0.1 "$port" 2>/dev/null; then
                echo "tcp:ok"
                return 0
            fi
            echo "tcp:fail"
            return 1
            ;;
        redis)
            # `timeout` rather than redis-cli's own -t: that one bounds the
            # connect, and a dead forward's connect succeeds — it's the reply
            # that never comes.
            if [ "$(timeout 5 redis-cli -h 127.0.0.1 -p "$port" ping 2>/dev/null)" = "PONG" ]; then
                echo "redis:pong"
                return 0
            fi
            echo "redis:fail"
            return 1
            ;;
        postgres)
            if timeout 5 pg_isready -h 127.0.0.1 -p "$port" -q 2>/dev/null; then
                echo "pg:ready"
                return 0
            fi
            echo "pg:fail"
            return 1
            ;;
        /*)
            # HTTP check via nc — no curl dependency needed.
            # Accepts 2xx/3xx/4xx (service alive); rejects 5xx or no response.
            local response status_code
            response=$(printf "GET %s HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n" "$health" | \
                nc -w5 127.0.0.1 "$port" 2>/dev/null | head -1)
            status_code=$(echo "$response" | awk '{print $2}')
            if [[ "$status_code" =~ ^[2-4][0-9][0-9]$ ]]; then
                echo "http:${status_code}"
                return 0
            fi
            echo "http:fail(${status_code:-no-response})"
            return 1
            ;;
        *)
            echo "unknown-probe:${health}"
            return 1
            ;;
    esac
}

# Probe every forward in the table. Returns 1 if any is unhealthy.
probe_all() {
    local file="${FORWARDS_FILE:-/tmp/forwards}"
    local name listen remote ns prefix health detail rc=0
    if [ ! -f "$file" ]; then
        echo "no forward table at $file"
        return 1
    fi
    while IFS='|' read -r name listen remote ns prefix health || [ -n "$name" ]; do
        case "$name" in ''|'#'*) continue ;; esac
        detail=$(check_health "$listen" "$health") || rc=1
        echo "${name}:${detail}"
    done < "$file"
    return $rc
}

# Sourced by entrypoint.sh: definitions only. Run directly: probe everything.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    probe_all
fi
