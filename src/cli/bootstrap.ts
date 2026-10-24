import { bootstrap } from "../bootstrap/session.js";
import { shutdownTls } from "../hatch/tls.js";
import { logger } from "../log.js";
import { AccountRegistry } from "../server/accounts.js";

const name = process.argv[2]; // optional account name; default muse1
const acct = new AccountRegistry(process.env["MUSE_ACCOUNTS_FILE"] ?? "data/accounts.json").get(name);
if (!acct) {
  logger.error({ account: name ?? "muse1" }, "unknown account");
  process.exitCode = 1;
} else {
  try {
    const s = await bootstrap({ storageStatePath: acct.credentials, sessionPath: acct.session });
    logger.info({ vm_id: s.vm_id, out: acct.session, account: acct.name }, "bootstrap OK");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: msg, account: acct.name }, "bootstrap failed");
    process.exitCode = 1;
  } finally {
    await shutdownTls();
  }
}
