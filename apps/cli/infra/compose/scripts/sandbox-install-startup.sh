#!/bin/sh
# Installs the host-facing CLIs the sandbox repo's own services need into the
# per-feature `tools` volume mounted at /opt/sandbox-tools. Runs from the
# sandbox-install setup container (services.yaml `startup_script: true`).
# Idempotent: each download is skipped when its binary already exists, so a
# re-up of the same feature costs nothing.
set -eu

TOOLS=/opt/sandbox-tools
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
