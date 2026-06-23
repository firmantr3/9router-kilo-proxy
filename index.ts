// ponytail: Using Bun.serve directly avoids any third-party framework/dependencies like Elysia or Express.
import { join } from "path";

const PORT = Number(process.env.PORT) || 20128;
const TARGET_URL = process.env.TARGET_URL || 'http://192.168.0.203:20128';
const VERBOSE_LOG = process.env.VERBOSE_LOG === 'true';

Bun.serve({
  port: PORT,
  async fetch(req, server) {
    server.timeout(req, 0);
    const url = new URL(req.url);
    const targetUrl = new URL(url.pathname + url.search, TARGET_URL);

    let bodyText = '';
    let bodyToForward: BodyInit | null = null;

    if (req.body) {
      bodyText = await req.text();
      
      // Load rules dynamically
      try {
        let parsed: Record<string, unknown> | null = null;
        let modified = false;

        const getParsed = () => {
          if (!parsed) {
            parsed = JSON.parse(bodyText);
          }
          return parsed;
        };

        // Load stripping rules dynamically
        const stripRulesPath = join(import.meta.dir, "strip.json");
        const stripRulesFile = Bun.file(stripRulesPath);
        if (await stripRulesFile.exists()) {
          const rules = await stripRulesFile.json();
          const p = getParsed();
          if (p && Array.isArray(p.messages)) {
            for (const msg of p.messages) {
              if (msg.role === "system" && typeof msg.content === "string") {
                for (const rule of rules) {
                  const startIdx = msg.content.indexOf(rule.startsWith);
                  if (startIdx !== -1) {
                    const endIdx = msg.content.indexOf(rule.endsWith, startIdx + rule.startsWith.length);
                    if (endIdx !== -1) {
                      msg.content = msg.content.slice(0, startIdx) + msg.content.slice(endIdx + rule.endsWith.length);
                      modified = true;
                    }
                  }
                }
              }
            }
          }
        }

        // Load inject rules dynamically
        const injectRulesPath = join(import.meta.dir, "inject.json");
        const injectRulesFile = Bun.file(injectRulesPath);
        if (await injectRulesFile.exists()) {
          const injectRule = await injectRulesFile.json();
          const p = getParsed();
          if (p && Array.isArray(p.messages)) {
            const firstUserMsg = p.messages.find((msg: any) => msg.role === "user");
            if (firstUserMsg) {
              const start = injectRule.start || "";
              const end = injectRule.end || "";
              if (typeof firstUserMsg.content === "string") {
                firstUserMsg.content = start + firstUserMsg.content + end;
                modified = true;
              } else if (Array.isArray(firstUserMsg.content)) {
                const firstTextPart = firstUserMsg.content.find((part: any) => part.type === "text");
                if (firstTextPart && typeof firstTextPart.text === "string") {
                  firstTextPart.text = start + firstTextPart.text + end;
                  modified = true;
                }
              }
            }
          }
        }

        if (modified) {
          bodyText = JSON.stringify(parsed);
        }
      } catch (err) {
        console.error("Error processing body rules:", err);
      }

      bodyToForward = bodyText;
    }

    if (VERBOSE_LOG) {
      console.log(`\n=== [${new Date().toISOString()}] ${req.method} ${url.pathname}${url.search} ===`);
      if (bodyText) {
        console.log("Request JSON:");
        try {
          const logParsed = JSON.parse(bodyText);
          console.log(JSON.stringify(logParsed, null, 2));
        } catch {
          console.log("Raw Request Body:");
          console.log(bodyText);
        }
      }
    }

    const headers = new Headers(req.headers);
    headers.delete('host');
    headers.delete('content-length');
    headers.delete('x-forwarded-for');
    headers.delete('x-forwarded-host');
    headers.delete('x-real-ip');
    headers.delete('transfer-encoding');

    try {
      const response = await fetch(targetUrl.toString(), {
        method: req.method,
        headers,
        body: bodyToForward,
        redirect: 'manual',
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(120_000)]),
      });

      if (VERBOSE_LOG) {
        console.log(`Response Status: ${response.status}`);
      } else {
        console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}${url.search} -> ${response.status}`);
      }
      return response;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        const cause = error.cause?.name || 'unknown';
        console.error(`[${new Date().toISOString()}] Upstream aborted (cause: ${cause})`);
        return new Response('Upstream timeout or client disconnected', { status: 504 });
      }
      console.error("Proxy Error:", error);
      return new Response(`Proxy Error: ${error.message}`, { status: 502 });
    }
  },
});

console.log(`Proxy serving on http://localhost:${PORT} -> proxying to ${TARGET_URL}`);

