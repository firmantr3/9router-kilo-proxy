// ponytail: Using Bun.serve directly avoids any third-party framework/dependencies like Elysia or Express.
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

      if (req.body) {
        const bodyText = await req.text();
        const processed = await processBody(bodyText);
        bodyToForward = processed !== null ? processed : bodyText;
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
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: resHeaders,
        });
      } catch (error: unknown) {
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
  console.log("==================================");
}
