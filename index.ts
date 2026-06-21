// ponytail: Using Bun.serve directly avoids any third-party framework/dependencies like Elysia or Express.
import { join } from "path";

const PORT = Number(process.env.PORT) || 20128;
const TARGET_URL = process.env.TARGET_URL || 'http://192.168.0.203:20128';

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const targetUrl = new URL(url.pathname + url.search, TARGET_URL);

    let bodyText = '';
    let bodyToForward: BodyInit | null = null;

    if (req.body) {
      bodyText = await req.text();
      
      // Load stripping rules dynamically
      try {
        const stripRulesPath = join(import.meta.dir, "strip.json");
        const stripRulesFile = Bun.file(stripRulesPath);
        if (await stripRulesFile.exists()) {
          const rules = await stripRulesFile.json();
          const parsed = JSON.parse(bodyText);
          
          if (parsed && Array.isArray(parsed.messages)) {
            let modified = false;
            for (const msg of parsed.messages) {
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
            if (modified) {
              bodyText = JSON.stringify(parsed);
            }
          }
        }
      } catch (err) {
        console.error("Error processing strip rules:", err);
      }

      bodyToForward = bodyText;
    }

    console.log(`\n=== [${new Date().toISOString()}] ${req.method} ${url.pathname}${url.search} ===`);
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText);
        console.log("Request JSON:");
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log("Raw Request Body:");
        console.log(bodyText);
      }
    }

    const headers = new Headers(req.headers);
    headers.delete('host');

    try {
      const response = await fetch(targetUrl.toString(), {
        method: req.method,
        headers,
        body: bodyToForward,
        redirect: 'manual',
      });

      console.log(`Response Status: ${response.status}`);
      return response;
    } catch (error: any) {
      console.error("Proxy Error:", error);
      return new Response(`Proxy Error: ${error.message}`, { status: 502 });
    }
  },
});

console.log(`Proxy serving on http://localhost:${PORT} -> proxying to ${TARGET_URL}`);

