import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface SyncResult {
  synced: boolean;
  pushed?: boolean;
  reason?: string;
}

const git = (vaultPath: string, args: string[], opts: { timeout?: number } = {}): string =>
  execFileSync("git", args, {
    cwd: vaultPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeout ?? 30_000,
    // never let a credential prompt hang a hook or the daemon's sync
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();

const isRepo = (vaultPath: string) => fs.existsSync(path.join(vaultPath, ".git"));

const hasRemote = (vaultPath: string): boolean => {
  try {
    return git(vaultPath, ["remote"]).length > 0;
  } catch {
    return false;
  }
};

/** Persisted sync health, read by the injection banner. Lives in .git/ (never committed). */
export interface SyncState {
  failStreak: number;
  lastSyncedAt: number;
  lastReason?: string;
  warnedAt?: number;
}

const statePath = (vaultPath: string) => path.join(vaultPath, ".git", "recollect-sync-state.json");

export function readSyncState(vaultPath: string): SyncState {
  try {
    return { failStreak: 0, lastSyncedAt: 0, ...JSON.parse(fs.readFileSync(statePath(vaultPath), "utf8")) };
  } catch {
    return { failStreak: 0, lastSyncedAt: 0 };
  }
}

function writeSyncState(vaultPath: string, state: SyncState): void {
  try {
    fs.writeFileSync(statePath(vaultPath), JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

/** Remember that the user was warned, to throttle mid-session repeats. */
export function markSyncWarned(vaultPath: string): void {
  writeSyncState(vaultPath, { ...readSyncState(vaultPath), warnedAt: Date.now() });
}

const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Best-effort vault sync: commit → pull --rebase → push. Single-user design —
 * on any conflict we abort the rebase and leave the local commit for the next
 * attempt rather than trying to auto-resolve. Never throws.
 */
export function syncVault(vaultPath: string, message = "recollect: update memories"): SyncResult {
  if (!isRepo(vaultPath)) return { synced: false, reason: "not_a_repo" };
  const lock = path.join(vaultPath, ".git", "recollect-sync.lock");
  const takeLock = (): boolean => {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      return true;
    } catch {
      return false;
    }
  };
  if (!takeLock()) {
    // GC a lock left behind by a crashed sync — otherwise every future sync
    // silently returns "locked" forever
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
    } catch {
      /* lock vanished — retry below */
    }
    if (!takeLock()) return { synced: false, reason: "locked" };
  }
  const record = (result: SyncResult): SyncResult => {
    const prev = readSyncState(vaultPath);
    if (result.synced) {
      writeSyncState(vaultPath, { ...prev, failStreak: 0, lastSyncedAt: Date.now(), lastReason: undefined });
    } else {
      writeSyncState(vaultPath, { ...prev, failStreak: prev.failStreak + 1, lastReason: result.reason });
    }
    return result;
  };
  try {
    try {
      if (git(vaultPath, ["status", "--porcelain"])) {
        git(vaultPath, ["add", "-A"]);
        git(vaultPath, ["commit", "-m", message, "--no-verify"]);
      }
    } catch {
      return record({ synced: false, reason: "commit_failed" });
    }
    if (!hasRemote(vaultPath)) return record({ synced: true, pushed: false });
    try {
      git(vaultPath, ["pull", "--rebase", "--no-edit"], { timeout: 60_000 });
    } catch {
      try {
        git(vaultPath, ["rebase", "--abort"]);
      } catch {
        /* no rebase in progress */
      }
      return record({ synced: false, reason: "pull_conflict" });
    }
    try {
      git(vaultPath, ["push"], { timeout: 60_000 });
      return record({ synced: true, pushed: true });
    } catch {
      return record({ synced: false, reason: "push_failed" });
    }
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* ok */
    }
  }
}
