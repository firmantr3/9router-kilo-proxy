// ponytail: Using Bun.serve directly avoids any third-party framework/dependencies like Elysia or Express.
import crypto from "node:crypto";
import { join } from "path";

const PORT = Number(process.env.PORT) || 20128;
const TARGET_URL = process.env.TARGET_URL || "http://localhost:20128";
const VERBOSE_LOG = process.env.VERBOSE_LOG === "true";
const MAX_TIMEOUT = Number(process.env.MAX_TIMEOUT) * 1000 || 600_000;

export type StripRule = {
  desc?: string;
  startsWith: string;
  endsWith: string;
};

export type InjectRule = {
  start_system?: string;
  end_system?: string;
  start?: string;
  end?: string;
  only_when_string_exists?: string;
};

export type InjectConfig = InjectRule | InjectRule[];

export type ChatMessage = {
  role?: unknown;
  content?: unknown;
};

type ContentPart = {
  type?: unknown;
  text?: unknown;
};

// --- Pool / sticky session state ---
type PoolMap = Record<string, string[]>;
const SESSION_TTL_MS = 45_000;
const modelLoad = new Map<string, number>();
const activeSessions = new Map<string, { model: string; pool: string; lastActive: number }>();

async function loadPools(dir: string = import.meta.dir): Promise<PoolMap> {
  try {
    const f = Bun.file(join(dir, "pools.json"));
    const j = await f.json();
    return j && typeof j === "object" ? (j as PoolMap) : {};
  } catch {
    return {};
  }
}

function systemText(body: Record<string, unknown>): string {
  if (Array.isArray(body.system)) {
    return (body.system as Array<{ text?: string }>)
      .map((p) => p?.text ?? "")
      .join("\n");
  }
  const msgs = body.messages as Array<{ role?: string; content?: unknown }> | undefined;
  const sys = msgs?.find((m) => m?.role === "system");
  if (typeof sys?.content === "string") return sys.content;
  if (Array.isArray(sys?.content))
    return (sys.content as Array<{ text?: string }>).map((p) => p?.text ?? "").join("\n");
  return "";
}

function firstUserText(body: Record<string, unknown>): string {
  const msgs = body.messages as Array<{ role?: string; content?: unknown }> | undefined;
  const u = msgs?.find((m) => m?.role === "user");
  if (!u) return "";
  if (typeof u.content === "string") return u.content;
  if (Array.isArray(u.content))
    return (u.content as Array<{ text?: string }>).map((p) => p?.text ?? "").join("\n");
  return "";
}

function resolveSessionId(req: Request, body: Record<string, unknown>): string {
  const hdr =
    req.headers.get("x-subagent-id") ??
    req.headers.get("x-agent-id") ??
    req.headers.get("x-session-id");
  if (hdr) return hdr;
  const seed = systemText(body) + "\x00" + firstUserText(body);
  if (seed.trim()) {
    return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
  }
  return crypto.randomUUID();
}

function acquireModel(sessionId: string, requested: string, pools: PoolMap): string {
  const existing = activeSessions.get(sessionId);
  if (existing) {
    existing.lastActive = Date.now();
    console.log(`[pool] reuse ${existing.model} -> session ${sessionId}`);
    return existing.model;
  }
  const pool = pools[requested];
  if (!pool) {
    console.log(`[pool] no pool for "${requested}" -> passthrough`);
    return requested;
  }
  const idle = pool.find((m) => (modelLoad.get(m) ?? 0) === 0);
  if (idle) {
    modelLoad.set(idle, 1);
    activeSessions.set(sessionId, { model: idle, pool: requested, lastActive: Date.now() });
    console.log(`[pool] lock ${idle} -> session ${sessionId}`);
    return idle;
  }
  // All busy — pick least-loaded
  let best = pool[0];
  let bestLoad = modelLoad.get(best) ?? 0;
  for (let i = 1; i < pool.length; i++) {
    const load = modelLoad.get(pool[i]) ?? 0;
    if (load < bestLoad) { best = pool[i]; bestLoad = load; }
  }
  modelLoad.set(best, bestLoad + 1);
  activeSessions.set(sessionId, { model: best, pool: requested, lastActive: Date.now() });
  console.log(`[pool] all busy for "${requested}", least-loaded: ${best} (load ${bestLoad})`);
  return best;
}

