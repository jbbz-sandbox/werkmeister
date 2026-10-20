#!/bin/sh
# The sandbox repo's sandbox-install setup container (services.yaml
# `startup_script: true`). With `install`, it installs and builds the repo
# first; then it installs the host-facing CLIs the sandbox repo's own services
# need into the per-feature `tools` volume mounted at /opt/sandbox-tools.
# Idempotent: each download is skipped when its binary already exists, so a
# re-up of the same feature costs nothing.
#
# `install` is an argument, not the default, because this file comes from the
# main checkout while the command comes from ~/.sandbox/services.yaml: until
# `werkmeister registry` resyncs, the old `npm ci && npm run build && sh
# startup.sh` still calls this with no argument and must not install twice.
set -eu

TOOLS=${SANDBOX_TOOLS_DIR:-/opt/sandbox-tools}
LOCKS=${SANDBOX_INSTALL_LOCKS:-/locks}

# Hold one of SANDBOX_INSTALL_SLOTS host-wide lock files (the bind-mounted
# ~/.sandbox/locks) so workspaces starting together don't all run npm ci at
# once. The slot is held on fd 9 until npm ci finishes.
take_install_slot() {
  slots=${SANDBOX_INSTALL_SLOTS:-2}
  waiting=""
  while :; do
    i=1
    while [ "$i" -le "$slots" ]; do
      exec 9>"$LOCKS/install-$i"
      flock -n 9 && return
      i=$((i + 1))
    done
    if [ -z "$waiting" ]; then
      echo "sandbox-install: $slots installs already running on this host, waiting"
      waiting=1
    fi
    sleep 1
  done
}

# SW-33: npm ci wipes node_modules, so skip it while the lockfile and Node major
# match the stamp in the node_modules volume. The stamp is removed before and
# written only after a successful npm ci, so a failed install retries next up.
# The build always runs: turbo restores it from the shared TURBO_CACHE_DIR, and
# dist/ may be stale after a pull.
if [ "${1:-}" = install ]; then
  mkdir -p "$LOCKS"
  stamp=node_modules/.sandbox-install-hash
  want="$(cat package-lock.json pnpm-lock.yaml 2>/dev/null | sha256sum | cut -d' ' -f1) $(node -v | cut -d. -f1)"
  if [ "$(cat "$stamp" 2>/dev/null)" = "$want" ]; then
    echo "sandbox-install: lockfile and Node major unchanged, skipping npm ci"
  else
    take_install_slot
    rm -f "$stamp"
    npm ci
    echo "$want" >"$stamp"
    exec 9>&-
  fi
  # SW-35: one build at a time host-wide. turbo names its temp cache files by
  # pid, and identical install containers get identical pids, so two installs
  # of one commit could write the same temp file. Queued, the first builds and
  # the rest restore from the cache.
  flock "$LOCKS/turbo-build" npm run build
fi

DOCKER_VERSION=27.5.1
COMPOSE_VERSION=v2.32.4
KUBECTL_VERSION=v1.31.4

ARCH="$(uname -m)" # x86_64 | aarch64 — docker/compose name assets this way
case "$ARCH" in
  x86_64) KARCH=amd64 ;;
  aarch64) KARCH=arm64 ;;
  *) echo "sandbox-install: unsupported arch $ARCH" >&2; exit 1 ;;
esac

mkdir -p "$TOOLS/bin" "$TOOLS/docker/cli-plugins"

if [ ! -x "$TOOLS/bin/docker" ]; then
  curl -fsSL "https://download.docker.com/linux/static/stable/$ARCH/docker-$DOCKER_VERSION.tgz" \
    | tar -xz -C "$TOOLS/bin" --strip-components=1 docker/docker
fi

if [ ! -x "$TOOLS/docker/cli-plugins/docker-compose" ]; then
  curl -fsSL -o "$TOOLS/docker/cli-plugins/docker-compose" \
    "https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-$ARCH"
  chmod +x "$TOOLS/docker/cli-plugins/docker-compose"
fi

if [ ! -x "$TOOLS/bin/kubectl" ]; then
  curl -fsSL -o "$TOOLS/bin/kubectl" "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/$KARCH/kubectl"
  chmod +x "$TOOLS/bin/kubectl"
fi

"$TOOLS/bin/docker" --version
DOCKER_CONFIG="$TOOLS/docker" "$TOOLS/bin/docker" compose version
"$TOOLS/bin/kubectl" version --client
