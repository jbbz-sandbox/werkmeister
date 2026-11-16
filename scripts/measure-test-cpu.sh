#!/bin/sh
# CPU-s of each test suite in the werkmeister-core row, or of each test file alone (SW-814, from SW-788's measure.sh).
# Run in the service's container from the repo root, e.g.:
#   docker exec -w /app <feature>-werkmeister-core sh scripts/measure-test-cpu.sh -w <workspace path> -o <dir> [-l label] [-f core|cli]
# Writes <dir>/<label>/: suites.tsv or files-<core|cli>.tsv (suite file rc wall_s cpu_s others_s), logs/, totals.txt.
# Waits first as measure-row.sh does (ROW_LOAD_LIMIT, ROW_LOAD_WAIT, exit 75). Exits 1 when a row failed.
# A/B median of one suite or set of files: scripts/ab-row.sh -- <its command>.
# shellcheck source-path=SCRIPTDIR
set -u
here=$(dirname "$0")
. "$here/row-lib.sh"
usage() {
  sed -n '2,8s/^# \{0,1\}//p' "$0" >&2
  exit 2
}
ws='' out='' label=run files=''
while getopts w:o:l:f:h opt; do
  case $opt in
  w) ws=$OPTARG ;;
  o) out=$OPTARG ;;
  l) label=$OPTARG ;;
  f) files=$OPTARG ;;
  *) usage ;;
  esac
done
shift $((OPTIND - 1))
[ -n "$ws" ] && [ -n "$out" ] && [ "$#" -eq 0 ] || usage
case $files in "" | core | cli) ;; *) echo "measure-test-cpu: -f takes core or cli, got '$files'" >&2; exit 2 ;; esac
wrap=$ws/.werkmeister/bin/with-temp-home
[ -x "$wrap" ] || { echo "measure-test-cpu: no $wrap; is -w the workspace folder?" >&2; exit 2; }
own_out measure-test-cpu
case $label in "" | .* | */*) echo "measure-test-cpu: -l takes a plain name, got '$label'" >&2; exit 2 ;; esac
[ "$PWD" = /app ] && [ -f turbo.json ] || { echo "measure-test-cpu: run from /app in the container (docker exec -w /app)" >&2; exit 2; }

# Wait once, then run every row under one temp HOME, so no row pays with-temp-home's setup.
if [ -z "${MEASURE_TEST_CPU_INNER:-}" ]; then
  wait_quiet || exit $?
  exec "$wrap" --no-wait env MEASURE_TEST_CPU_INNER=1 MTC_WAITED="$waited_s" MTC_BUSY="$busy_before" \
    MTC_LOAD="$(cut -d' ' -f1-3 /proc/loadavg | tr ' ' /)" sh "$0" -w "$ws" -o "$out" -l "$label" ${files:+-f "$files"}
fi

dir=$out/$label
mkdir -p "$dir/logs" || exit 1
tsv=$dir/suites.tsv
[ -z "$files" ] || tsv=$dir/files-$files.tsv
printf 'suite\tfile\trc\twall_s\tcpu_s\tothers_s\n' | tee "$tsv"
n=0
row() { # <suite> <file> <cmd...>
  n=$((n + 1))
  r_suite=$1 r_file=$2
  shift 2
  measure_one "$r_suite" "$r_file" "$dir/logs/$n.log" "$@" | tee -a "$tsv"
}

case $files in
"")
  row build - pnpm turbo run build --force \
    --filter=werkmeister --filter=werkmeister-mcp --filter=werkmeister-core --filter=werkmeister-plugin
  row core-test - pnpm --filter werkmeister-core test
  row cli-vitest - sh -c 'cd apps/cli && pnpm exec vitest run'
  row cli-bdd - sh -c 'cd apps/cli && pnpm exec vitest run -c bdd/vitest.config.ts'
  row mcp-test - pnpm --filter werkmeister-mcp test
  row plugin-validate - sh -c 'cd plugins/werkmeister && claude plugin validate .'
  row plugin-test - sh -c 'cd plugins/werkmeister && claude plugin test .'
  row plugin-install-check - sh -c 'cd plugins/werkmeister && node --test skills/install-check/*.test.mjs'
  ;;
core)
  pnpm turbo run build --filter=werkmeister-core >"$dir/logs/build.log" 2>&1 || { echo "measure-test-cpu: build failed, see $dir/logs/build.log" >&2; exit 1; }
  cd packages/werkmeister-core || exit 1
  export WERKMEISTER_GH_BIN="$PWD/test/no-gh.sh"
  unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR
  for f in test/*.test.mjs; do row core "$f" node --test "$f"; done
  for f in test/*.smoke.mjs; do row core-smoke "$f" node "$f"; done
  ;;
cli)
  pnpm turbo run build --filter=werkmeister >"$dir/logs/build.log" 2>&1 || { echo "measure-test-cpu: build failed, see $dir/logs/build.log" >&2; exit 1; }
  cd apps/cli || exit 1
  row cli-baseline "(vitest, no files)" pnpm exec vitest run --passWithNoTests __none__
  for f in $(find src -name '*.test.ts' | sort); do row cli "$f" pnpm exec vitest run "$f"; done
  row cli-bdd bdd pnpm exec vitest run -c bdd/vitest.config.ts
  ;;
esac

{
  awk -F'\t' 'NR > 1 { r++; if ($3 != 0) f++; c += $5; o += $6 } END {
    printf "rows %d\nfailed %d\ncpu_s %.1f\nothers_cpu_s %.1f\n", r, f, c, o }' "$tsv"
  printf 'waited_s %s\nbusy_before %s\nload_before %s\nload_after %s\n' \
    "${MTC_WAITED:-0}" "${MTC_BUSY:-}" "${MTC_LOAD:-}" "$(cut -d' ' -f1-3 /proc/loadavg | tr ' ' /)"
} | tee "$dir/totals.txt"
grep -qx 'failed 0' "$dir/totals.txt"