function releaseSession(sessionId: string, reason: string): void {
  const s = activeSessions.get(sessionId);
  if (!s) return;
  const load = (modelLoad.get(s.model) ?? 1) - 1;
  if (load <= 0) modelLoad.delete(s.model); else modelLoad.set(s.model, load);
  activeSessions.delete(sessionId);
  console.log(`[pool] release ${s.model} <- session ${sessionId} (${reason})`);
}

// ponytail: single-host only. Multi-instance needs external store (Redis).
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of activeSessions) {
    if (now - s.lastActive > SESSION_TTL_MS) releaseSession(id, "ttl");
  }
}, 5_000);
// --- End pool / sticky session state ---

export async function loadStripRules(dir: string = import.meta.dir): Promise<StripRule[]> {
  const file = Bun.file(join(dir, "strip.json"));
  if (!(await file.exists())) return [];
  const rules = await file.json();
  return Array.isArray(rules) ? (rules as StripRule[]) : [];
}

export async function loadInjectRule(dir: string = import.meta.dir): Promise<InjectConfig | null> {
  const file = Bun.file(join(dir, "inject.json"));
  if (!(await file.exists())) return null;
  const rule = await file.json();
  if (rule && typeof rule === "object") return rule as InjectConfig;
  return null;
}

// Strip content between startsWith/endsWith in system messages. Mutates in place.
export function applyStripRules(messages: ChatMessage[], rules: StripRule[]): boolean {
  let modified = false;
  for (const msg of messages) {
    if (msg.role !== "system" || typeof msg.content !== "string") continue;
    let content = msg.content;
    for (const rule of rules) {
      const s = rule.startsWith;
      const e = rule.endsWith;
      if (!s || !e) continue; // degenerate rule — skip
      const startIdx = content.indexOf(s);
      if (startIdx === -1) continue;
      const endIdx = content.indexOf(e, startIdx + s.length);
      if (endIdx === -1) continue;
      content = content.slice(0, startIdx) + content.slice(endIdx + e.length);
      modified = true;
      if (VERBOSE_LOG) console.log(`[strip] Applied rule: ${rule.desc || s}`);
    }
    msg.content = content;
  }
  return modified;
}

// Inject wrappers into system messages and the first user message. Mutates in place.
// Apply a single inject rule. `onlyWhen` (pre-strip snapshot) gates injection:
// active only if that string appears somewhere in the original body.
function applyOneInjectRule(
  messages: ChatMessage[],
  rule: InjectRule,
  onlyWhen: string,
): boolean {
  let modified = false;

  const gate = rule.only_when_string_exists ?? "";
  if (gate && !onlyWhen.includes(gate)) return false;

  const startSys = rule.start_system ?? "";
  const endSys = rule.end_system ?? "";
  if (startSys || endSys) {
    for (const msg of messages) {
      if (msg.role !== "system" || typeof msg.content !== "string") continue;
      msg.content = startSys + msg.content + endSys;
      modified = true;
      if (VERBOSE_LOG) console.log("[inject] Applied system injection");
    }
  }

  const firstUser = messages.find((m) => m.role === "user");
  if (firstUser) {
    const start = rule.start ?? "";
    const end = rule.end ?? "";
    if (start || end) {
      if (typeof firstUser.content === "string") {
        firstUser.content = start + firstUser.content + end;
        modified = true;
        if (VERBOSE_LOG) console.log("[inject] Wrapped first user message");
      } else if (Array.isArray(firstUser.content)) {
        const firstText = firstUser.content.find(
          (p): p is ContentPart & { text: string } =>
            !!p &&
            typeof p === "object" &&
            (p as ContentPart).type === "text" &&
            typeof (p as ContentPart).text === "string",
        );
        if (firstText) {
          firstText.text = start + firstText.text + end;
          modified = true;
          if (VERBOSE_LOG) console.log("[inject] Wrapped first user message (array content)");
        }
      }
    }
  }

  return modified;
}

// Apply one or many inject rules (array form supported). Mutates in place.
export function applyInjectRules(
  messages: ChatMessage[],
  config: InjectConfig,
  onlyWhen?: string,
): boolean {
  const rules = Array.isArray(config) ? config : [config];
  const snapshot = onlyWhen ?? "";
  let modified = false;
  for (const rule of rules) {
    if (rule && typeof rule === "object") {
      modified = applyOneInjectRule(messages, rule, snapshot) || modified;
    }
  }
  return modified;
}

