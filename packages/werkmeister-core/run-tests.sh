#!/bin/sh
# The one core-suite invocation: `pnpm test` and each CI shard (`pnpm test N/M`)
# go through here, so an env var or flag added below reaches both (SW-240).
# No argument runs everything; N/M runs that shard, and the smokes ride the last one.
# A list of .mjs files (from `pnpm run test:changed`) runs only those tests and smokes.
set -e
cd "$(dirname "$0")"
export WERKMEISTER_GH_BIN="$PWD/no-gh.sh"
# Started by a calling git (rebase --exec, a hook), these point every fixture `git init` at the real repo (SW-520).
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR
case "${1:-}" in
  *.mjs)
    shard=
    tests=
    smokes=
    for f in "$@"; do
      case "$f" in *.smoke.mjs) smokes="$smokes $f" ;; *) tests="$tests $f" ;; esac
    done
    ;;
  *)
    shard=${1:-}
    tests=$(echo *.test.mjs)
    smokes=$(echo *.smoke.mjs)
    ;;
esac
# The container's CPU limit (cgroup-aware), at most 4 so a dev host isn't flooded; SW-101's fixed 2 fit a 1-CPU container (SW-406).
# Guarded: `node --test` with no file runs its own default glob.
# shellcheck disable=SC2086 # test file names have no spaces
[ -z "$tests" ] || node --test --test-concurrency="$(node -p 'Math.min(os.availableParallelism(), 4)')" ${shard:+--test-shard="$shard"} $tests
if [ -z "$shard" ] || [ "${shard%/*}" = "${shard#*/}" ]; then
  for f in $smokes; do node "$f"; done
fi
