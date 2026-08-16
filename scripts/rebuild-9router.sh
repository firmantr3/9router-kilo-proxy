#!/usr/bin/env bash
set -euo pipefail

# Navigate to project root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "🔨 Rebuilding 9router image..."
echo "=========================================="

# Build 9router image (using --no-cache to ensure latest npm package is fetched)
docker compose build --no-cache --pull 9router "$@"

echo ""
echo "=========================================="
echo "🔄 Recreating 9router container..."
echo "=========================================="

# Recreate and start 9router container in background
docker compose up -d --force-recreate --no-deps 9router

echo ""
echo "=========================================="
echo "✅ 9router container status:"
echo "=========================================="
docker compose ps 9router