// Full body transform. Returns the modified JSON string, or null if the body
// is not JSON / has no messages / no rules matched.
export async function processBody(
  bodyText: string,
  dir: string = import.meta.dir,
): Promise<string | null> {
  if (!bodyText.startsWith("{")) return null; // only object bodies are rule targets
  let parsed: { messages?: unknown };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.messages)) return null;

  const messages = parsed.messages as ChatMessage[];
  const stripRules = await loadStripRules(dir);
  const injectRule = await loadInjectRule(dir);

  // ponytail: snapshot full body before strip so only_when_string_exists
  // can gate on pre-strip content.
  const preStripSnapshot = JSON.stringify(parsed);

  let modified = false;
  if (stripRules.length) modified = applyStripRules(messages, stripRules) || modified;
  if (injectRule)
    modified = applyInjectRules(messages, injectRule, preStripSnapshot) || modified;

  return modified ? JSON.stringify(parsed) : null;
}

if (import.meta.main) {
  await printStartupStatus();

  Bun.serve({
    port: PORT,
    async fetch(req, server) {
      server.timeout(req, 0);
      const url = new URL(req.url);
      const targetUrl = new URL(url.pathname + url.search, TARGET_URL);

      let bodyToForward: string | null = null;
      let sessionId: string | null = null;

      if (req.body) {
        const bodyText = await req.text();

        // Resolve session from original body BEFORE strip/inject mutates it
        if (bodyText.startsWith("{")) {
          try {
            const raw = JSON.parse(bodyText) as Record<string, unknown>;
            if (raw?.model) {
              const pools = await loadPools();
              if (Object.keys(pools).length > 0) {
                sessionId = resolveSessionId(req, raw);
              }
            }
          } catch {
            // not JSON — pass through
          }
        }

        const processed = await processBody(bodyText);
        bodyToForward = processed !== null ? processed : bodyText;
      }

      // --- Pool / sticky session rewrite ---
      if (sessionId && bodyToForward && bodyToForward.startsWith("{")) {
        try {
          const parsed = JSON.parse(bodyToForward) as Record<string, unknown>;
          if (parsed?.model) {
            const pools = await loadPools();
            parsed.model = acquireModel(sessionId, parsed.model as string, pools);
            bodyToForward = JSON.stringify(parsed);
          }
        } catch {
          // not JSON or no model — pass through untouched
        }
      }
      // --- End pool / sticky session rewrite ---

      if (sessionId) {
        req.signal.addEventListener("abort", () => releaseSession(sessionId!, "disconnect"), { once: true });
      }

      if (VERBOSE_LOG) {
        console.log(
          `\n=== [${new Date().toISOString()}] ${req.method} ${url.pathname}${url.search} ===`,
        );
        if (bodyToForward && typeof bodyToForward === "string") {
          console.log("Request JSON:");
          try {
            const logParsed = JSON.parse(bodyToForward);
            console.log(JSON.stringify(logParsed, null, 2));
          } catch {
            console.log("Raw Request Body:");
            console.log(bodyToForward);
          }
        }
      }

      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("content-length");
      headers.delete("x-forwarded-for");
      headers.delete("x-forwarded-host");
      headers.delete("x-real-ip");
      headers.delete("transfer-encoding");
      // ponytail: identity is avoided — some upstreams mishandle it.
      // Fix is to strip Content-Encoding from response instead.

      try {
        const response = await fetch(targetUrl.toString(), {
          method: req.method,
          headers,
          body: bodyToForward,
          redirect: "manual",
          signal: AbortSignal.any([req.signal, AbortSignal.timeout(MAX_TIMEOUT)]),
        });

        if (VERBOSE_LOG) {
          console.log(`Response Status: ${response.status}`);
        } else {
          console.log(
            `${new Date().toISOString()} ${req.method} ${url.pathname}${url.search} -> ${response.status}`,
          );
        }
        const resHeaders = new Headers(response.headers);
        // Strip Content-Encoding for codecs Bun auto-decompresses on fetch (gzip, deflate, br).
        // Forwarding the stale header would trick client into double-inflate (ZlibError).
        // Leave unknown encodings (e.g. zstd) intact — Bun doesn't inflate those.
        const ce = resHeaders.get("content-encoding");
        if (ce && /gzip|deflate|br|brotli/i.test(ce)) resHeaders.delete("content-encoding");
        // Content-Length from upstream is compressed size; body is now decompressed.
        // Transfer-Encoding is stale — new Response(body) sets its own framing.
        resHeaders.delete("content-length");
        resHeaders.delete("transfer-encoding");
        // --- Stream wrap for pool release on abnormal termination only ---
        if (sessionId && response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const tail: string[] = [];
          const wrapped = new ReadableStream({
            async pull(controller) {
              const { value, done } = await reader.read();
              if (done) {
                // Normal completion — session stays sticky until TTL or next abnormal event
                controller.close();
                return;
              }
              tail.push(decoder.decode(value, { stream: true }));
              if (tail.length > 8) tail.shift();
              controller.enqueue(value);
            },
            cancel() {
              releaseSession(sessionId!, "client-cancel");
            },
          });
          return new Response(wrapped, {
            status: response.status,
            statusText: response.statusText,
            headers: resHeaders,
          });
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: resHeaders,
        });
      } catch (error: unknown) {
        if (sessionId) releaseSession(sessionId, "error");
        const e = error as { name?: string; cause?: { name?: string }; message?: string };
        if (e.name === "AbortError") {
          const cause = e.cause?.name || "unknown";
          console.error(
            `[${new Date().toISOString()}] Upstream aborted (cause: ${cause})`,
          );
          return new Response("Upstream timeout or client disconnected", {
            status: 504,
          });
        }
        console.error("Proxy Error:", error);
        return new Response(`Proxy Error: ${e.message ?? "unknown"}`, { status: 502 });
      }
    },
  });

  console.log(
    `Proxy serving on http://localhost:${PORT} -> proxying to ${TARGET_URL}`,
  );
}

