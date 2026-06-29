# 9router-proxy

OpenAI-compatible reverse proxy. Sits between clients and 9router. Mutates request bodies before forwarding.

## What it does

- Proxies all requests to `TARGET_URL` (default: `http://localhost:20128`)
- Strips segments from system prompt messages via `strip.json`
- Injects text around first user message via `inject.json`
- Rules loaded dynamically on each request (no restart needed)

## Stack

- **Runtime**: Bun
- **No framework** — `Bun.serve` only
- **No dependencies** beyond `@types/bun`

## Entry point

`index.ts` — single file, ~161 lines

## Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `20128` | Listen port |
| `TARGET_URL` | `http://localhost:20128` | Upstream |
| `VERBOSE_LOG` | `false` | Full req/res logging |
| `MAX_TIMEOUT` | `600` (sec) | Upstream timeout |

## Config files (hot-reloaded)

`strip.json` — array of strip rules:
```json
[{ "desc": "...", "startsWith": "...", "endsWith": "..." }]
```
Strips content between `startsWith` and `endsWith` in system messages.

`inject.json` — wrap first user message:
```json
{ "start": "...", "end": "..." }
```

## Docker

```bash
# Build + push
IMAGE=ghcr.io/firmantr3/9router-proxy:latest ./build.sh

# Run via compose (includes 9router, open-webui, omniroute, qdrant)
docker compose up -d
```

Proxy port default: `20131` (env `PROXY_PORT`).

Volumes mount `strip.json` and `inject.json` from `/home/firman/.9router/` as read-only.

## Dev

```bash
bun run index.ts
```

## Editing rules

- Keep single-file (`index.ts`). No new files unless absolutely necessary.
- Dynamic rule loading is intentional — never cache `strip.json`/`inject.json`.
- `ponytail:` comments mark deliberate simplifications.
