#!/bin/bash
# Generate the self-signed TLS certificate the werkmeister ingress terminates.
#
# The hostnames are NOT hardcoded here. They come from the werkmeister ingress
# config (`ingress.local_domain` / `ingress.remote_domain` in
# ~/.werkmeister/config.yaml, crossed with the routed services in
# ~/.werkmeister/services.yaml) and are passed in by `werkmeister setup` via --domain.
# That way the certificate SANs, the /etc/hosts entries and the Caddy site
# blocks all derive from one list instead of three hand-synced copies.
#
# Standalone use (no CLI): pass --domain yourself, or set WERKMEISTER_INGRESS_HOSTS
# to a comma/space-separated list. `werkmeister setup` is the normal entry point.
# WERKMEISTER_HOSTS_FILE overrides /etc/hosts (tests).
#
# Usage:
#   generate-certs.sh [--domain HOST]... [--certs-dir DIR]
#                     [--no-trust] [--no-hosts] [--force] [--check]
#
#   --domain HOST    Hostname to cover (repeatable). Also seeds /etc/hosts.
#   --certs-dir DIR  Output directory  [$WERKMEISTER_CERTS_DIR, else ~/.docker/certs]
#   --no-trust       Skip adding the cert to the macOS System keychain (no sudo)
#   --no-hosts       Skip the /etc/hosts update (no sudo)
#   --force          Regenerate even if a certificate already exists
#   --check          Report only; exit 1 if the cert or /etc/hosts drifted
#
# Exit codes: 0 ok / already current, 1 missing-or-stale (--check) or failure.

set -euo pipefail

CERTS_DIR="${WERKMEISTER_CERTS_DIR:-$HOME/.docker/certs}"
HOSTS_FILE="${WERKMEISTER_HOSTS_FILE:-/etc/hosts}"
HOSTS_BEGIN="# BEGIN sandbox ingress" # name-check: ignore
HOSTS_END="# END sandbox ingress" # name-check: ignore
DO_TRUST=true
DO_HOSTS=true
FORCE=false
CHECK_ONLY=false
DOMAINS=()

# Seed from the env fallback (comma or whitespace separated) before parsing
# flags, so an explicit --domain adds to it rather than being overridden.
INGRESS_HOSTS="${WERKMEISTER_INGRESS_HOSTS:-}"
if [ -n "$INGRESS_HOSTS" ]; then
    IFS=', ' read -r -a DOMAINS <<< "$INGRESS_HOSTS"
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
        -h|--help)    sed -n '2,26p' "$0"; exit 0 ;;
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

# Lines in sorted set $1 that are not in sorted set $2, space-separated.
only_in() { comm -23 <(printf '%s\n' "$1") <(printf '%s\n' "$2") | sed '/^$/d' | tr '\n' ' '; }

# --- check mode ------------------------------------------------------------
# Stale means the explicit SANs differ from the registry either way: a missing
# host appears when a service is added, an extra one when a service is removed.
missing_sans=()
extra_sans=""
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
    extra_sans="$(only_in \
        "$(grep -oE 'DNS:[^,[:space:]]+' <<< "$cert_text" | sort -u || true)" \
        "$(printf '%s\n' "${SANS[@]}" | grep '^DNS:' | sort -u)")"
    extra_sans="${extra_sans//DNS:/}"
fi

# Hosts entries this script owns: everything inside the managed block, plus bare
# `127.0.0.1` lines whose every name sits under an ingress domain — the lines
# older versions appended before the block existed. Anything else is the user's.
# `hosts_scan names` prints the owned names; `hosts_scan rest` prints the file
# without them.
hosts_scan() {
    [ -f "$HOSTS_FILE" ] || return 0
    awk -v mode="$1" -v parents="$seen_wildcards" -v b="$HOSTS_BEGIN" -v e="$HOSTS_END" '
        BEGIN { n = split(parents, p, " ") }
        function ingress(h,   i, s) {
            for (i = 1; i <= n; i++) {
                s = "." p[i]
                if (length(h) > length(s) && substr(h, length(h) - length(s) + 1) == s) return 1
            }
            return 0
        }
        function emit(   i) { if (mode == "names") for (i = 2; i <= NF; i++) print $i }
        $0 == b { inblock = 1; next }
        $0 == e { inblock = 0; next }
        inblock { emit(); next }
        $1 == "127.0.0.1" && NF > 1 {
            owned = 1
            for (i = 2; i <= NF; i++) if (!ingress($i)) owned = 0
            if (owned) { emit(); next }
        }
        mode == "rest" { print }
    ' "$HOSTS_FILE"
}