async function printStartupStatus(): Promise<void> {
  const stripRules = await loadStripRules();
  const injectRule = await loadInjectRule();

  console.log("=== 9router-proxy rule status ===");
  if (stripRules.length) {
    console.log(`Strip rules: ACTIVE (${stripRules.length})`);
    for (const r of stripRules) {
      console.log(`  - ${r.desc ?? "(no desc)"}`);
      console.log(`      startsWith: ${JSON.stringify(r.startsWith)}`);
      console.log(`      endsWith:   ${JSON.stringify(r.endsWith)}`);
    }
  } else {
    console.log("Strip rules: INACTIVE (no strip.json or empty)");
  }

  if (injectRule) {
    const rules = Array.isArray(injectRule) ? injectRule : [injectRule];
    console.log(`Inject: ACTIVE (${rules.length} rule${rules.length === 1 ? "" : "s"})`);
    rules.forEach((rule, i) => {
      const sysActive = Boolean(rule.start_system || rule.end_system);
      const userActive = Boolean(rule.start || rule.end);
      if (rules.length > 1) console.log(`  [${i}]`);
      console.log(`    system: ${sysActive ? "ACTIVE" : "inactive"}`);
      if (sysActive) {
        console.log(`      start_system: ${JSON.stringify(rule.start_system ?? "")}`);
        console.log(`      end_system:   ${JSON.stringify(rule.end_system ?? "")}`);
      }
      console.log(`    user:   ${userActive ? "ACTIVE" : "inactive"}`);
      if (userActive) {
        console.log(`      start: ${JSON.stringify(rule.start ?? "")}`);
        console.log(`      end:   ${JSON.stringify(rule.end ?? "")}`);
      }
      if (rule.only_when_string_exists) {
        console.log(
          `    only_when_string_exists: ${JSON.stringify(rule.only_when_string_exists)}`,
        );
      }
    });
  } else {
    console.log("Inject: INACTIVE (no inject.json)");
  }

  const pools = await loadPools();
  if (Object.keys(pools).length) {
    console.log(`Pools: ACTIVE (${Object.keys(pools).length})`);
    for (const [alias, models] of Object.entries(pools)) {
      console.log(`  ${alias}: ${models.join(", ")}`);
    }
  } else {
    console.log("Pools: INACTIVE (no pools.json)");
  }

  console.log("==================================");
}
