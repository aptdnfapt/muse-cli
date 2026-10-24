---
name: muse-ops
description: "Use when driving muse.ai agents via the muse CLI: tasks, sessions, research, media generation, usage, approvals."
version: 2.1.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [muse, agents, research, delegation]
---

# Muse ops — driving the 5 muse.ai agents

`/tmp` note: never write run artifacts to /tmp for retention — anything the user
wants kept goes in `./data/` (repo root, git-ignored).

What this is: muse.ai = Meta "Hatch". 5 accounts (muse1..muse5), each a personal
AI agent with its own cloud Linux VM ("Secure VM") that executes real tasks
(browse, research, build files) — controlled from here via the muse CLI, no
browser needed for driving (a browser host only for credential refresh).

## The one rule that makes outputs good: demand end-to-end deliverables

Muse's default behaviour is teaser replies ("I've started researching…", a
summary-of-contents). It is NOT done until the full content lands. Always:

1. **State the deliverable in the first message**: "output the full result in
   chat, in multiple messages if long — every item with details, not a summary
   or teaser. Reply DONE when finished."
2. **Save to a file AND dump to chat**: "Save the report as <name>.md in your
   files, then output the entire content directly in the chat. DONE when saved."
3. **Expect to re-ask**: Muse will volunteer a teaser and stop. If the reply is
   short, answer: "Don't summarize — output everything now, multiple messages
   OK." It complies immediately. This is normal, not a failure.
4. **Full detail beats chat length**: a 30k-char report arrives as ~6 messages.
   Pull the history via the API and concatenate — don't rely on reading one
   message.

## Quick reference

Server: `http://127.0.0.1:8899` (supervisor program `muse-cli`, auto-restart).
CLI: `bin/muse` (from the repo root; plain Node). Set `MUSE_SERVER` if remote.
Accounts: muse1..muse5. Select with `-a <name>` or `MUSE_ACCOUNT`. Default muse1.

```bash
export PATH="$HOME/.npm-global/bin:$PATH"
cd muse-cli   # repo root
./bin/muse accounts                      # list accounts + creds/session/proxy status
./bin/muse -a muse2 status               # account health, VM, session age
./bin/muse -a muse1 usage                # plan, % used, reset date, top-up balance
./bin/muse -a muse1 send "task text"     # send + wait for reply (up to 2 min)
./bin/muse -a muse1 history [n]          # recent transcript
./bin/muse -a muse1 approvals            # pending approvals
./bin/muse -a muse1 watch 25000          # long-poll approvals snapshot
./bin/muse -a muse1 rpc GET /identity - daemon   # raw Noise RPC passthrough
./bin/muse -a muse1 bootstrap            # re-mint admission tokens from cookies
```

Every endpoint accepts `?account=`; every command `-a`. Sessions are per-account:
side chats via send body `{"message":"...","session":"<thread-name>"}`.

## Multi-session / parallel running

- Each account = independent agent + VM + proxy. muse1–muse5 have separate
  proxies by design (identity isolation) — never share proxies across accounts.
- Parallel tasks: launch one task per account (up to 5 at once) with normal
  `send`; they run concurrently. Name side-session with `session` key to keep a
  task isolated from main chat.
- Long tasks: `send` returns Muse's FIRST acknowledgement, not the finished
  work. Poll for results:
  - quick: `./bin/muse -a museN history 4` (read last lines)
  - full: `curl "http://127.0.0.1:8899/agent/history?limit=20"` → parse
    `history.result.chat_events` (message.user / message.assistant /
    delta.presentation [task cards] / agent.status)
- A research loop of research-left-running style takes ~1-3 hours; check every
  30-60 min. A video analysis takes ~4 min. A 29-provider verified report took
  ~2 h on one account.

## Getting files out of Muse's VM

Report files live in Muse's VM at `workspace/<name>.md`. Retrieve:

```bash
curl "http://127.0.0.1:8899/agent/media/fetch?account=museN&path=workspace/<name>.md"
# -> {"ok":true,"bytes":N,"file":"<data-dir>/<ts>-workspace_<name>.md"}
```

`/fs/list` (POST body {"path":"workspace"}) to discover filenames. Browser
screenshots (browser tasks) land in `workspace/.hatch-browser/<id>.jpg` — same
fetch path.

If you serve deliverables over a file server (FileBrowser or similar), map its
source to the account home directory and copy fetched files under the project
dir; hand out links as `https://<filebrowser-host>/<source>/<relative-path>`.

## Approvals & auto-approve

Muse sometimes asks permission (browser access etc.). Auto-approve is ON
(`MUSE_AUTO_APPROVE=allow_once` in supervisor conf): a per-account watcher
connection subscribes and instantly allows every request, logged as
"auto-approved" in `/var/log/supervisor/muse-cli.log`.

Known failure mode (fixed, watch for regression): watcher tokens expire after a
few hours and the watcher got stuck in 403 retry loops. Current code
re-bootstraps (mints fresh tokens from cookies) on 403 and reconnects —
self-healing. If "auto-approve stops working": check
`grep -c 403 /var/log/supervisor/muse-cli.log`, check `/agent/status` →
`watcher_live`. Manual nuke option: `POST /agent/bootstrap?account=` then
`restart muse-cli`.

Cookies (Layer 1, weeks-months) outlive tokens (Layer 2, hours). Re-bootstrap
refreshes tokens only; cookies only need a browser re-login when bootstrap
itself 403s.

## Usage & quotas

Each account: Free plan, weekly percentage limit (resets every ~7 days, currently
Oct 28) + 1B-token gift pool (topupBalance 40M/40M observed = separate ledger
from the 1B; both untouched unless heavy browser/agent work). Usage endpoint:
`muse -a museN usage`. Numbers are read from a Next.js server action on muse.ai
(see muse-ops skill notes in repo README if the action id changes after a muse.ai
deploy — grep "fetchSubscriptionAction" in the settings page JS).

## Video / media analysis (verified capability)

Muse CAN fully analyze YouTube videos: opens in VM browser, dismisses cookie
wall, plays, reads the full auto-transcript (spoken content 100% covered) and
seek-samples frames. ~3-5 min per video on free plan. It SEES the frames but the
screenshot is not written to a file — see "Multi-video YouTube research" for the
yt-dlp + ffmpeg route that produces real PNGs.

## Account management

- Registry: `data/accounts.json` — name → {credentials, session, proxy,
  cycle_tls_port, profile_id (browser profile id)}.
- New account flow (manual login, muse does the rest):
  1. Create a browser profile (CloakBrowser or similar) with the account's DEDICATED
     proxy line (never share proxies between accounts).
  2. Launch profile, open muse.ai, enter the account email, pull the OTP from the
     account's temp-mail inbox (open the exact inbox URL for that address; a
     generic inbox listing will not show the mail), click Next.
  3. cookie-list → build `data/accounts/<name>/credentials.json`
     ({"cookies":[{name,value,domain}]}, muse.ai cookies only).
  4. Bootstrap: env MUSE_STORAGE_STATE_PATH + MUSE_SESSION_PATH +
     MUSE_HTTP_PROXY + MUSE_CYCLETLS_PORT then run dist/src/cli/bootstrap.js —
     verify "bootstrap OK".
  5. Add/verify entry in data/accounts.json (credentials/session/proxy/port).
- After ANY cookie refresh: same bootstrap flow. Browsers stay STOPPED except
  during logins (browsers eat CPU).

## Verified capability map — logged-out browser, Oct 2026

Graded from 34 parallel tasks on muse1+muse2 (10 tasks per account at once works):

- **Threads 9/10** — profile, followers exact, post page + replies, search, recency 1-3 min.
  Only limit: "Log in for more threads about this topic", replies cut after ~12.
