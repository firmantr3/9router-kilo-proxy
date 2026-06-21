# 9router-proxy

A lightweight proxy/middleware built with Bun to debug prompts sent to 9router.

## Usage

Start the proxy:
```bash
bun start
```

It will listen on `http://localhost:20128` and forward all requests to `http://192.168.0.203:20128`. All incoming JSON payloads (including prompts) will be logged to the console.
