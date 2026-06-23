# 9router-proxy

A lightweight proxy/middleware built with Bun to alter and debug prompts sent to 9router.

## Usage

Start the proxy:

```bash
bun start
```

It will listen on `http://localhost:20128` and forward all requests to `http://192.168.0.203:20128`. All incoming JSON payloads (including prompts) will be logged to the console.

## Recommendations

- It is recommended to use **Kilo Code** (VS Code extension/version).
- Use or refer to [kilo.jsonc](file:///Users/firman/dev/lab/9router-proxy/kilo/kilo.jsonc) for an orchestrator example.
- Set the API key in the Kilo providers GUI for the first time, and adjust your 9router models as needed.