- **Instagram 7/10** — profile + grid + exact followers load; grid click hits "Sign up or log in
  to see <user>'s post", but a DIRECT post URL shows likes and comments (1m-fresh). Search route
  returns HTTP 429. So: open posts by direct URL, never by clicking the grid.
- **Facebook 6/10** — page loads behind a dismissible modal but only ONE post renders (rest stuck
  "Loading..."); comments readable via /reel/<id>; search = "Not Found"; mbasic redirects to login
  (`refsrc=deprecated`).
- **X 4/10** — search is a hard login gate; profile pages render with ~3 recent posts.
- **Reddit 7/10** — www.reddit.com works after one "Prove your humanity" reCAPTCHA; old.reddit is
  blocked ("You've been blocked by network security"); newest posts ~7-13h old, not minutes.
- **YouTube 9/10** — native search + filters (Today/this week, duration, live), `&t=90s` seek
  verified in the player, comments + subscriber counts visible, transcript panel readable.
  No caption download in the UI; `yt-dlp` in the VM gets captions and the mp4.
- **TikTok 5/10** — profile pages and embed player work; explore/search is a login gate.
- **LinkedIn 1/10**, **WSJ/Bloomberg/NYT 4/10** — homepages only; article bodies paywalled.
  WSJ may show a DataDome "Verifying the device..." check that clears itself.

**Meta connectors are a separate, better path — but they need a linked account.** On fresh accounts
`facebook_cli`, `instagram`, `threads` return `not connected` + a connect URL, and `facebook_cli`
`pages list` returns HTTP 403 "command currently unavailable". Browser is the only working route
until an account is linked at https://agent.meta.ai/foa_ac_link/<platform>.

## Multi-video YouTube research (verified good)

Same task in 3 sessions produced 5 videos each, timestamped bullets, and a cross-video synthesis
(agreements / contradictions / unverifiable / best evidence). Two runs picked identical videos with
identical view counts and a later run showed a higher count — live data.

Reality about screenshots: live-browser captures stay in-session and land as auto-named
`workspace/.hatch-browser/<id>.jpg` (real, ~1919x998); the agent cannot save them under chosen names.
For real files, make it `yt-dlp` the video then `ffmpeg -ss <t> -frames:v 1` in the VM — that gave
4 named PNGs at 1280x720 plus an 81 MB mp4. Say this in the prompt or it may claim filenames that
do not exist.

## Named side-sessions: map, persistence, endpoints

`session` in the send body maps to a thread UUID in `chatSessions` (SessionStore). The map persists
to `data/sessions-map.json`, so a muse-cli restart no longer orphans named sessions.

```bash
curl -s localhost:8899/agent/sessions            # name -> session_id, most recent first
curl -s "localhost:8899/agent/session/resolve?session=t12-reddit"
curl -s "localhost:8899/agent/history?account=muse2&session_id=<uuid>&limit=200"
```

Parse `history.result.chat_events`: `message.user`, `message.assistant` (display_text),
`delta.presentation`, `agent.status`. Poll every few minutes; concatenate all assistant messages —
the full report arrives as several messages after the teaser.

## Mechanism facts (how it actually gets data)

- Precedence the agent follows: connector CLI → `social.search` → `browser.open` → `browser.browse`.
- Meta connectors are CLI binaries in `/opt/hatch/bin/` (`threads-cli`, `instagram-cli`,
  `facebook-cli`), called through `muse.exec`. They need `--account-id` and an Accounts Center link.
- **`browser.open` returns exact numbers the live UI rounds.** Instagram post: `44073 likes,
  4440 comments` vs the page's "44.1K / 4.4K". Always try the text fetch before the browser.
- Threads: `browser.open` gives likes only; `browser.browse` adds replies/reposts/shares.
- Facebook: `browser.open` gives the profile (followers) but no posts — posts need `browser.browse`,
  which renders only the newest one.
