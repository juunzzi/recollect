import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const git = (vaultPath, args, opts = {}) =>
  execFileSync("git", args, {
    cwd: vaultPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    ...opts,
  }).trim();

const isRepo = (vaultPath) => fs.existsSync(path.join(vaultPath, ".git"));

const hasRemote = (vaultPath) => {
  try {
    return git(vaultPath, ["remote"]).length > 0;
  } catch {
    return false;
  }
};

/**
 * Best-effort vault sync: commit → pull --rebase → push. Single-user design —
 * on any conflict we abort the rebase and leave the local commit for the next
 * attempt rather than trying to auto-resolve. Never throws.
 */
export function syncVault(vaultPath, message = "recollect: update memories") {
  if (!isRepo(vaultPath)) return { synced: false, reason: "not_a_repo" };
  const lock = path.join(vaultPath, ".git", "recollect-sync.lock");
  try {
    const fd = fs.openSync(lock, "wx");
    fs.closeSync(fd);
  } catch {
    return { synced: false, reason: "locked" };
  }
  try {
    try {
      if (git(vaultPath, ["status", "--porcelain"])) {
        git(vaultPath, ["add", "-A"]);
        git(vaultPath, ["commit", "-m", message, "--no-verify"]);
      }
    } catch {
      return { synced: false, reason: "commit_failed" };
    }
    if (!hasRemote(vaultPath)) return { synced: true, pushed: false };
    try {
      git(vaultPath, ["pull", "--rebase", "--no-edit"], { timeout: 60_000 });
    } catch {
      try {
        git(vaultPath, ["rebase", "--abort"]);
      } catch {
        /* no rebase in progress */
      }
      return { synced: false, reason: "pull_conflict" };
    }
    try {
      git(vaultPath, ["push"], { timeout: 60_000 });
      return { synced: true, pushed: true };
    } catch {
      return { synced: false, reason: "push_failed" };
    }
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* ok */
    }
  }
}
