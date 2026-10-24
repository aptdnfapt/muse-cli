import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ChatSessionState {
  // sessionId doubles as the muse.ai thread/side-chat identifier.
  // Fresh UUID per API session; passing it into /chat/stream creates the
  // thread on first use and routes to it on subsequent calls.
  sessionId: string;
  nodeId: string;
  lastUsed: number;
}

export class SessionStore {
  private readonly map = new Map<string, ChatSessionState>();
  private readonly file =
    `${process.env["MUSE_SESSIONS_FILE"] ?? `${process.env["MUSE_DATA_DIR"] ?? "./data"}/sessions-map.json`}`;
  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly maxEntries = 1000,
  ) {
    this.load();
  }

  get(key: string): ChatSessionState {
    let s = this.map.get(key);
    if (s) {
      this.map.delete(key);
    } else {
      s = { sessionId: randomUUID(), nodeId: randomUUID(), lastUsed: Date.now() };
    }
    s.lastUsed = Date.now();
    this.map.set(key, s);
    this.sweep();
    this.save();
    return s;
  }

  size(): number { return this.map.size; }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Record<string, ChatSessionState>;
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.sessionId === "string") this.map.set(k, v);
      }
    } catch { /* corrupt map: start clean */ }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 0));
    } catch { /* best effort */ }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (now - v.lastUsed > this.ttlMs) this.map.delete(k);
    }
    if (this.map.size > this.maxEntries) {
      // ponytail: drop oldest when over cap; insertion order is Map iteration order
      const toDrop = this.map.size - this.maxEntries;
      let i = 0;
      for (const k of this.map.keys()) {
        if (i++ >= toDrop) break;
        this.map.delete(k);
      }
    }
  }
}

export const DEFAULT_SESSION_KEY = "default";

export function deriveSessionKey(headers: {
  xMuseSession?: string | undefined;
  authorization?: string | undefined;
}): string {
  if (headers.xMuseSession && headers.xMuseSession.trim().length > 0) {
    return `h:${headers.xMuseSession.trim()}`;
  }
  if (headers.authorization && headers.authorization.trim().length > 0) {
    return `a:${createHash("sha256").update(headers.authorization).digest("hex").slice(0, 16)}`;
  }
  return DEFAULT_SESSION_KEY;
}