- `social.search` / `hatch-zeitgeist --post-url` return stubs (`like_count: 0`) — treat zeros as empty
  fields, never as real counts.
- X search is a hard login wall for every tool. What works: **curl the profile page** and parse the
  embedded state (10 tweet objects with exact `created_at_ms` + `favorite_count`; the browser shows 5),
  and the `tweet-result` syndication endpoint with `&token=a` for one exact post.
- Reddit: no connector. Live browser + one reCAPTCHA gets posts 1 minute old; JSON endpoint,
  old.reddit and redlib all fail.
- Screenshots: the agent SEES browser screenshots but no file is written; headless Chrome
  `--screenshot` reports success and writes nothing; a CDP `Page.captureScreenshot` does write a real
  PNG. Video frames are visible in-session at exact timestamps, still no file.
- Pushing helps when the wall is rendering, not when it is authentication. Four-attempt ladders fixed
  X (by changing the door) and Reddit (first door), and could not fix a paywalled article.
- `muse.skill_search` works with **no linked account** — 54 skills in `/opt/muse/skills`, plus
  `~/workspace/custom-skills`. It is a playbook catalog: it tells the agent HOW to do a job but grants
  no data access. Tool results arrive wrapped as `[BEGIN EXTERNAL CONTENT … source=skills]`.
- Media generation works on the free plan and writes real files to `workspace/imagine_media/`:
  images as `.webp` (81 KB–740 KB) and video as `.mp4`, 10 s, 1280x720, h264+aac, 6–9 MB. Image
  editing works on the generated file (same composition, added elements). Fetch via
  `/agent/media/fetch`.
- Instagram hashtag route DOES work logged out: `instagram.com/explore/tags/<tag>/` → redirects to
  `/popular/<tag>/` with 12 reels and full `/reel/` URLs — but it is a popularity grid, **no dates and
  no recency**. Keyword search is still HTTP 429.
- X ceiling: curl of a profile gives exactly **5 posts** (cursor is null, no pagination). Newest post
  observed was 17 h old. Topic search is impossible by search URL, Nitter, xcancel or site: queries.
- Facebook post count varies by run: fresh loads rendered 1 post in one run and 11 in another; the
  extra posts were older (Oct 6–13). m.facebook.com redirects to the desktop page with the same limit.

## Media generation, editing and cost (verified, free plan)

Generation works on the free plan and produces real files, no refusal encountered.

- **Image** — `media.generate_image`. Output is **`.webp`**, 1920x1280 landscape or 1280x1920 portrait,
  80 KB–740 KB. Writes to `workspace/imagine_media/` next to a small `.json` sidecar.
- **Video** — `media.generate_video`. Output is **`.mp4`, exactly 10.0 s, 1280x720, h264 + aac**,
  2.9–9.0 MB. Asking for "5 seconds" still returns 10 s; treat the length as fixed.
  Documented cap: 6 videos per user message.
- **Edit** — an existing generated image can be edited (same composition, added elements). Editing is
  done on the file, not by regenerating a lookalike; verify by comparing both files.
- **Fetch** — `GET /agent/media/fetch?account=<a>&path=workspace/imagine_media/<file>`; the response
  gives `file` on disk. `.webp` often will not render as a Telegram photo — convert first:
  `ffmpeg -i x.webp x.png`.

**Measured cost** (live weekly meter, one item at a time):
- One image ≈ **1 percentage point** of the weekly quota.
- One 10 s video ≈ **3 percentage points**.
- Roughly **100 images or 30 videos per account per week**. Video is ~3x an image.
- A media-heavy session (3 images, 1 edit, 3 videos + ~14 follow-up messages) moved two accounts
  from 19/20% to 37/42%. The 1B-token top-up stayed untouched by all of it.

Prompt for the **deliverable**, not the picture: "save it and report filename, dimensions, size in
bytes and the tool you used". Otherwise a generation task can end with a bare DONE and no file path.

