#!/bin/bash
set -e

echo "--- Econx Setup ---"

echo "Setting up Turbo cache directory..."
mkdir -p /app/.turbo

[ ! -f /app/.env ] && touch /app/.env

echo "Installing dependencies (yarn install)..."
YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install
echo "Dependencies installed."

echo "--- Econx Setup Complete ---"
