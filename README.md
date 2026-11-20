# Hookrelay

[![CI](https://github.com/timmichael738/hookrelay/actions/workflows/ci.yml/badge.svg)](https://github.com/timmichael738/hookrelay/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

**Self-hosted webhook inspector and localhost tunnel.** Get a public URL for Stripe, GitHub or
Slack webhooks, watch requests arrive live in the browser, and pipe them straight into the
server running on your laptop. You can replay any captured request with one click.

```text
$ hookrelay listen 3000

hookrelay ● online

  Webhook URL   https://hooks.example.com/h/3f9a1c2b7d4e
  Forwarding to http://localhost:3000
  Inspector     https://hooks.example.com/e/3f9a1c2b7d4e#token=hr_…

12:04:31 POST   /stripe/events → 200 12ms
12:04:35 POST   /github?delivery=1 → 500 4ms
12:05:02 replay POST   /github?delivery=1 → 200 6ms
```

## How it works

```text
 Stripe / GitHub ──HTTPS──▶ ┌──────── relay server ────────┐ ──SSE──▶ browser inspector
                            │ capture (raw bytes, headers) │
                            │ store  (bounded, in-memory)  │
                            └──────────────┬───────────────┘
                                 WebSocket │ request/response frames, correlated by id
                                           ▼
                                   hookrelay CLI ──HTTP──▶ http://localhost:3000
```

1. A webhook hits `/h/<endpoint>/<any path>`. The relay captures method, path, query, headers and
   the **raw body bytes**, so signature verification (e.g. `Stripe-Signature`) still works.
2. If a CLI tunnel is connected, the request is sent down the WebSocket. The CLI delivers it to
   localhost, and the **real local response** (status, headers, body) goes back to the webhook
   sender. Otherwise the relay replies `200` and keeps the request for inspection.
3. The inspector UI subscribes over **Server-Sent Events** and updates live.

## Features

- **Any method, any content type.** Bodies are stored as base64, so binary payloads round-trip byte for byte.
- **Live inspector**: request list, headers, pretty-printed JSON and form bodies, delivery history.
- **Replay** any captured request to localhost through the tunnel.
- **Resilient CLI** that reconnects with exponential backoff. A newer session takes over an endpoint cleanly.
- **Real responses passed through.** Your local 500s show up as 500s to the sender, and a dead tunnel returns `502`/`504`.
- **Secure by default**
  - Each endpoint has a secret token. The server stores only its SHA-256 and compares it in constant time.
  - The inspector puts the token in the **URL fragment** (`#token=`), which browsers never send to servers or proxy logs.
  - Replay goes through _your_ tunnel, so the server never makes requests to user-supplied URLs (**no SSRF**).
  - Hop-by-hop headers are stripped (RFC 9110), and request bodies have a size limit.
- **Bounded memory**: per-endpoint ring buffer, endpoint cap and idle-TTL sweeping.

## Quick start

```bash
npm install
npm run dev                         # relay server on http://localhost:4000
npm run cli -- listen 3000          # in another terminal: tunnel to localhost:3000
```

Or with Docker:

```bash
docker compose up --build
```

Install the CLI globally from GitHub:

```bash
npm install -g github:timmichael738/hookrelay
hookrelay listen 3000 --server https://your-relay.example.com
```

## CLI

```text
hookrelay listen <port|url> [options]

  -s, --server <url>     Relay server (default: $HOOKRELAY_SERVER or http://localhost:4000)
  -e, --endpoint <slug>  Reuse an existing endpoint (requires --token)
  -t, --token <token>    Endpoint token (default: $HOOKRELAY_TOKEN)
```

## HTTP API

| Method   | Path                                       | Auth  | Description                                             |
| -------- | ------------------------------------------ | ----- | ------------------------------------------------------- |
| `POST`   | `/api/endpoints`                           | –     | Create an endpoint → `{ slug, token, url, inspectUrl }` |
| `ANY`    | `/h/:slug/*`                               | –     | Webhook ingress                                         |
| `GET`    | `/api/endpoints/:slug`                     | token | Endpoint info + captured requests                       |
| `GET`    | `/api/endpoints/:slug/events`              | token | SSE stream (`request`, `update`, `tunnel`)              |
| `POST`   | `/api/endpoints/:slug/requests/:id/replay` | token | Replay through the tunnel                               |
| `DELETE` | `/api/endpoints/:slug/requests`            | token | Clear captured requests                                 |
| `WS`     | `/api/endpoints/:slug/tunnel`              | token | CLI tunnel                                              |

Auth is `Authorization: Bearer <token>`, or `?token=` where headers aren't available (EventSource).

## Configuration

| Variable         | Default      | Description                                        |
| ---------------- | ------------ | -------------------------------------------------- |
| `PORT`           | `4000`       | Listen port                                        |
| `PUBLIC_URL`     | request host | Base URL used to build webhook URLs behind a proxy |
| `MAX_BODY_BYTES` | `1048576`    | Maximum webhook body size                          |

## Testing

The end-to-end tests start a real relay, a real local server and a real CLI tunnel, then check
live forwarding, response passthrough, replay, token checks, binary bodies and eviction.

```bash
npm test
```

## License

[MIT](LICENSE) © Michael Timothy
