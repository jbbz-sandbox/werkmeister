#!/bin/bash
# Check that the global werkmeister CLI, its MCP server and the Claude Code
# plugin all run from the repo checkout. Pass --fix to repair drift.
set -uo pipefail

REPO="${WERKMEISTER_REPO:-$HOME/repos/werkmeister}"
CLI="$REPO/apps/cli"
PLUGIN="$REPO/plugins/werkmeister"
SETTINGS="$HOME/.claude/settings.json"
FIX=0; [ "${1:-}" = "--fix" ] && FIX=1
drift=0

ok()   { echo "OK    $*"; }
bad()  { echo "DRIFT $*"; drift=1; }

[ -d "$CLI" ] || { echo "ERROR repo CLI not found at $CLI (set WERKMEISTER_REPO)"; exit 2; }

# 1. CLI binaries on PATH resolve into the repo
for bin in werkmeister w9r; do
  path="$(command -v "$bin" 2>/dev/null || true)"
  real="$([ -n "$path" ] && readlink -f "$path")"
  if [ "$real" = "$CLI/$bin" ]; then ok "$bin -> $real"
  else bad "$bin -> ${real:-<not on PATH>} (want $CLI/$bin)"; cli_drift=1; fi
done
if [ "${cli_drift:-0}" = 1 ] && [ $FIX = 1 ]; then
  echo "FIX   npm rm -g werkmeister && npm link ($CLI)"
  npm rm -g werkmeister >/dev/null 2>&1
  (cd "$CLI" && npm link >/dev/null) || echo "ERROR npm link failed"
fi

# 2. dist is not older than the source it bundles (CLI src + workspace packages)
newer="$(find "$CLI/src" "$REPO"/packages/*/src -type f -newer "$CLI/dist/main.js" 2>/dev/null | head -1)"
if [ ! -f "$CLI/dist/main.js" ] || [ -n "$newer" ]; then
  bad "dist is stale (${newer:-dist/main.js missing})"
  if [ $FIX = 1 ]; then
    # A pull can add deps, and the CLI bundles core's dist: install, then let turbo build core first (SW-319).
    # FIX only after success: a FIX line asks for a restart, which can't help a failed build.
    if out="$(cd "$REPO" && corepack pnpm install --frozen-lockfile 2>&1 && corepack pnpm turbo run build --filter=werkmeister 2>&1)"; then
      echo "FIX   corepack pnpm install --frozen-lockfile && corepack pnpm turbo run build --filter=werkmeister"
    else
      echo "ERROR rebuild failed: $(grep -m3 -iE 'error' <<<"$out" | tr '\n' ' ')"
    fi
  fi
else ok "dist is up to date"; fi

# 3. WERKMEISTER_ROOT in env.sh points at the repo
envroot="$(sed -n 's/^export WERKMEISTER_ROOT=//p' "$HOME/.werkmeister/env.sh" 2>/dev/null)"
if [ "$envroot" = "$CLI" ]; then ok "env.sh WERKMEISTER_ROOT=$envroot"
else bad "env.sh WERKMEISTER_ROOT=${envroot:-<unset>} (want $CLI; fix werkmeister_root in ~/.werkmeister/config.yaml, then run werkmeister machine config --write)"; fi

# 4. Plugin loads from the repo folder, with no marketplace copy shadowing it
dirs="$(node -e 'try{console.log(require(process.argv[1]).env?.CLAUDE_CODE_PLUGIN_DIRS??"")}catch{}' "$SETTINGS")"
if [[ ":$dirs:" == *":$PLUGIN:"* ]]; then ok "CLAUDE_CODE_PLUGIN_DIRS includes $PLUGIN"
else
  bad "CLAUDE_CODE_PLUGIN_DIRS=${dirs:-<unset>} (want it to include $PLUGIN)"
  if [ $FIX = 1 ]; then
    echo "FIX   add $PLUGIN to CLAUDE_CODE_PLUGIN_DIRS in $SETTINGS"
    node -e '
      const fs=require("fs"),[f,p]=process.argv.slice(1);
      const s=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};
      s.env??={}; const d=(s.env.CLAUDE_CODE_PLUGIN_DIRS||"").split(":").filter(Boolean);
      s.env.CLAUDE_CODE_PLUGIN_DIRS=[...d,p].join(":"); s.env.CLAUDE_CODE_PLUGIN_DIR_WATCH="1";
      fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n");' "$SETTINGS" "$PLUGIN"
  fi
fi
# 4b. The env this session actually started with; a launcher can override settings.json
live="${CLAUDE_CODE_PLUGIN_DIRS:-}"
if [ -n "$live" ]; then
  IFS=: read -ra live_dirs <<<"$live"
  for d in "${live_dirs[@]}"; do
    [ -z "$d" ] || [ -d "$d" ] || bad "live CLAUDE_CODE_PLUGIN_DIRS has a missing dir: $d (restart Claude so it picks up $SETTINGS)"
  done
  if [[ ":$live:" == *":$PLUGIN:"* ]]; then ok "live CLAUDE_CODE_PLUGIN_DIRS includes $PLUGIN"
  else bad "live CLAUDE_CODE_PLUGIN_DIRS=$live (want it to include $PLUGIN; restart Claude)"; fi
fi
if grep -q '"werkmeister@' "$HOME/.claude/plugins/installed_plugins.json" 2>/dev/null; then
  bad "a marketplace werkmeister plugin is installed and shadows the repo folder (run: claude plugin uninstall werkmeister)"
else ok "no marketplace werkmeister plugin installed"; fi

# 5. Plugin MCP server is launched through the PATH binary checked above
cmd="$(node -e 'console.log(require(process.argv[1]).mcpServers.werkmeister.command)' "$PLUGIN/.mcp.json" 2>/dev/null)"
[ "$cmd" = werkmeister ] && ok "plugin MCP runs '$cmd mcp' from PATH" || bad "plugin MCP command is '$cmd' (expected werkmeister)"

[ $drift = 0 ] && echo "RESULT clean" || echo "RESULT drift found$([ $FIX = 1 ] && echo ', fixes applied: rerun to confirm')"
exit $drift
