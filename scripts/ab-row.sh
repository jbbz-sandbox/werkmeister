#!/bin/sh
# Before/after for a gate-speed change (SW-790, from SW-751's ab.sh): alternates cold rows on the base (A)
# and the branch (B), A1 B1 A2 B2 ..., so host load hits both sides alike, then prints each side's median.
# Run on the host from the workspace's repo worktree, with its werkmeister-core container up:
#   sh scripts/ab-row.sh -o <dir> [-n pairs (2)] [-b base (merge-base with origin/main)] [-c container] [-- cmd...]
# <dir> must be in the workspace folder (the container sees it at the same path) and outside the repo.
# B is the worktree as it is, committed or not; A reverse-applies `git diff --binary <base>`. HEAD never moves.
# Each run waits out load as measure-row.sh does (ROW_LOAD_LIMIT, ROW_LOAD_WAIT); a refusal stops the A/B, exit 75.
# A run whose others_cpu_s (other workspaces' CPU mid-row) is over ROW_OTHERS_LIMIT s (default 30) is rerun, up to
# ROW_OTHERS_TRIES attempts (default 2; 1 = never rerun): its ab.txt line gets "rerun: others <n> s", its files
# move to <label>.try<k>, and the medians use only the accepted run. When the attempts run out the last run is kept and flagged.
# Killing it puts the tree back on B, but docker exec passes no signal: the row in the container runs on
# until it ends (docker restart <container> stops it sooner).
# shellcheck source-path=SCRIPTDIR
set -u
die() {
  echo "ab-row: $*" >&2
  exit 1
}
usage() {
  sed -n '2,13s/^# \{0,1\}//p' "$0" >&2
  exit 2
}
here=$(cd "$(dirname "$0")" && pwd)
out='' n=2 base='' container=''
while getopts o:n:b:c:h opt; do
  case $opt in
  o) out=$OPTARG ;;
  n) n=$OPTARG ;;
  b) base=$OPTARG ;;
  c) container=$OPTARG ;;
  *) usage ;;
  esac
done
shift $((OPTIND - 1))
[ -n "$out" ] || usage
case $n in '' | *[!0-9]* | 0) die "-n takes a pair count, got '$n'" ;; esac
others_limit=${ROW_OTHERS_LIMIT:-30} tries=${ROW_OTHERS_TRIES:-2}
case $tries in '' | *[!0-9]* | 0) die "ROW_OTHERS_TRIES takes an attempt count, got '$tries'" ;; esac
# awk compares a non-number as text, so a typo would turn the rerun off silently (SW-824).
case $others_limit in '' | *[!0-9.]*) die "ROW_OTHERS_LIMIT takes seconds, got '$others_limit'" ;; esac

