#!/bin/bash
# Generate the self-signed TLS certificate the sandbox ingress terminates.
#
# The hostnames are NOT hardcoded here. They come from the sandbox ingress
# config (`ingress.local_domain` / `ingress.remote_domain` in
# ~/.sandbox/config.yaml, crossed with the routed services in
# ~/.sandbox/services.yaml) and are passed in by `sandbox setup` via --domain.
# That way the certificate SANs, the /etc/hosts entries and the Caddy site
# blocks all derive from one list instead of three hand-synced copies.
#
# Standalone use (no CLI): pass --domain yourself, or set SANDBOX_INGRESS_HOSTS
# to a comma/space-separated list. `sandbox setup` is the normal entry point.
#
# Usage:
#   generate-certs.sh [--domain HOST]... [--certs-dir DIR]
#                     [--no-trust] [--no-hosts] [--force] [--check]
#
#   --domain HOST    Hostname to cover (repeatable). Also seeds /etc/hosts.
#   --certs-dir DIR  Output directory  [$SANDBOX_CERTS_DIR, else ~/.docker/certs]
#   --no-trust       Skip adding the cert to the macOS System keychain (no sudo)
#   --no-hosts       Skip the /etc/hosts update (no sudo)
#   --force          Regenerate even if a certificate already exists
#   --check          Report only; exit 1 if the cert is missing or stale
#
# Exit codes: 0 ok / already current, 1 missing-or-stale (--check) or failure.

set -euo pipefail

CERTS_DIR="${SANDBOX_CERTS_DIR:-$HOME/.docker/certs}"
DO_TRUST=true
DO_HOSTS=true
FORCE=false
CHECK_ONLY=false
DOMAINS=()

# Seed from the env fallback (comma or whitespace separated) before parsing
# flags, so an explicit --domain adds to it rather than being overridden.
if [ -n "${SANDBOX_INGRESS_HOSTS:-}" ]; then
    IFS=', ' read -r -a DOMAINS <<< "$SANDBOX_INGRESS_HOSTS"
fi

while [ $# -gt 0 ]; do
    case "$1" in
        --domain)     DOMAINS+=("$2"); shift 2 ;;
        --domain=*)   DOMAINS+=("${1#*=}"); shift ;;
        --certs-dir)  CERTS_DIR="$2"; shift 2 ;;
        --certs-dir=*) CERTS_DIR="${1#*=}"; shift ;;
        --no-trust)   DO_TRUST=false; shift ;;
        --no-hosts)   DO_HOSTS=false; shift ;;
        --force)      FORCE=true; shift ;;
        --check)      CHECK_ONLY=true; shift ;;
        -h|--help)    sed -n '2,28p' "$0"; exit 0 ;;
        *)            echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

CRT="$CERTS_DIR/localhost.crt"
KEY="$CERTS_DIR/localhost.key"

# --- SAN list --------------------------------------------------------------
# localhost always; then each requested host plus a wildcard for its parent
# domain, so a later service on the same domain is already covered.
SANS=("DNS:localhost" "DNS:*.localhost" "IP:127.0.0.1")
seen_wildcards=""
for domain in ${DOMAINS+"${DOMAINS[@]}"}; do
    [ -n "$domain" ] || continue
    SANS+=("DNS:$domain")
    parent="${domain#*.}"
    # Only wildcard a real parent domain (a.b.c -> *.b.c), never a bare TLD.
    if [ "$parent" != "$domain" ] && [ "${parent#*.}" != "$parent" ]; then
        case " $seen_wildcards " in
            *" $parent "*) ;;
            *) SANS+=("DNS:*.$parent"); SANS+=("DNS:$parent")
               seen_wildcards="$seen_wildcards $parent" ;;
        esac
    fi
done

SAN_STRING="$(IFS=,; echo "${SANS[*]}")"

