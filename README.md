# muse-cli

CLI + local server for driving **muse.ai** (Meta's personal agent) without the browser.

## Architecture

```
muse CLI  ──HTTP──►  agent server (127.0.0.1:8899)  ──Noise XX over WSS──►  hatch.metaaivm.com
     cookie bootstrap  ──HTTPS (JA3+headers, via proxy)──►  muse.ai  (wake/token/notary)
```

- A disposable browser profile (any Chromium, optional anti-detect) with a per-account
  dedicated proxy (configured in `data/accounts.json`, never committed) is only used
  to *log in* and to *refresh cookies* (`muse bootstrap`).
- Everything else goes through the reverse-engineered Noise protocol
  (`Noise_XX_25519_AESGCM_SHA256`, protobuf ServiceFrames, HTTP-over-Noise).
- Engine vendored from MIT-licensed `manishkumar1601/muse-ai-api` (in `reference/`),
  with local patches: per-request service enum (approvals use `sentinel`),
  proxy support (cycletls + https-proxy-agent for the WS), Sec-Fetch header set,
  `/api/session`-based VM resolution (Node 20 compatible).

## Server

```bash
cd muse-cli
MUSE_HTTP_PROXY=http://<user>:<pass>@<proxy-host>:<port> \
MUSE_PROXY_HOST=0.0.0.0 MUSE_PROXY_PORT=8899 \
npx tsx index.ts > server.log 2>&1 &
```

Endpoints:

| Endpoint | What it does |
|---|---|
| `POST /agent/send {message, session?, wait_ms?}` | send to main chat (or side chat `session`), returns full reply |
| `POST /agent/chat` | same via runChat path (auto-rebootstrap) |
| `GET  /agent/history?limit=&session_id=` | recent chat events |
| `GET  /agent/approvals` | pending + recent approvals (sentinel service) |
| `POST /agent/approvals/{id}/decide {decision, ...}` | decide: allow_once, deny, allow_always… |
| `GET  /agent/approvals/history` | decision history |
| `GET  /agent/approvals/watch?wait_ms=` | long-poll for live `approvals.snapshot` |
| `POST /agent/rpc/{path} {verb, path, body, service}` | raw HTTP-over-Noise passthrough |
| `GET  /agent/status` | session age, VM health, proxy in use |
| `POST /agent/bootstrap` | rebuild session.json from storage_state.json |
| `POST /v1/chat/completions`, `/v1/messages` | OpenAI/Anthropic compatible (vendored) |

## CLI (`bin/muse`)

```bash
export MUSE_SERVER=http://127.0.0.1:8899
muse send "hello"                                  # → Muse's reply
muse history 20                                     # chat transcript
muse approvals                                      # pending approvals
muse approve <approval_id> allow_once               # decide an approval
muse watch 30000                                    # long-poll approvals snapshot
muse status                                         # server/VM health
muse rpc GET /identity daemon                       # raw noise RPC
muse bootstrap                                      # refresh session cookies
```

## Cookie refresh flow (when session expires)

1. Launch the profile in your browser-automation manager (or plain Chromium), log in.
2. Dump cookies → `storage_state.json` (cookie-list → parse muse.ai cookies).
3. `muse bootstrap` (runs `src/cli/bootstrap.ts` server-side).

## Facts learned (verified on live account, 2026-10-21)

- muse.ai = Meta "Hatch": personal agent with per-user cloud Linux VM ("Muse Secure VM").
- Auth = cookies on `.muse.ai`, notably `hatch_sess` (600B), plus rotating `datr`.
- REST bootstrap endpoints (`/api/hatch/vm/wake|token|noise-notary-token`, `lease-vm`) are
  gated by Meta's edge on **Sec-Fetch-\* + sec-ch-\* headers** — full browser set required,
  JA3 alone is NOT enough (403 {"error":"Forbidden"} without them).
- `/api/session?vm_state=live` (GET, ungated) returns the assigned VM id + `wss://<vm>.metaaivm.com/`.
- Chat transport: `wss://hatch.metaaivm.com/v1/noise?vm_id&auth_token&notary_token&app_id=hatch-web&request_id`.
- Services: daemon=0 (chat/state), sentinel=1 (**approvals, permissions**), authd=3 (credentials).
- Approval decisions: allow_once, allow_for_this_task, allow_all_web_access_for_this_task,
  allow_for_this_scheduled_task, allow_for_this_artifact, allow_for_your_feed, allow_always,
  deny, deny_for_this_task, deny_for_this_scheduled_task, deny_for_this_artifact.
  decide body: `{approval_id, decision, always_scope?, reason?, expires_at_ms?, notification_channel?, expected_message_revision?}`.
- This account currently runs with permissions effectively auto-allowed (web fetch/browser
  tasks execute without pending approvals), so the decide path is verified-reachable but
  unexercised against a live approval so far.
- `approvals.snapshot` events arrive on the `/chat/subscribe` stream (live push).
- chat events: message.user / message.assistant (display_text), agent.status, delta.*,
  task.status, client.invoke.
