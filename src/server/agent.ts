// Agent-control server: JSON API over the Noise transport to drive Muse.
// Built on the vendored muse-ai-api engine (MIT, manishkumar1601/muse-ai-api).
import { Hono } from "hono";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { bootstrap } from "../bootstrap/session.js";
import type { Session } from "../bootstrap/session.js";
import { HatchClient } from "../hatch/client.js";
import { sendAndCollectReply, CAPABILITIES } from "../hatch/chat.js";
import { getTls, SHARED_HEADERS, CHROME_JA3 } from "../hatch/tls.js";
import { loadCookies } from "../bootstrap/cookies.js";
import { SessionStore, DEFAULT_SESSION_KEY } from "../hatch/sessions.js";
import { SERVICE_DAEMON, SERVICE_SENTINEL, SERVICE_AUTHD } from "../proto/types.js";
import { logger } from "../log.js";
import type { Config } from "../config.js";
import { runChat } from "./handler.js";
import { AccountRegistry, type AccountConfig } from "./accounts.js";

function loadSession(path: string): Session {
  return JSON.parse(readFileSync(path, "utf-8")) as Session;
}

const chatSessions = new SessionStore();

const SERVICE_BY_NAME: Record<string, number> = {
  daemon: SERVICE_DAEMON,
  sentinel: SERVICE_SENTINEL,
  authd: SERVICE_AUTHD,
};

/** One-shot Noise RPC: open a fresh connection, send, collect the response, close. */
async function withClientAcct<T>(account: { session: string; proxy: string; cycle_tls_port: number }, fn: (client: HatchClient) => Promise<T>): Promise<T> {
  const session = loadSession(account.session);
  const client = await HatchClient.open(session, await getTlsFor(account));
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Send one HTTP-over-Noise request and collect its full JSON body (or raw bytes). */
async function rpc(
  client: HatchClient,
  verb: string,
  path: string,
  body?: unknown,
  service: number = SERVICE_DAEMON,
): Promise<{ status: number; body: unknown; raw?: Uint8Array }> {
  const sid = client.request(verb, path, body, undefined, service);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const r = await client.recvOne(2000);
    if (r === null) continue;
    if (r === "closed") throw new Error("connection closed while waiting for response");
    if (r.kind === "complete" && r.streamId === sid) {
      if (r.rawBody !== undefined && r.body !== null) return { status: r.status, body: r.body };
      if (r.rawBody !== undefined) return { status: r.status, body: null, raw: r.rawBody };
      return { status: r.status, body: r.body };
    }
    // ignore events / resets for other streams during collection
  }
  throw new Error(`timeout waiting for ${verb} ${path}`);
}

export interface AgentDeps {
  cfg: Config;
}

// TLS clients keyed by proxy (each account can have its own egress).
const tlsByProxy = new Map<string, Awaited<ReturnType<typeof getTls>>>();
async function getTlsFor(account: { proxy: string; cycle_tls_port: number }) {
  let t = tlsByProxy.get(account.proxy);
  if (!t) {
    const { default: initCycleTLS } = await import("cycletls");
    t = await (initCycleTLS as unknown as (o?: unknown) => Promise<{ exit(): Promise<void> }>)({
      proxy: account.proxy,
      port: account.cycle_tls_port,
    }) as unknown as Awaited<ReturnType<typeof getTls>>;
    tlsByProxy.set(account.proxy, t);
  }
  return t;
}

