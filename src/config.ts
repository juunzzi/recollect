import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface Config {
  vaultPath: string;
  gitSync: boolean;
  extractorCmd: string;
  extractorModel: string;
  injectLimit: number;
}

export const configDir = (): string =>
  process.env.RECOLLECT_CONFIG_DIR || path.join(os.homedir(), ".recollect");

const configFile = () => path.join(configDir(), "config.json");

const expandHome = (p: string): string => (p ? p.replace(/^~(?=$|\/)/, os.homedir()) : p);

export function loadConfig(): Config {
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    /* first run — config not written yet */
  }
  const vaultPath = process.env.RECOLLECT_VAULT || (file.vaultPath as string) || "";
  return {
    vaultPath: vaultPath ? path.resolve(expandHome(vaultPath)) : "",
    gitSync: process.env.RECOLLECT_GIT_SYNC === "0" ? false : file.gitSync !== false,
    extractorCmd: process.env.RECOLLECT_EXTRACTOR || (file.extractorCmd as string) || "claude",
    extractorModel:
      process.env.RECOLLECT_EXTRACTOR_MODEL || (file.extractorModel as string) || "",
    injectLimit: Number(process.env.RECOLLECT_INJECT_LIMIT || file.injectLimit || 5),
  };
}

export function saveConfig(patch: Record<string, unknown>): Record<string, unknown> {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    /* ok */
  }
  const next = { ...file, ...patch };
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

export function requireVault(cfg: Config): void {
  if (!cfg.vaultPath) {
    throw new Error("no vault configured — run `recollect init --vault <path>` first");
  }
  if (!fs.existsSync(cfg.vaultPath)) {
    throw new Error(`vault not found at ${cfg.vaultPath} — run \`recollect init\``);
  }
}

/** Derived-data root for this vault. Safe to delete at any time. */
export function cacheRoot(cfg: Config): string {
  const fp = crypto.createHash("sha1").update(cfg.vaultPath).digest("hex").slice(0, 12);
  const dir = path.join(os.homedir(), ".cache", "recollect", fp);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const disabled = (): boolean => process.env.RECOLLECT_DISABLE === "1";
