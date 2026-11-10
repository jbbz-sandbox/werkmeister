#!/bin/sh
# Seed a throwaway werkmeister home with the three demo workspaces every UIs-page
# screenshot shares (SW-98 seed; SW-599: Jira tracker; SW-624: committed here).
# The printed env points a dashboard at the demo config, and WERKMEISTER_HOST at a dead port so
# its buttons cannot reach the real daemon. Capture only: click nothing.
#   sh scripts/docs-demo-home.sh [features root]
# A short features root (SW-628) keeps /var/folders/... out of the dashboard header.
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
FIX="$REPO/apps/cli/src/lib/__tests__/fixtures"
DEMO=$(mktemp -d -t w9r-demo)
DOT="$DEMO/.werkmeister"
ROOT=${1:-$DEMO/features}
mkdir -p "$DOT" "$ROOT"
cp "$FIX/services.yaml" "$FIX/ports.yaml" "$DOT/"
cat > "$DOT/config.yaml" <<YAML
jira:
  base_url: https://example.atlassian.net/
overrides:
  issue_tracker: jira
paths:
  workspaces_root: $ROOT
YAML

# One session record per workspace (SW-487 layout). A busy record is "working" only while its
# last hook event is under 30 min old, so every time here is relative to now, never fixed.
iso() { T=$(($(date +%s) - $1)); date -u -r "$T" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$T" +%Y-%m-%dT%H:%M:%SZ; }
NEW=$(iso 600); OLD=$(iso 50400)

# name  issue  type  task  done-stages  agent  question
seed() {
  d="$ROOT/$1"; mkdir -p "$d/.werkmeister"
  i=0; for s in 01_research 02_spec 03_implement 04_propose; do
    i=$((i+1)); mkdir -p "$d/stages/$s/output"
    [ "$i" -le "$5" ] && echo "demo" > "$d/stages/$s/output/notes.md"
  done
  cat > "$d/.werkmeister/workspace.yml" <<YAML
feature: $1
issue_id: $2
work_type: $3
task: $4
labels:
  - focus
repos: demo-app
YAML
  mkdir -p "$d/.werkmeister/sessions"
  case "$6" in
    working)   printf '{"status":"busy","at":"%s","last":"%s"}\n' "$NEW" "$NEW" ;;
    needs-you) printf '{"status":"idle","at":"%s","ask":{"kind":"question","what":"%s","at":"%s","source":"session"}}\n' "$OLD" "$7" "$OLD" ;;
    done)      printf '{"status":"idle","at":"%s","stopped":true}\n' "$OLD" ;;
  esac > "$d/.werkmeister/sessions/demo.json"
}
seed demo-12-checkout-retry DEMO-12 feature "Retry a checkout that fails on a card decline" 2 working
seed demo-15-search-facets  DEMO-15 feature "Add facets to the search results page" 1 needs-you "Should the facet panel collapse on phone widths?"
seed demo-19-login-copy     DEMO-19 bug     "Fix the login error copy" 4 done
cat > "$ROOT/demo-19-login-copy/stages/04_propose/output/pr-demo-app.md" <<YAML
---
repo: example/demo-app
branch: demo/demo-19-login-copy
base: main
status: merged
url: https://github.com/example/demo-app/pull/19
---
YAML

echo "export WERKMEISTER_CONFIG_FILE=$DOT/config.yaml"
echo "export WERKMEISTER_WORKSPACES_ROOT=$ROOT"
echo "export WERKMEISTER_HOST=http://127.0.0.1:1"
echo "# demo dir: $DEMO"
