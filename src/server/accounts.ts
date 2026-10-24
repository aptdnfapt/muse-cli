// Account registry: N muse accounts, each with its own cookies, session and proxy.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AccountConfig {
  label?: string;
  /** Optional explicit override; when omitted the dir is derived: <dataDir>/accounts/<name>/ */
  dir?: string;
  proxy: string;
  cycle_tls_port: number;
}

export interface AccountsFile {
  [name: string]: AccountConfig;
}

/** AccountConfig with concrete file paths (what the runtime actually uses). */
export interface ResolvedAccount {
  name: string;
  label?: string | undefined;
  proxy: string;
  cycle_tls_port: number;
  credentials: string;
  session: string;
}

export class AccountRegistry {
  private accounts: AccountsFile;
  private path: string;

  constructor(path: string) {
    this.path = path;
    if (!existsSync(path)) {
      this.accounts = {};
      this.save();
    } else {
      this.accounts = JSON.parse(readFileSync(path, "utf-8")) as AccountsFile;
    }
  }

  /** Resolve an account's concrete file paths from its (abstract) config. */
  resolve(name: string): ResolvedAccount | null {
    const cfg = this.accounts[name];
    if (!cfg) return null;
    const dir = cfg.dir ?? `${process.env["MUSE_DATA_DIR"] ?? "./data"}/accounts/${name}`;
    return {
      name, label: cfg.label, proxy: cfg.proxy, cycle_tls_port: cfg.cycle_tls_port,
      credentials: `${dir}/credentials.json`, session: `${dir}/session.json`,
    };
  }

  list(): ResolvedAccount[] {
    return Object.keys(this.accounts)
      .map((n) => this.resolve(n))
      .filter((a): a is ResolvedAccount => a !== null);
  }

  get(name: string | undefined): ResolvedAccount | null {
    const n = name && name.trim() ? name.trim() : "muse1";
    return this.resolve(n);
  }

  add(name: string, cfg: AccountConfig): void {
    this.accounts[name] = { ...cfg };
    this.save();
    this.ensureDirs(name);
  }

  remove(name: string): boolean {
    if (!this.accounts[name]) return false;
    delete this.accounts[name];
    this.save();
    return true;
  }

  ensureDirs(name: string): void {
    const acct = this.resolve(name);
    if (!acct) return;
    for (const p of [acct.credentials, acct.session]) {
      const dir = dirname(p);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.accounts, null, 2));
  }
}