wanted_hosts="$(printf '%s\n' ${DOMAINS+"${DOMAINS[@]}"} | sed '/^$/d' | sort -u)"
if [ "$DO_HOSTS" = true ]; then
    owned_hosts="$(hosts_scan names | sort -u)"
    extra_hosts="$(only_in "$owned_hosts" "$wanted_hosts")"
    missing_hosts="$(only_in "$wanted_hosts" "$owned_hosts")"
fi

if [ "$CHECK_ONLY" = true ]; then
    drift=false
    if [ ! -f "$CRT" ] || [ ! -f "$KEY" ]; then
        echo "missing: no certificate at $CRT"
        drift=true
    else
        if [ ${#missing_sans[@]} -gt 0 ]; then
            echo "stale: certificate does not cover ${missing_sans[*]}"
            drift=true
        fi
        if [ -n "$extra_sans" ]; then
            echo "stale: certificate has extra SANs ${extra_sans% }"
            drift=true
        fi
    fi
    if [ -n "${missing_hosts:-}" ]; then
        echo "stale: $HOSTS_FILE is missing ${missing_hosts% }"
        drift=true
    fi
    if [ -n "${extra_hosts:-}" ]; then
        echo "stale: $HOSTS_FILE has extra entries ${extra_hosts% }"
        drift=true
    fi
    [ "$drift" = true ] && exit 1
    echo "ok: $CRT covers ${#DOMAINS[@]} ingress hostname(s)"
    exit 0
fi

# --- generate --------------------------------------------------------------
mkdir -p "$CERTS_DIR"

if [ -f "$CRT" ] && [ -f "$KEY" ] && [ "$FORCE" != true ]; then
    if [ ${#missing_sans[@]} -gt 0 ]; then
        echo "Certificate at $CRT does not cover: ${missing_sans[*]}"
        echo "Regenerating to add the missing hostnames..."
    elif [ -n "$extra_sans" ]; then
        echo "Certificate at $CRT has SANs no longer routed: ${extra_sans% }"
        echo "Regenerating to drop them..."
    else
        echo "Certificates already exist in $CERTS_DIR and cover every ingress hostname."
        echo "To regenerate anyway: $0 --force"
        # Still reconcile /etc/hosts below — a new or removed service changes
        # its hosts entry even when the wildcard SAN already covered it.
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
    echo "Note: Docker Compose mounts these into Caddy via \$WERKMEISTER_CERTS_DIR."

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
# Rebuild the managed block from the registry so removed services drop out;
# lines outside it are left exactly as they were.
if [ "$DO_HOSTS" = true ] && [ ${#DOMAINS[@]} -gt 0 ]; then
    echo ""
    echo "Pointing ingress hostnames at 127.0.0.1 in $HOSTS_FILE..."
    rendered="$(
        hosts_scan rest
        echo "$HOSTS_BEGIN"
        while read -r domain; do echo "127.0.0.1 $domain"; done <<< "$wanted_hosts"
        echo "$HOSTS_END"
    )"
    if [ -f "$HOSTS_FILE" ] && [ "$rendered" = "$(cat "$HOSTS_FILE")" ]; then
        echo "No changes needed to $HOSTS_FILE."
    else
        for domain in $missing_hosts; do echo "  + $domain"; done
        for domain in $extra_hosts; do echo "  - $domain"; done
        if [ -w "$HOSTS_FILE" ]; then
            printf '%s\n' "$rendered" > "$HOSTS_FILE"
        else
            printf '%s\n' "$rendered" | sudo tee "$HOSTS_FILE" > /dev/null
        fi
        echo "$HOSTS_FILE updated."
    fi
fi
