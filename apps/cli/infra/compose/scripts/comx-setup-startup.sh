#!/bin/bash
set -e

echo "--- COMX Setup ---"

echo "Setting up NX cache directory..."
mkdir -p /app/.nx/cache

[ ! -f /app/.env ] && touch /app/.env

echo "Installing dependencies (yarn install)..."
yarn install
echo "Dependencies installed."

echo "Running NX compilation (this may take several minutes)..."
export PRISMA_CLIENT_ENGINE_TYPE=binary
export PRISMA_CLI_QUERY_ENGINE_TYPE=binary
export HTTP_TIMEOUT=60000
export PRISMA_TELEMETRY_INFORMATION='comx-setup-build'
if ! yarn nx run-many --target=compile --parallel=1; then
  echo "NX compile failed — likely stale cache from a different container. Running 'nx reset' and retrying..."
  yarn nx reset
  yarn nx run-many --target=compile --parallel=1
fi
echo "Compilation complete."

touch /app/.nx/cache/.initialized
echo "--- COMX Setup Complete ---"