# --- check mode ------------------------------------------------------------
# Stale means "exists but doesn't cover every hostname we now route" — the case
# that appears when a service is added to the registry after the cert was made.
missing_sans=()
if [ -f "$CRT" ]; then
    cert_text="$(openssl x509 -in "$CRT" -noout -ext subjectAltName 2>/dev/null || true)"
    for domain in ${DOMAINS+"${DOMAINS[@]}"}; do
        [ -n "$domain" ] || continue
        parent="${domain#*.}"
        if ! grep -qF "DNS:$domain" <<< "$cert_text" \
           && ! grep -qF "DNS:*.$parent" <<< "$cert_text"; then
            missing_sans+=("$domain")
        fi
    done
fi

if [ "$CHECK_ONLY" = true ]; then
    if [ ! -f "$CRT" ] || [ ! -f "$KEY" ]; then
        echo "missing: no certificate at $CRT"
        exit 1
    fi
    if [ ${#missing_sans[@]} -gt 0 ]; then
        echo "stale: certificate does not cover ${missing_sans[*]}"
        exit 1
    fi
    echo "ok: $CRT covers ${#DOMAINS[@]} ingress hostname(s)"
    exit 0
fi

# --- generate --------------------------------------------------------------
mkdir -p "$CERTS_DIR"

if [ -f "$CRT" ] && [ -f "$KEY" ] && [ "$FORCE" != true ]; then
    if [ ${#missing_sans[@]} -gt 0 ]; then
        echo "Certificate at $CRT does not cover: ${missing_sans[*]}"
        echo "Regenerating to add the missing hostnames..."
    else
        echo "Certificates already exist in $CERTS_DIR and cover every ingress hostname."
        echo "To regenerate anyway: $0 --force"
        # Still reconcile /etc/hosts below — a new service needs its hosts entry
        # even when the wildcard SAN already covered it.
        FORCE=skip_generate
    fi
fi

if [ "$FORCE" != "skip_generate" ]; then
    echo "Generating self-signed SSL certificate..."
    echo "  SANs: $SAN_STRING"

    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$KEY" \
        -out "$CRT" \
        -subj "/C=US/ST=State/L=City/O=Dev/CN=localhost" \
        -addext "subjectAltName=$SAN_STRING"

    chmod 600 "$KEY"

    echo ""
    echo "SSL certificate generated:"
    echo "  Certificate: $CRT"
    echo "  Private Key: $KEY"
    echo ""
    echo "Note: Docker Compose mounts these into Caddy via \$SANDBOX_CERTS_DIR."

    # Trust the certificate on macOS.
    if [ "$DO_TRUST" = true ] && [[ "$OSTYPE" == "darwin"* ]]; then
        echo ""
        echo "Trusting the certificate in the System keychain (requires sudo)..."
        if sudo security add-trusted-cert -d -r trustRoot \
                -k /Library/Keychains/System.keychain "$CRT"; then
            echo "Certificate trusted. Restart your browser for it to take effect."
        else
            echo "Failed to trust the certificate automatically. To do it manually:"
            echo "  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain $CRT"
        fi
    elif [ "$DO_TRUST" = true ]; then
        echo ""
        echo "Not macOS — trust $CRT with your platform's certificate store to"
        echo "avoid browser warnings."
    fi
fi

# --- /etc/hosts ------------------------------------------------------------
if [ "$DO_HOSTS" = true ] && [ ${#DOMAINS[@]} -gt 0 ]; then
    echo ""
    echo "Pointing ingress hostnames at 127.0.0.1 in /etc/hosts..."
    hosts_modified=false
    for domain in "${DOMAINS[@]}"; do
        [ -n "$domain" ] || continue
        # Match the hostname as a whole word so `foo.example.com` doesn't count
        # as covering `bar-foo.example.com`.
        if grep -qE "^[^#]*[[:space:]]${domain//./\\.}([[:space:]]|$)" /etc/hosts; then
            echo "  ✓ $domain"
        else
            echo "  + $domain"
            echo "127.0.0.1 $domain" | sudo tee -a /etc/hosts > /dev/null
            hosts_modified=true
        fi
    done
    if [ "$hosts_modified" = true ]; then
        echo "/etc/hosts updated."
    else
        echo "No changes needed to /etc/hosts."
    fi
fi