## Strengths, weaknesses, and where it is unique

**Strong**
- End-to-end work: real xlsx with live formulas, PDFs, notes files, runnable Python, downloaded media.
- Parallel: 10 side-sessions per account at once all completed; `subagent.spawn`/`workflow.*` inside.
- Fast: most research tasks 2–15 min; media generation ~1–3 min.
- Honest: refuses to invent filenames, marks OPENED vs SEARCH-ONLY, reports connector errors verbatim.
- Sees: reads text inside images and watches video frames, not just transcripts.

**Weak**
- Blind without a linked account: private or deep platform data is unreachable.
- Logged-out social is shallow: Facebook renders 1 post, Instagram keyword search is 429, X search is
  a login gate.
- Screenshots are visible in-session but not saved; only CDP/ffmpeg routes produce files.
- Threads can stall and need a status nudge; a dead thread never answers (see failure handbook).
- Weekly quota burns fast on video.

**Unique**: it is a VM with a browser and a shell, not a chat API. It scrolls, hovers, pauses video at
an exact second, writes files, runs code, and reports what it actually saw — and it will say "this is
blocked" instead of improvising.

## Failure handbook

- `send` returns 403/quote: session expired → run bootstrap for that account.
- `watcher_live: false`: watcher connection dropped; auto-approve still works on
  demand (each rpc opens fresh), but restart muse-cli to bring back instant
  watchers: `sudo supervisorctl restart muse-cli`.
- "unknown account": account missing in data/accounts.json — add entry then
  relaunch server (supervisor restart).
- Reply misses the ask or is a teaser: re-ask with "Don't summarize — output everything now".
  90% of muse's underdelivery is fixed by this single line.
- Stalled thread (no new events for 20+ min, only the ack): send "Status check — report what is on
  screen now and what blocked you, then output everything you have, full, DONE". Both stalled
  browser tasks in testing returned complete results right after this nudge.
- A paywall can make it stop and ask for a login instead of falling back: tell it explicitly
  "if paywalled, take the next source, never stop to ask for credentials".
- Dead thread: `send` returns `{"ok":true}` with an empty reply and the history stays at one
  `message.user` event after a second send. The thread will never answer — stop retrying, reuse a
  NEW session name. Check with `/agent/history?session_id=...` (length 1 = dead), not the send status.
- Report 404s on /agent/usage after muse.ai deploy: server-action id changed;
  re-grab from settings page JS.

## Project layout (single source of truth)

```
./                    # repo root
├── bin/muse            # CLI (plain node, no deps)
├── src/                # server TS (noise proto engine + agent endpoints)
├── dist/               # compiled (git-ignored)
├── data/               # accounts.json, credentials, sessions, media, logs (ignored)
├── reference/          # ignored: vendored muse-ai-api engine + recon dumps
└── README.md
```

Local git repo; commits use the automated GitHub identity. The server runs from
this directory under supervisor — deploys are `npx tsc && restart muse-cli`.
Never deploy a second source tree elsewhere; one tree, one runtime.

## Protocol notes for extension work (reference/, do not edit)

- Noise_XX_25519_AESGCM_SHA256 over wss://hatch.metaaivm.com/v1/noise; protobuf
  ServiceFrames = HTTP-over-Noise. Services: daemon=0 (everything normal),
  sentinel=1 (approvals/permissions), authd=3 (credentials).
- Meta edge rejects POSTs to /api/hatch/* without FULL browser headers
  (Sec-Fetch-*, sec-ch-*, accept, accept-language) — 403 even with perfect JA3.
- VM assignment: GET https://muse.ai/api/session?vm_state=live (plain HTTPS).
- Usage: POST muse.ai/ with Next-Action header (see README for the id).
- muse.ai = meta "Hatch": with user's shell access the agent could be scripted
  directly in VM, but we keep everything through the documented CLI.
