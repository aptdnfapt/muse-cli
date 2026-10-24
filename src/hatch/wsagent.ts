// WebSocket factory: `ws` package + optional HTTPS proxy agent.
// Node 20 has no global WebSocket; even on Node 22+ we prefer `ws` because it
// supports an agent option (needed to route the Noise WS through the proxy).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function makeWs(
  url: string,
  headers: Record<string, string>,
  proxyUrl?: string,
): { readyState: number; binaryType: string; send(data: Uint8Array): void; close(): void;
    addEventListener(type: string, l: (ev: { data?: unknown; message?: string }) => void): void;
    removeEventListener(type: string, l: (ev: { data?: unknown; message?: string }) => void): void } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsMod = require("ws");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts: any = { headers };
  if (proxyUrl && proxyUrl.trim().length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { HttpsProxyAgent } = require("https-proxy-agent") as any;
    opts.agent = new HttpsProxyAgent(proxyUrl);
  }
  return new wsMod.WebSocket(url, opts);
}

/** HTTP(S) proxy URL from env, for cycletls requests. */
export function reqProxy(): string | undefined {
  const v = process.env["MUSE_HTTP_PROXY"];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}
