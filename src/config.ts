import { z } from "zod";

const Schema = z.object({
  MUSE_PROXY_HOST:         z.string().default("127.0.0.1"),
  MUSE_PROXY_PORT:         z.coerce.number().int().positive().default(8787),
  MUSE_PROXY_KEY:          z.string().optional(),
  MUSE_PROXY_MODEL:        z.string().default("muse-spark"),
  MUSE_CYCLETLS_PORT:      z.coerce.number().int().positive().optional(),
  MUSE_AUTO_APPROVE:       z.enum(["off", "allow_once", "allow_always"]).default("off"),
  MUSE_DATA_DIR:           z.string().default("./data"),
  MUSE_TZ:                 z.string().default("Asia/Calcutta"),
  LOG_LEVEL:               z.enum(["fatal","error","warn","info","debug","trace"]).default("info"),
});

export interface Config {
  host: string; port: number; proxyKey: string | undefined;
  model: string;
  cycleTlsPort: number | undefined; autoApprove: "off" | "allow_once" | "allow_always";
  dataDir: string; timezone: string; logLevel: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Schema.parse(env);
  return {
    host: parsed.MUSE_PROXY_HOST, port: parsed.MUSE_PROXY_PORT,
    proxyKey: parsed.MUSE_PROXY_KEY, model: parsed.MUSE_PROXY_MODEL,
    cycleTlsPort: parsed.MUSE_CYCLETLS_PORT, autoApprove: parsed.MUSE_AUTO_APPROVE,
    dataDir: parsed.MUSE_DATA_DIR, timezone: parsed.MUSE_TZ, logLevel: parsed.LOG_LEVEL,
  };
}
