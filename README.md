# 9router-proxy

A lightweight Bun proxy that sits in front of [9router](https://github.com/decolua/9router), logging all requests and mutating JSON payloads on the fly — stripping unwanted system prompt segments and injecting custom directives before forwarding.

## How it works

```text
Client (Kilo / Open WebUI / curl)
    ↓
9router-proxy :20131   ← strips + injects + logs
    ↓
9router        :20128  ← model routing
    ↓
LLM provider
```

On every request the proxy:

1. Reads `strip.json` and removes matching substrings from `system` messages
2. Reads `inject.json` and prepends/appends text to the first `user` message
3. Logs the (post-mutation) request body to stdout
4. Forwards the request and streams the response back

Both rule files are read from disk on each request — edit them without restarting.

## Quick start

```bash
bun install
bun start
```

Listens on `http://localhost:20128`, proxies to `http://192.168.0.203:20128` by default.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `20128` | Port this proxy listens on |
| `TARGET_URL` | `http://192.168.0.203:20128` | Upstream 9router address |

## Rule files

### strip.json

Array of substring ranges to cut from `system` messages.

```json
[
  {
    "desc": "Remove Kilo System Prompt",
    "startsWith": "You are Kilo, ",
    "endsWith": " when the work you just did has not been committed yet.\n"
  }
]
```

Everything from `startsWith` up to and including `endsWith` is removed. Multiple rules are applied in order. Missing file = no stripping.

**Why:** Kilo Code prepends its own template prompt before your defined agent prompt. This can conflict with custom agent instructions — stripping removes Kilo's boilerplate so only your prompt reaches the model.

### inject.json

Wraps the first `user` message (string or text part in a content array).

```json
{
  "start": "<directive>\nRead and comply with your complete system prompt.\n</directive>\n\n",
  "end": ""
}
```

Missing file = no injection.

**Why:** Less capable models sometimes ignore or skip the system prompt. Injecting a directive into the user message acts as a reminder that the model can't overlook.

## Docker

```bash
# Build
./build.sh

# Or pull and run with the full stack (9router + Open WebUI + omniroute + proxy)
docker compose up -d
```

The proxy container mounts `strip.json` and `inject.json` as read-only volumes so you can edit rules on the host without rebuilding.

Key ports from `docker-compose.yml`:

| Service | Port |
| --- | --- |
| 9router | `20128` (or `$ROUTER_PORT`) |
| Open WebUI | `20129` (or `$WEBUI_PORT`) |
| omniroute | `20130` (or `$OMNIROUTE_PORT`) |
| **9router-proxy** | `20131` (or `$PROXY_PORT`) |

Point your AI client at port `20131` to go through the proxy.

## Kilo Code integration

`kilo/kilo.jsonc` contains a ready-to-use Kilo Code configuration with four agents:

| Agent | Role |
| --- | --- |
| `code-orchestrator` | Primary — plans, delegates, never writes code |
| `code-executor` | Subagent — implements exactly what the orchestrator specifies |
| `code-reviewer` / `code-reviewer-low` | Subagents — structured code review |
| `code-audit` | Subagent — per-category audit (correctness, security, perf, etc.) |
| `tdd-orchestrator` | Primary — TDD-first variant with improve + review loops |

**Why a global `kilo.jsonc`?** It ships a ready-made code-orchestrator preset — the orchestrator/executor/reviewer/audit agent set above — so every project gets the same delegation workflow without re-defining agents each time.

Install it as your user-level Kilo config (create the directory if missing):

| OS | Path |
| --- | --- |
| macOS / Linux | `~/.config/kilo/kilo.jsonc` |
| Windows | `%USERPROFILE%\.config\kilo\kilo.jsonc` |

```bash
# macOS / Linux
mkdir -p ~/.config/kilo && cp kilo/kilo.jsonc ~/.config/kilo/kilo.jsonc
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\kilo" | Out-Null
Copy-Item kilo\kilo.jsonc "$env:USERPROFILE\.config\kilo\kilo.jsonc"
```

Or copy it to a single project's `.kilo/kilo.jsonc` instead (merge into an existing one if you have it).

> **Required skills** — the agent prompts invoke `/caveman-review` and `/improve`. Install both before use:
>
> - [`caveman`](https://claude.ai/skills/caveman) — terse code review comments
> - [`improve`](https://claude.ai/skills/improve) — code audit by shadcn
>
> In Kilo, skills are loaded from the paths defined in `kilo.jsonc → skills.paths` (default: `~/.agents/skills`).

Set your API base URL to `http://localhost:20131/v1` in Kilo's 9router provider settings so requests flow through the proxy.