export function registerAgent(app: Hono, deps: AgentDeps): void {
  const cfg = deps.cfg;
  const registry = new AccountRegistry(process.env["MUSE_ACCOUNTS_FILE"] ?? "data/accounts.json");
  const getAccount = (c: { req: { query(n: string): string | undefined } }) =>
    registry.get(c.req.query("account"));

  // ---------- chat ----------
  app.post("/agent/send", async (c) => {
    const acct = getAccount(c);
    if (!acct) return c.json({ ok: false, error: "unknown account (see /agent/accounts)" }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const text = typeof body["message"] === "string" ? body["message"] : "";
    if (!text.trim()) return c.json({ ok: false, error: "missing 'message'" }, 400);
    const sessionKey = typeof body["session"] === "string" && body["session"].trim()
      ? `h:${body["session"].trim()}` : DEFAULT_SESSION_KEY;
    const sideSession = sessionKey === DEFAULT_SESSION_KEY ? undefined : chatSessions.get(sessionKey);
    const listenMs = typeof body["wait_ms"] === "number" ? body["wait_ms"] : 120_000;
    try {
      const client = await HatchClient.open(loadSession(acct.session), await getTlsFor(acct));
      try {
        const r = await sendAndCollectReply({
          client,
          userText: text,
          timezone: cfg.timezone,
          listenMs,
          ...(sideSession !== undefined ? { sessionState: sideSession } : {}),
        });
        return c.json({ ok: true, reply: r.replyText, message_id: r.messageId });
      } finally {
        await client.close();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // one auto-rebootstrap then retry once
      try {
        registry.ensureDirs(acct.name);
        await bootstrap({ storageStatePath: acct.credentials, sessionPath: acct.session });
        const client = await HatchClient.open(loadSession(acct.session), await getTlsFor(acct));
        try {
          const r = await sendAndCollectReply({
            client, userText: text, timezone: cfg.timezone, listenMs,
            ...(sideSession !== undefined ? { sessionState: sideSession } : {}),
          });
          return c.json({ ok: true, reply: r.replyText, message_id: r.messageId });
        } finally {
          await client.close();
        }
      } catch (e2) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        return c.json({ ok: false, error: msg + " / retry: " + msg2 }, 502);
      }
    }
  });

  app.post("/agent/chat", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const text = typeof body["message"] === "string" ? body["message"] : "";
    if (!text.trim()) return c.json({ ok: false, error: "missing 'message'" }, 400);
    const sessionKey = typeof body["session"] === "string" && body["session"].trim()
      ? `h:${body["session"].trim()}` : DEFAULT_SESSION_KEY;
    try {
      const r = await runChat(cfg, text, undefined, sessionKey);
      return c.json({ ok: true, reply: r.replyText, message_id: r.messageId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ ok: false, error: msg }, 502);
    }
  });

  // ---------- history ----------
  app.get("/agent/history", async (c) => {
    const acct = getAccount(c);
    if (!acct) return c.json({ ok: false, error: "unknown account (see /agent/accounts)" }, 404);
    const limit = Number(c.req.query("limit") ?? "40");
    const sessionId = c.req.query("session_id");
    try {
      const out = await withClientAcct(acct, async (client) => {
        const path = `/chat/history?limit=${limit}&transcript_mode=messages${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ""}`;
        return rpc(client, "GET", path);
      });
      return c.json({ ok: out.status >= 200 && out.status < 300, status: out.status, history: out.body });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  // ---------- media: VM filesystem listing + binary fetch into repo data dir ----------
  const DATA_DIR = cfg.dataDir;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  // ---------- named side-sessions: list + transcript resolution ----------
  app.get("/agent/sessions", (c) => {
    const out: Array<Record<string, unknown>> = [];
    for (const [key, st] of (chatSessions as unknown as { map: Map<string, { sessionId: string; nodeId: string; lastUsed: number }> }).map) {
      out.push({ name: key.replace(/^h:/, ""), session_id: st.sessionId, last_used_ms: st.lastUsed });
    }
    out.sort((a, b) => Number(b["last_used_ms"]) - Number(a["last_used_ms"]));
    return c.json({ ok: true, count: out.length, sessions: out });
  });

  app.get("/agent/session/resolve", (c) => {
    const name = c.req.query("session");
    if (!name) return c.json({ ok: false, error: "missing 'session'" }, 400);
    const st = chatSessions.get(`h:${name}`);
    return c.json({ ok: true, name, session_id: st.sessionId });
  });

  app.get("/agent/media/list", async (c) => {
    const acct = getAccount(c);
    if (!acct) return c.json({ ok: false, error: "unknown account (see /agent/accounts)" }, 404);
    const dir = c.req.query("dir") ?? "/";
    try {
      const out = await withClientAcct(acct, async (client) => rpc(client, "POST", "/fs/list", { path: dir }));
      return c.json({ ok: out.status >= 200 && out.status < 300, status: out.status, listing: out.body });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  app.get("/agent/media/fetch", async (c) => {
    const acct = getAccount(c);
    if (!acct) return c.json({ ok: false, error: "unknown account (see /agent/accounts)" }, 404);
    const p = c.req.query("path");
    if (!p) return c.json({ ok: false, error: "missing 'path'" }, 400);
    try {
      const out = await withClientAcct(acct, async (client) => rpc(client, "GET", `/fs/raw/${p.replace(/^\//, "")}`));
      if (out.status < 200 || out.status >= 300 || !out.raw) {
        return c.json({ ok: false, status: out.status, body: out.body }, 502);
      }
      const buf = Buffer.from(out.raw);
      const safeName = p.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120);
      const dest = `${DATA_DIR}/${Date.now()}-${safeName}`;
      writeFileSync(dest, buf);
      // raw bytes back too (use ?raw=1), JSON metadata otherwise
      if (c.req.query("raw") === "1") {
        return c.body(buf, 200, { "content-type": "application/octet-stream" });
      }
      return c.json({ ok: true, bytes: buf.length, file: dest });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  // ---------- media: browser-task screenshots straight out of chat history ----------
  app.get("/agent/media/screenshots", async (c) => {
    const acct = getAccount(c);
    if (!acct) return c.json({ ok: false, error: "unknown account (see /agent/accounts)" }, 404);
    const limit = Number(c.req.query("limit") ?? "40");
    const sessionId = c.req.query("session_id");
    try {
      const out = await withClientAcct(acct, async (client) =>
        rpc(client, "GET", `/chat/history?limit=${limit}&transcript_mode=messages${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ""}`));
      const body = out.body as Record<string, unknown>;
      const events = ((body as { result?: { chat_events?: Record<string, unknown>[] } })?.result?.chat_events) ?? [];
      const shots: Array<Record<string, unknown>> = [];
      const scan = (obj: unknown): void => {
        if (Array.isArray(obj)) { obj.forEach(scan); return; }
        if (obj === null || typeof obj !== "object") return;
        const rec = obj as Record<string, unknown>;
        for (const [k, v] of Object.entries(rec)) {
          if ((k === "screenshot" || k === "latestScreenshot" || k === "screenshot_url") && typeof v === "string") {
            shots.push({ url: v, message_id: rec["message_id"] ?? null, occurred_at_ms: rec["occurred_at_ms"] ?? null });
          } else {
            scan(v);
          }
        }
      };
      events.forEach(scan);
      return c.json({ ok: true, count: shots.length, screenshots: shots });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  app.get("/agent/media/grab", async (c) => {
    const acct = getAccount(c);
    if (!acct) return c.json({ ok: false, error: "unknown account (see /agent/accounts)" }, 404);
    const url = c.req.query("url");
    if (!url) return c.json({ ok: false, error: "missing 'url'" }, 400);
    try {
      // media paths look like /api/idea-cards/media/<id> or similar — fetch over Noise with the session
      const pathOnly = url.startsWith("http") ? new URL(url).pathname + (new URL(url).search) : url;
      const out = await withClientAcct(acct, async (client) => rpc(client, "GET", pathOnly));
      if (out.status < 200 || out.status >= 300 || !out.raw) {
        return c.json({ ok: false, status: out.status, body: out.body }, 502);
      }
      const buf = Buffer.from(out.raw);
      const name = (pathOnly.split("/").filter(Boolean).pop() ?? "media.bin").replace(/[^A-Za-z0-9._-]+/g, "_");
      const dest = `${DATA_DIR}/${Date.now()}-${name}`;
      writeFileSync(dest, buf);
      return c.json({ ok: true, bytes: buf.length, file: dest });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  // ---------- approvals ----------
  app.get("/agent/approvals", async (c) => {
    const acct = getAccount(c);
    if (!acct) return c.json({ ok: false, error: "unknown account (see /agent/accounts)" }, 404);
    try {
      const out = await withClientAcct(acct, async (client) => rpc(client, "GET", "/approvals", undefined, SERVICE_SENTINEL));
      return c.json({ ok: out.status >= 200 && out.status < 300, status: out.status, approvals: out.body });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  app.post("/agent/approvals/:id/decide", async (c) => {
    const acct = getAccount(c);
    if (!acct) return c.json({ ok: false, error: "unknown account (see /agent/accounts)" }, 404);
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const decision = typeof body["decision"] === "string" ? body["decision"] : "allow_once";
    const payload: Record<string, unknown> = { approval_id: id, decision };
    if (typeof body["always_scope"] === "string") payload["always_scope"] = body["always_scope"];
    if (typeof body["reason"] === "string") payload["reason"] = body["reason"];
    if (typeof body["expected_message_revision"] === "string") payload["expected_message_revision"] = body["expected_message_revision"];
    try {
      const out = await withClientAcct(acct, async (client) =>
        rpc(client, "POST", `/approvals/${encodeURIComponent(id)}/decide`, payload, SERVICE_SENTINEL));
      return c.json({ ok: out.status >= 200 && out.status < 300, status: out.status, result: out.body });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  app.get("/agent/approvals/history", async (c) => {
    const acct = getAccount(c);
    if (!acct) return c.json({ ok: false, error: "unknown account (see /agent/accounts)" }, 404);
    try {
      const out = await withClientAcct(acct, async (client) => rpc(client, "GET", "/approvals/history", undefined, SERVICE_SENTINEL));
      return c.json({ ok: out.status >= 200 && out.status < 300, status: out.status, history: out.body });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  // ---------- approvals watch (live snapshot events, long-poll) ----------
  let watchClient: HatchClient | null = null;
  let watchLoopRunning = false;
  let latestSnapshot: { evt: unknown; at: number } | null = null;
  const decidedIds = new Set<string>();

  async function autoDecide(acct: { name: string; credentials: string; session: string; proxy: string; cycle_tls_port: number }, payload: Record<string, unknown>): Promise<number> {
    const pending = (payload["pending_approvals"] ?? payload["pending"] ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(pending) || pending.length === 0) return 0;
    let n = 0;
    for (const ap of pending) {
      const id = typeof ap["approval_id"] === "string" ? ap["approval_id"]
        : typeof ap["id"] === "string" ? ap["id"] : null;
      if (!id || decidedIds.has(id)) continue;
      decidedIds.add(id);
      try {
        await withClientAcct(acct, async (client) =>
          rpc(client, "POST", `/approvals/${encodeURIComponent(id)}/decide`,
            { approval_id: id, decision: cfg.autoApprove }, SERVICE_SENTINEL));
        logger.info({ approval_id: id, decision: cfg.autoApprove }, "auto-approved");
        n++;
      } catch (e) {
        logger.warn({ approval_id: id, err: e instanceof Error ? e.message : String(e) }, "auto-approve failed");
      }
    }
    return n;
  }

  const watchers = new Map<string, HatchClient | null>();
  async function ensureWatcher(acct: { name: string; credentials: string; session: string; proxy: string; cycle_tls_port: number }): Promise<void> {
    if (watchers.has(acct.name)) return;
    watchers.set(acct.name, null);
    void (async () => {
      for (;;) {
        try {
          const session = loadSession(acct.session);
          const client = await HatchClient.open(session, await getTlsFor(acct));
          watchClient = client;
          watchers.set(acct.name, client);
          // register + subscribe so approvals.snapshot events reach us
          const nodeId = `muse-cli-${Date.now().toString(36)}`;
          client.request("POST", "/api/nodes/register", {
            node_id: nodeId, display_name: "muse-cli", platform: "windows",
            commands_v2: { ping: { description: "Connection liveness check" } },
          });
          client.request("POST", "/client/register-capabilities", {
            client_id: nodeId, platform: "web", display_name: "muse-cli", version: "0.0.0",
            capabilities: {
              data_sources: {}, device_commands: {}, hatch_app_commands: {},
              rendering: {
                supported_presentations: ["text_with_button", "generic_list"],
                supported_inline_presentations: ["option"],
                supported_text_entities: [],
              },
            },
          });
          client.request("POST", "/chat/subscribe", {
            after_stream_seq: 0, after_chat_event_seq: 0, capabilities: [...CAPABILITIES],
          });
          // catch up on anything pending right now (replay from seq 0)
          if (cfg.autoApprove !== "off") {
            const cur = await withClientAcct(acct, async (c2) => rpc(c2, "GET", "/approvals", undefined, SERVICE_SENTINEL));
            const body = cur.body as Record<string, unknown> | null;
            const res = (body as { result?: Record<string, unknown> } | null)?.result ?? body;
            if (res) void autoDecide(acct, res);
          }
          for (;;) {
            const r = await client.recvOne(5000);
            if (r === "closed") break;
            if (r === null) continue;
            if (r.kind === "event") {
              const name = (r.obj as Record<string, unknown>)["event"];
              if (name === "approvals.snapshot") {
                latestSnapshot = { evt: r.obj, at: Date.now() };
                if (cfg.autoApprove !== "off") {
                  const payload = (r.obj as Record<string, unknown>)["payload"] as Record<string, unknown>;
                  void autoDecide(acct, payload ?? {});
                }
              }
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Identity failures mean the admission token expired — re-bootstrap this
          // account (wake VM + mint fresh token from cookies) before the next retry.
          if (/403|identity|credential/i.test(msg)) {
            try {
              registry.ensureDirs(acct.name);
              await bootstrap({ storageStatePath: acct.credentials, sessionPath: acct.session });
              logger.info({ account: acct.name }, "approvals watcher re-bootstrapped session");
            } catch (be) {
              logger.warn({ account: acct.name, err: be instanceof Error ? be.message : String(be) }, "watcher re-bootstrap failed");
            }
          }
          logger.warn({ err: msg, account: acct.name }, "approvals watcher reconnect");
        }
        watchClient = null;
        await new Promise((r) => setTimeout(r, 5000));
      }
    })();
  }

  // auto-approve mode keeps a watcher alive per account from startup
  if (cfg.autoApprove !== "off") {
    logger.info({ mode: cfg.autoApprove, accounts: registry.list().length }, "auto-approve enabled — watchers starting");
    for (const a of registry.list()) void ensureWatcher(a);
  }

  // Long-poll: ?wait_ms=20000 blocks until a fresh approvals.snapshot arrives.
  app.get("/agent/approvals/watch", async (c) => {
    const acct = getAccount(c);
    if (!acct) return c.json({ ok: false, error: "unknown account" }, 404);
    void ensureWatcher(acct);
    const waitMs = Math.min(Number(c.req.query("wait_ms") ?? "0"), 120_000);
    const since = Date.now();
    const deadline = since + waitMs;
    while (Date.now() < deadline) {
      if (latestSnapshot && latestSnapshot.at > since) {
        return c.json({ ok: true, event: latestSnapshot.evt });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return c.json({ ok: true, event: latestSnapshot?.evt ?? null, live: latestSnapshot !== null });
  });

  // ---------- generic noise passthrough (service can be specified) ----------
  app.post("/agent/rpc/*", async (c) => {
    const acct = getAccount(c);
    if (!acct) return c.json({ ok: false, error: "unknown account (see /agent/accounts)" }, 404);
    const path = "/" + (c.req.path.replace(/^\/agent\/rpc\//, ""));
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const verb = typeof body["verb"] === "string" ? body["verb"] : "GET";
    const rpcPath = typeof body["path"] === "string" ? body["path"] : path;
    const service = SERVICE_BY_NAME[typeof body["service"] === "string" ? body["service"] : "daemon"] ?? SERVICE_DAEMON;
    const payload = body["body"];
    try {
      const out = await withClientAcct(acct, async (client) => rpc(client, verb, rpcPath, payload, service));
      return c.json({ ok: out.status >= 200 && out.status < 300, status: out.status, body: out.body });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  // ---------- usage: Next.js server action for subscription/usage state ----------
  // Muse exposes usage via an RSC server action on muse.ai (not the Noise daemon):
  //   POST https://muse.ai/  header Next-Action: 4029ac5c4bd03136487d91ebde5de39c64b35229b4
  //   body: [{"includeAgreement":true}]
    // ---------- usage: Next.js server action for subscription/usage state ----------
  app.get("/agent/usage", async (c) => {
    const acct = getAccount(c);
    if (!acct) return c.json({ ok: false, error: "unknown account (see /agent/accounts)" }, 404);
    try {
      const tls = await getTlsFor(acct);
      const cookieFile = acct.credentials;
      if (!existsSync(cookieFile)) return c.json({ ok: false, error: "no credentials file" }, 400);
      const cookies = loadCookies(cookieFile);
      if (!cookies["hatch_sess"]) return c.json({ ok: false, error: "not logged in (no hatch_sess)" }, 400);
      const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      const fn = tls as unknown as (url: string, opts: unknown, method: string) => Promise<{ status: number; body: unknown }>;
      const resp = await fn("https://muse.ai/", {
        ja3: CHROME_JA3,
        userAgent: SHARED_HEADERS["User-Agent"],
        headers: {
          ...SHARED_HEADERS,
          "Cookie": cookieHeader,
          "Referer": "https://muse.ai/settings",
          "Accept": "text/x-component",
          "Next-Action": "4029ac5c4bd03136487d91ebde5de39c64b35229b4",
          "Content-Type": "text/plain;charset=UTF-8",
        },
        body: JSON.stringify([{ includeAgreement: true }]),
      }, "POST");
      if (resp.status !== 200) return c.json({ ok: false, status: resp.status, body: resp.body }, 502);
      const raw = typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body);
      const parsed: Record<string, unknown> = { raw };
      try {
        for (const line of raw.split("\n")) {
          const m = line.match(/^\d+:(\{.*\})\s*$/);
          if (m && line.includes('"subscription"')) {
            parsed.subscription = JSON.parse(m[1] ?? "{}").subscription;
            break;
          }
        }
      } catch { /* keep raw */ }
            const sub = parsed.subscription as Record<string, unknown> | null;
      const usage = sub ? {
        tier: (sub.tier as Record<string, unknown>)?.name ?? null,
        tier_id: (sub.tier as Record<string, unknown>)?.tierId ?? null,
        state: (sub.usage as Record<string, unknown>)?.state ?? null,
        percent_used: (sub.usage as Record<string, unknown>)?.percentUsed ?? null,
        quota_status: (sub.usage as Record<string, unknown>)?.quotaStatus ?? null,
        resets_at: (sub.usage as Record<string, unknown>)?.resetsAt ?? null,
        resets_human: sub.statusSubtitle ?? null,
        topup_balance: sub.topupBalance ?? null,
        topup_total: sub.topupTotal ?? null,
        topup_label: sub.topupRowValueLabel ?? null,
        topup_eligible: sub.topupEligible ?? null,
      } : null;
      return c.json({ ok: true, usage });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  // ---------- session status ----------
  // ---------- accounts ----------
  app.get("/agent/accounts", (c) => {
    const list = registry.list().map(a => ({
      name: a.name,
      label: a.label ?? null,
      has_credentials: existsSync(a.credentials),
      has_session: existsSync(a.session),
      proxy: a.proxy ? a.proxy.replace(/\/\/[^@]*@/, "//***@") : null,
    }));
    return c.json({ ok: true, accounts: list });
  });

  app.get("/agent/status", async (c) => {
    const acct = getAccount(c);
    if (!acct) return c.json({ ok: false, error: "unknown account (see /agent/accounts)" }, 404);
    let session: Session | null = null;
    try { session = loadSession(acct.session); } catch { /* none */ }
    let vm: unknown = null;
    if (session) {
      try {
        const out = await withClientAcct(acct, async (client) => rpc(client, "GET", "/healthz"));
        vm = out.body;
      } catch (e) {
        vm = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    return c.json({
      ok: true,
      account: acct.name,
      label: acct.label ?? null,
      has_session: session !== null,
      session_age_s: session ? Math.floor((Date.now() - new Date(session.captured_at).getTime()) / 1000) : null,
      vm_id: session?.vm_id ?? null,
      vm_health: vm,
      auto_approve: cfg.autoApprove,
      watcher_live: watchClient !== null,
      proxy: process.env["MUSE_HTTP_PROXY"] ? "configured" : "none",
    });
  });

  // ---------- re-bootstrap ----------
  app.post("/agent/bootstrap", async (c) => {
    const acct = getAccount(c);
    if (!acct) return c.json({ ok: false, error: "unknown account (see /agent/accounts)" }, 404);
    try {
      registry.ensureDirs(acct.name);
      const s = await bootstrap({ storageStatePath: acct.credentials, sessionPath: acct.session });
      return c.json({ ok: true, account: acct.name, vm_id: s.vm_id, captured_at: s.captured_at });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });
}
