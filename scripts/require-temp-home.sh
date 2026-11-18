#!/bin/sh
# A test entry's first step (SW-662): refuse to run against a HOME that holds the real ~/.werkmeister,
# as a workspace container's does (mounted read-write). with-temp-home sets TMPDIR to its temp HOME
# (SW-799), so HOME = TMPDIR only under it, whatever its version; CI's HOME has no ~/.werkmeister.
[ ! -e "${HOME:-}/.werkmeister" ] || [ "$HOME" = "${TMPDIR:-}" ] || {
  echo "tests: HOME ($HOME) holds the real ~/.werkmeister, which the tests would write: run them through <workspace>/.werkmeister/bin/with-temp-home" >&2
  exit 1
}
