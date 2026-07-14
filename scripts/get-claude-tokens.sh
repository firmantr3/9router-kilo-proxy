#!/bin/bash
# Extract Claude OAuth tokens from 9router container DB
# Usage: ./get-claude-tokens.sh

SNAPSHOT=$(mktemp /tmp/9router-snapshot-XXXXXX.sqlite)

echo "📦 Copying DB from container..."
docker compose cp 9router:/app/data/db/data.sqlite "$SNAPSHOT"

echo ""
echo "🔑 Claude OAuth connections:"
echo "---"
sqlite3 "$SNAPSHOT" "
  SELECT
    id,
    name,
    email,
    json_extract(data, '$.accessToken') AS accessToken,
    json_extract(data, '$.refreshToken') AS refreshToken,
    json_extract(data, '$.expiresAt') AS expiresAt
  FROM providerConnections
  WHERE provider='claude' OR provider='anthropic';
" --separator $'\n' 2>/dev/null || \
sqlite3 "$SNAPSHOT" "SELECT id, name, email, data FROM providerConnections WHERE provider='claude' OR provider='anthropic';"

rm -f "$SNAPSHOT"
echo ""
echo "✅ Done"
