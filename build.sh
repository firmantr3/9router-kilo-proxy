#!/usr/bin/env bash
set -euo pipefail

IMAGE=${IMAGE:-ghcr.io/firmantr3/9router-proxy:latest}

docker build -t "$IMAGE" .
docker push "$IMAGE"

echo "---"
echo "Done: $IMAGE"
echo ""
echo "Then in docker-compose.yml change:"
echo "  build: .  -->  image: $IMAGE"
