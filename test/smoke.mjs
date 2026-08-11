/**
 * Smoke test: vault write/read, lexical search, hybrid ranking (no embedder),
 * daemon lifecycle, inject formatting, pending queue, secrets gate, dedup.
 * No LLM and no embedding model — runs anywhere in seconds.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recollect-smoke-"));
const vault = path.join(tmp, "vault");
process.env.RECOLLECT_CONFIG_DIR = path.join(tmp, "config");
process.env.RECOLLECT_VAULT = vault;
process.env.RECOLLECT_NO_EMBED = "1";
process.env.HOME = tmp; // keep the derived cache inside the sandbox too

const { writeFact, listFacts, getFact, applySupersedes, newId } = await import(
  path.join(root, "src/vault.mjs")
);
const { loadConfig } = await import(path.join(root, "src/config.mjs"));
const { createContext, dispatch } = await import(path.join(root, "src/engine.mjs"));
const { hasSecret } = await import(path.join(root, "src/ingest/secrets.mjs"));
const { markPending, duePending, clearPending } = await import(
  path.join(root, "src/ingest/pending.mjs")
);
const { tokenize } = await import(path.join(root, "src/search/lexical.mjs"));

// --- vault ---
fs.mkdirSync(vault, { recursive: true });
execFileSync("git", ["init"], { cwd: vault, stdio: "ignore" });
const cfg = loadConfig();
assert.equal(cfg.vaultPath, vault);

const a = writeFact(vault, {
  type: "feedback",
  title: "항상 pnpm 을 사용한다",
  body: "npm 대신 pnpm 을 쓴다.\n\n**Why:** 모노레포 표준.\n\n**How to apply:** install 명령에 pnpm.",
  tags: ["tooling"],
});
const b = writeFact(vault, {
  type: "fact",
  title: "daemon port file is the source of truth",
  body: "The daemon always binds an ephemeral port and records it in daemon.json.",
  files: ["src/daemon/server.mjs"],
});
assert.equal(listFacts(vault).length, 2);
assert.ok(getFact(vault, a.id).title.includes("pnpm"));

// supersede flips frontmatter without moving the file
const c = writeFact(vault, { type: "feedback", title: "yarn 을 사용한다", body: "pnpm 대신 yarn." });
assert.equal(applySupersedes(vault, c.id, [a.id]), 1);
assert.equal(listFacts(vault).length, 2); // superseded fact hidden by default
assert.equal(getFact(vault, a.id).meta.superseded_by, c.id);

// --- tokenizer handles CJK ---
assert.ok(tokenize("데몬 포트").includes("데몬"));
assert.ok(tokenize("hybridSearch score-fusion").includes("fusion"));

// --- engine search / related / get ---
const ctx = createContext(cfg);
const search = await dispatch(ctx, { op: "search", query: "daemon port", k: 5 });
assert.ok(search.ok && search.hits[0].id === b.id, "lexical search finds the daemon fact");
const related = await dispatch(ctx, { op: "related", file: "/repo/src/daemon/server.mjs" });
assert.ok(related.hits.some((h) => h.id === b.id), "related_to_file matches by files frontmatter");
const got = await dispatch(ctx, { op: "get", id: b.id });
assert.ok(got.ok && got.fact.body.includes("ephemeral"));

// freshness: a new write is visible without rebuilding the context by hand
const d = writeFact(vault, { type: "fact", title: "minisearch bm25", body: "lexical index minisearch" });
const search2 = await dispatch(ctx, { op: "search", query: "minisearch", k: 5 });
assert.ok(search2.hits.some((h) => h.id === d.id), "write marker triggers rebuild");

// --- secrets gate ---
assert.ok(hasSecret("token = ghp_" + "a".repeat(36)));
assert.ok(hasSecret("-----BEGIN RSA PRIVATE KEY-----"));
assert.ok(!hasSecret("the daemon binds an ephemeral port"));

// --- pending queue ---
const t = path.join(tmp, "fake-transcript.jsonl");
fs.writeFileSync(t, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
markPending({ session: "s1", transcript: t, cwd: tmp });
assert.equal(duePending({ quietMs: 10 * 60 * 1000 }).length, 0, "fresh transcript is not due");
const hourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
fs.utimesSync(t, hourAgo, hourAgo);
assert.equal(duePending({ quietMs: 10 * 60 * 1000 }).length, 1, "quiet transcript is due");
clearPending("s1");
assert.equal(duePending({ quietMs: 0 }).length, 0);

// --- inject formatting (inline path, no daemon) ---
const { inject } = await import(path.join(root, "src/inject.mjs"));
const profile = await inject(cfg, "session-start");
assert.ok(profile.includes("recollect memory profile"));
assert.ok(profile.includes("yarn"), "profile shows standing rules");
assert.ok(!profile.includes("항상 pnpm"), "superseded rule is not injected");

// --- daemon lifecycle ---
const bin = path.join(root, "bin", "recollect.mjs");
const daemon = spawn(process.execPath, [bin, "server", "run"], {
  env: process.env,
  stdio: "ignore",
});
const { cacheRoot } = await import(path.join(root, "src/config.mjs"));
const { callDaemon, daemonAlive } = await import(path.join(root, "src/daemon/client.mjs"));
const cacheDir = cacheRoot(cfg);
let alive = false;
for (let i = 0; i < 50 && !alive; i++) {
  await new Promise((r) => setTimeout(r, 100));
  alive = await daemonAlive(cacheDir);
}
assert.ok(alive, "daemon comes up");
const viaDaemon = await callDaemon(cacheDir, { op: "search", query: "daemon port", k: 3 });
assert.ok(viaDaemon?.ok && viaDaemon.hits[0].id === b.id, "daemon serves search");
await callDaemon(cacheDir, { op: "shutdown" });
await new Promise((r) => setTimeout(r, 300));
assert.ok(!(await daemonAlive(cacheDir)), "daemon shuts down");
daemon.kill("SIGKILL");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("smoke ok");
