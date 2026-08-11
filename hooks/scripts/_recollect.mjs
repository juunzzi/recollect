/**
 * Shared helpers for the hook scripts. Hooks are thin triggers: all logic
 * lives in the `recollect` CLI (installed globally); hooks delegate and NEVER
 * fail the session — engine missing, daemon down, anything → exit 0.
 *
 * Written in node (not bash) because POSIX shells redirect stdin of
 * backgrounded commands to /dev/null, which silently starves hooks that need
 * the hook JSON from stdin.
 */
import { spawn } from "node:child_process";

export const disabled = () => process.env.RECOLLECT_DISABLE === "1";

const BIN = process.env.RECOLLECT_BIN || "recollect";

/** Delegate an inject event with inherited stdio (hook JSON in, context out). */
export function injectExec(event) {
  let child;
  try {
    child = spawn(BIN, ["inject", "--event", event], { stdio: "inherit" });
  } catch {
    process.exit(0);
  }
  child.on("error", () => process.exit(0));
  child.on("exit", (code) => process.exit(code ?? 0));
}

/** Read hook JSON from stdin with a guard so a hook can never hang. */
export function readHookJson(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let raw = "";
    const done = () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    };
    const guard = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      clearTimeout(guard);
      done();
    });
    process.stdin.on("error", () => {
      clearTimeout(guard);
      done();
    });
  });
}

/** Fire-and-forget engine call that outlives this hook process. */
export function spawnDetached(args) {
  try {
    const child = spawn(BIN, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best-effort */
  }
}

/** argv for `recollect ingest` built from a hook JSON payload. */
export function ingestArgs(hook, extra = []) {
  const args = ["ingest"];
  if (hook.transcript_path) args.push("--transcript", hook.transcript_path);
  if (hook.session_id) args.push("--session", hook.session_id);
  if (hook.cwd) args.push("--cwd", hook.cwd);
  return [...args, ...extra];
}
