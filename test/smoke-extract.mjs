/**
 * Extraction pipeline smoke test with a stubbed extractor (no real LLM):
 * transcript digest → prompt build → JSON parse → secrets gate → dedup →
 * vault write → supersede resolution → git commit.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recollect-extract-"));
const vault = path.join(tmp, "vault");
process.env.RECOLLECT_CONFIG_DIR = path.join(tmp, "config");
process.env.RECOLLECT_VAULT = vault;
process.env.RECOLLECT_NO_EMBED = "1";
process.env.HOME = tmp;

fs.mkdirSync(vault, { recursive: true });
execFileSync("git", ["init"], { cwd: vault, stdio: "ignore" });
execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: vault });
execFileSync("git", ["config", "user.name", "smoke"], { cwd: vault });

const { writeFact, listFacts, getFact } = await import(path.join(root, "src/vault.mjs"));
const { loadConfig } = await import(path.join(root, "src/config.mjs"));

// pre-existing fact that the extractor will supersede
const old = writeFact(vault, { type: "feedback", title: "use npm", body: "use npm for installs" });

// fake extractor: emits a claude-CLI-style JSON envelope whose `result`
// contains the extraction JSON — including one secret-bearing candidate and
// one duplicate of the existing fact, both of which must be dropped
const extraction = {
  summary: "test session",
  facts: [
    {
      type: "feedback",
      title: "use pnpm not npm",
      body: "**Why:** repo standard.\n\n**How to apply:** always pnpm.",
      tags: ["tooling"],
      confidence: 0.9,
      supersedes: [old.id, "nonexistent-id"],
    },
    {
      type: "fact",
      title: "leaked credential",
      body: "token = ghp_" + "a".repeat(36),
      confidence: 0.95,
    },
    { type: "feedback", title: "use npm", body: "use npm for installs", confidence: 0.9 },
    { type: "fact", title: "low confidence guess", body: "maybe true", confidence: 0.4 },
  ],
};
const fake = path.join(tmp, "fake-claude.mjs");
fs.writeFileSync(
  fake,
  `process.stdin.resume();process.stdin.on("end",()=>{
     console.log(JSON.stringify({ result: ${JSON.stringify(JSON.stringify(extraction))} }));
   });process.stdin.on("data",()=>{});`
);
const shim = path.join(tmp, "fake-claude");
fs.writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${fake}\n`);
fs.chmodSync(shim, 0o755);
process.env.RECOLLECT_EXTRACTOR = shim;

// transcript must clear the too-small gate (>500 chars of digest)
const transcript = path.join(tmp, "session.jsonl");
const turns = [];
for (let i = 0; i < 20; i++) {
  turns.push(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: `please switch install docs to pnpm, iteration ${i}` },
    })
  );
  turns.push(
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `done, updated the docs to use pnpm (${i})` }],
      },
    })
  );
}
fs.writeFileSync(transcript, turns.join("\n"));

const { extractSession } = await import(path.join(root, "src/ingest/extract.mjs"));
const cfg = loadConfig();
const res = await extractSession(cfg, { transcript, session: "sess-1", cwd: tmp });

assert.equal(res.written, 1, `only the clean, novel fact is written (got ${JSON.stringify(res)})`);
const facts = listFacts(vault);
assert.equal(facts.length, 1, "old fact superseded, secret+dup+low-confidence dropped");
assert.equal(facts[0].title, "use pnpm not npm");
assert.equal(getFact(vault, old.id).meta.superseded_by, facts[0].id);

// vault was committed
const log = execFileSync("git", ["log", "--oneline"], { cwd: vault, encoding: "utf8" });
assert.ok(log.includes("recollect:"), "extraction committed to the vault");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("smoke-extract ok");
