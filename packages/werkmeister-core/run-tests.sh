#!/bin/sh
# The one core-suite invocation: `pnpm test` and each CI shard (`pnpm test N/M`)
# go through here, so an env var or flag added below reaches both (SW-240).
# No argument runs everything; N/M runs that shard, and the smokes ride the last one.
set -e
cd "$(dirname "$0")"
export WERKMEISTER_GH_BIN="$PWD/no-gh.sh"
shard=${1:-}
node --test --test-concurrency=2 ${shard:+--test-shard="$shard"} *.test.mjs
if [ -z "$shard" ] || [ "${shard%/*}" = "${shard#*/}" ]; then
  for f in *.smoke.mjs; do node "$f"; done
fi
