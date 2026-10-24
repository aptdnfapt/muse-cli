import { loadConfig } from "./config.js";
import { start } from "./server/start.js";
const cfg = loadConfig();
const stop = await start(cfg);
for (const sig of ["SIGTERM","SIGINT"] as const) process.on(sig, async () => { await stop(); process.exit(0); });
