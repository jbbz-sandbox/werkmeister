#!/bin/sh
# One cold gate row with its cost and the load around it (SW-790, from SW-751's measure.sh).
# Run in the service's container from the repo root, e.g.:
#   docker exec -w /app <feature>-werkmeister-core sh scripts/measure-row.sh -w <workspace path> -o <dir> [-l label] [-- cmd...]
# Writes <dir>/<label>/: row.log, summary.json (turbo --summarize), cpu-samples.txt (<s> <cores> every 5 s),
# totals.txt. Waits first while the VM is busier than ROW_LOAD_LIMIT cores (default 1.0), up to
# ROW_LOAD_WAIT s (default 600), then exits 75 without measuring. scripts/ab-row.sh runs it per A/B side.
# shellcheck source-path=SCRIPTDIR
set -u
here=$(dirname "$0")
. "$here/row-lib.sh"
usage() {
  sed -n '2,7s/^# \{0,1\}//p' "$0" >&2
  exit 2
}
ws='' out='' label=run
while getopts w:o:l:h opt; do
  case $opt in
  w) ws=$OPTARG ;;
  o) out=$OPTARG ;;
  l) label=$OPTARG ;;
  *) usage ;;
  esac
done
shift $((OPTIND - 1))
[ -n "$ws" ] && [ -n "$out" ] || usage
wrap=$ws/.werkmeister/bin/with-temp-home
[ -x "$wrap" ] || { echo "measure-row: no $wrap; is -w the workspace folder?" >&2; exit 2; }
[ "$PWD" = /app ] && [ -f turbo.json ] || { echo "measure-row: run from /app in the container (docker exec -w /app)" >&2; exit 2; }
own_out measure-row
case $label in "" | .* | */*) echo "measure-row: -l takes a plain name, got '$label'" >&2; exit 2 ;; esac
[ "$#" -gt 0 ] || set -- pnpm turbo run typecheck test --continue --force --summarize \
  --filter=werkmeister --filter=werkmeister-mcp --filter=werkmeister-core --filter=werkmeister-plugin
dir=$out/$label

wait_quiet || exit $?
mkdir -p "$dir" || exit 1
load() { cut -d' ' -f1-3 /proc/loadavg | tr ' ' /; }
load_before=$(load)
v0=$(vm_cpu_usec)
c0=$(cgroup_usec)
rm -rf .turbo/runs
t0=$(date +%s.%N)
(
  prev=$c0
  while sleep 5; do
    now=$(cgroup_usec)
    awk -v t0="$t0" -v a="$prev" -v b="$now" -v t="$(date +%s.%N)" 'BEGIN { printf "%.0f %.2f\n", t - t0, (b - a) / 5e6 }'
    prev=$now
  done
) >"$dir/cpu-samples.txt" &
sampler=$!
trap 'kill "$sampler" 2>/dev/null' EXIT
trap 'exit 130' HUP INT TERM
# --no-wait: wait_quiet above already waited, on a signal wait-load doesn't read.
"$wrap" --no-wait "$@" >"$dir/row.log" 2>&1
rc=$?
t1=$(date +%s.%N)
c1=$(cgroup_usec)
v1=$(vm_cpu_usec)
load_after=$(load)
cp .turbo/runs/*.json "$dir/summary.json" 2>/dev/null
{
  awk -v l="$label" -v rc="$rc" -v t0="$t0" -v t1="$t1" -v c0="$c0" -v c1="$c1" -v v0="$v0" -v v1="$v1" 'BEGIN {
    printf "label %s\nexit %d\nwall_s %.1f\ncpu_s %.1f\nothers_cpu_s %.1f\n", l, rc, t1 - t0, (c1 - c0) / 1e6, ((v1 - v0) - (c1 - c0)) / 1e6 }'
  test_counts "$dir/row.log" | awk '{ print $1, $2; print $3, $4; print $5, $6 }'
  printf 'waited_s %s\nbusy_before %s\nload_before %s\nload_after %s\n' "$waited_s" "$busy_before" "$load_before" "$load_after"
} | tee "$dir/totals.txt"
exit "$rc"
