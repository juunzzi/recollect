/**
 * Init onboarding smoke test: zero-arg local vault, --create-remote with a
 * stubbed gh (repo created + remote attached), and graceful degradation when
 * gh is missing/broken. No network required for assertions — the first push
 * is best-effort by design.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "recollect.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recollect-init-"));

const baseEnv = {
  ...process.env,
  HOME: tmp,
  RECOLLECT_CONFIG_DIR: path.join(tmp, "config"),
  RECOLLECT_NO_EMBED: "1",
  GIT_TERMINAL_PROMPT: "0",
};

const runInit = (args, env = {}) =>
  execFileSync(process.execPath, [bin, "init", ...args], {
    encoding: "utf8",
    env: { ...baseEnv, ...env },
    timeout: 60_000,
  });

// --- 1. zero-arg style init (explicit --vault to stay inside the sandbox) ---
const v1 = path.join(tmp, "vault-local");
const out1 = runInit(["--vault", v1]);
assert.ok(fs.existsSync(path.join(v1, "facts")), "facts/ created");
assert.ok(fs.existsSync(path.join(v1, ".git")), "vault is a git repo");
assert.ok(out1.includes("local only"), "reports local-only mode");
assert.ok(out1.includes("--create-remote"), "suggests the one-line remote upgrade");
const saved = JSON.parse(fs.readFileSync(path.join(tmp, "config", "config.json"), "utf8"));
assert.equal(saved.vaultPath, v1);

// --- 2. --create-remote with a stubbed gh: repo create + origin attach ---
const fakeBin = path.join(tmp, "fake-bin");
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(
  path.join(fakeBin, "gh"),
  `#!/bin/sh
case "$1" in
  api) echo "tester" ;;
  repo) exit 0 ;;
  *) exit 1 ;;
esac
`
);
fs.chmodSync(path.join(fakeBin, "gh"), 0o755);

const v2 = path.join(tmp, "vault-remote");
const out2 = runInit(["--vault", v2, "--create-remote"], {
  PATH: `${fakeBin}:${process.env.PATH}`,
});
const origin = execFileSync("git", ["remote", "get-url", "origin"], {
  cwd: v2,
  encoding: "utf8",
}).trim();
assert.equal(origin, "https://github.com/tester/recollect-vault.git", "origin attached from gh login");
assert.ok(out2.includes("tester/recollect-vault"), "reports the created repo");

// --- 3. --create-remote with broken gh: degrade to local-only, exit 0 ---
const brokenBin = path.join(tmp, "broken-bin");
fs.mkdirSync(brokenBin, { recursive: true });
fs.writeFileSync(path.join(brokenBin, "gh"), `#!/bin/sh\nexit 1\n`);
fs.chmodSync(path.join(brokenBin, "gh"), 0o755);

const v3 = path.join(tmp, "vault-degraded");
const out3 = runInit(["--vault", v3, "--create-remote"], {
  PATH: `${brokenBin}:${process.env.PATH}`,
});
assert.ok(out3.includes("local-only"), "explains the gh fallback");
assert.ok(fs.existsSync(path.join(v3, "facts")), "vault still created");
const remotes3 = execFileSync("git", ["remote"], { cwd: v3, encoding: "utf8" }).trim();
assert.equal(remotes3, "", "no remote attached when gh is unavailable");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("smoke-init ok");