repo=$(git rev-parse --show-toplevel) || exit 1
repo=$(cd "$repo" && pwd -P)
ws=$(dirname "$repo")
while [ "$ws" != / ] && [ ! -f "$ws/.werkmeister/workspace.yml" ]; do ws=$(dirname "$ws"); done
[ "$ws" != / ] || die "no .werkmeister/workspace.yml above $repo"
# Containers are named after the workspace's feature, which can differ from its folder.
feature=$(awk '$1 == "feature:" { print $2; exit }' "$ws/.werkmeister/workspace.yml")
container=${container:-${feature:-$(basename "$ws")}-werkmeister-core}
[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" = true ] ||
  die "$container is not running; run werkmeister feature up --service werkmeister-core"
src=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app"}}{{.Source}}{{end}}{{end}}' "$container")
[ "$src" = "$repo" ] || die "$container mounts ${src:-nothing} at /app, not $repo"
p=$(cd "$(dirname "$out")" && pwd -P) || die "-o: no folder $(dirname "$out")"
out=$p/$(basename "$out")
case $out/ in "$repo"/*) die "-o $out is inside the repo, so it would change the diff being measured" ;; esac
case $out/ in "$ws"/*) ;; *) die "-o $out is outside $ws, so the container can't see it" ;; esac

mkdir -p "$out" && cd "$repo" || exit 1
base=${base:-$(git merge-base HEAD origin/main)} || die "no merge-base with origin/main; pass -b"
untracked=$(git ls-files --others --exclude-standard)
[ -z "$untracked" ] || die "untracked files are not in the diff: $(echo "$untracked" | tr "\n" " "); git add -N them or remove them"
patch=$out/branch.patch
git diff --binary "$base" >"$patch" || exit 1
[ -s "$patch" ] || die "no diff against $base to measure"
! grep -q '^diff --git a/pnpm-lock.yaml ' "$patch" || die "the diff changes pnpm-lock.yaml; each side would need its own install"
# The measurer runs from a copy, so a diff that touches these scripts can't change it between A and B.
mkdir -p "$out/bin" && cp "$here/measure-row.sh" "$here/row-lib.sh" "$out/bin/" || exit 1
. "$here/row-lib.sh"

on_a=0
restore() {
  [ "$on_a" = 0 ] || { git apply "$patch" && on_a=0; } || echo "ab-row: restore failed; apply $patch by hand" >&2
}
trap restore EXIT
trap 'exit 130' HUP INT TERM

: >"$out/ab.txt"
echo "ab-row: base $(git rev-parse --short "$base"), $n pairs, $container" | tee -a "$out/ab.txt"
run() { # <label> [cmd...]
  label=$1
  shift
  k=1
  while :; do
    docker exec -w /app "$container" sh "$out/bin/measure-row.sh" -w "$ws" -o "$out" -l "$label" -- "$@" >/dev/null
    rc=$?
    [ "$rc" -ne 75 ] || { echo "ab-row: $label refused, VM busy; stopping" | tee -a "$out/ab.txt"; exit 75; }
    [ -s "$out/$label/totals.txt" ] || die "$label wrote no totals (exit $rc)"
    others=$(awk '$1 == "others_cpu_s" { print $2 }' "$out/$label/totals.txt")
    others=${others:-0}
    note=''
    if gt "$others" "$others_limit"; then
      if [ "$k" -lt "$tries" ]; then note=" rerun: others $others s"; else note=" flagged: others $others s over $others_limit s after $k tries"; fi
    fi
    awk -v note="$note" '{ v[$1] = $2 } END {
      printf "%s wall %s s cpu %s s others %s s busy_before %s load %s -> %s tests %s fail %s exit %s%s\n",
        v["label"], v["wall_s"], v["cpu_s"], v["others_cpu_s"], v["busy_before"], v["load_before"], v["load_after"], v["tests"], v["fail"], v["exit"], note }' \
      "$out/$label/totals.txt" | tee -a "$out/ab.txt"
    case $note in " rerun:"*) ;; *) break ;; esac
    # Keep the rejected run's files; the label is reused so the medians read only the accepted run.
    mv "$out/$label" "$out/$label.try$k" || die "could not keep $label's rejected run"
    k=$((k + 1))
  done
}
i=1
while [ "$i" -le "$n" ]; do
  git apply -R "$patch" || die "could not reverse-apply $patch"
  on_a=1
  run "A$i" "$@"
  git apply "$patch" || die "could not re-apply $patch"
  on_a=0
  run "B$i" "$@"
  i=$((i + 1))
done

side() { # <A|B> <key>: that key from every run of one side, one per line
  j=1
  while [ "$j" -le "$n" ]; do
    awk -v k="$2" '$1 == k { print $2 }' "$out/$1$j/totals.txt"
    j=$((j + 1))
  done
}
aw=$(side A wall_s | median) ac=$(side A cpu_s | median)
bw=$(side B wall_s | median) bc=$(side B cpu_s | median)
{
  echo "median A wall $aw s cpu $ac s"
  echo "median B wall $bw s cpu $bc s"
  awk -v aw="$aw" -v ac="$ac" -v bw="$bw" -v bc="$bc" 'BEGIN { printf "delta B-A wall %+.1f s cpu %+.1f s\n", bw - aw, bc - ac }'
} | tee -a "$out/ab.txt"
git diff --binary "$base" | cmp -s - "$patch" || die "patch lost; the tree no longer matches $patch: restore from it"
