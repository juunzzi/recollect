import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { digestTranscript } from "./transcript.js";
import { hasSecret } from "./secrets.js";
import {
  listFacts,
  writeFact,
  applySupersedes,
  normalizeForDedup,
  FACT_TYPES,
} from "../vault.js";
import { cacheRoot, type Config } from "../config.js";
import { getEmbedder, saveEmbedding } from "../search/embeddings.js";
import { syncVault } from "../gitsync.js";

const MAX_FACTS_PER_SESSION = 5;
const MIN_CONFIDENCE = 0.6;

export interface ExtractResult {
  written: number;
  skipped: boolean;
  reason?: string;
}

interface FactCandidate {
  type?: string;
  title?: string;
  body?: string;
  entities?: unknown[];
  files?: unknown[];
  tags?: unknown[];
  importance?: number;
  confidence?: number;
  supersedes?: string[];
}

const promptPath = () =>
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "prompts",
    "memory-extractor.md"
  );

/**
 * Run the extractor LLM via the local `claude` CLI (`claude -p`). This uses
 * the user's existing Claude subscription/login — no API key management.
 */
function runExtractor(cfg: Config, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json"];
    if (cfg.extractorModel) args.push("--model", cfg.extractorModel);
    let child;
    try {
      child = spawn(cfg.extractorCmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        // kill-switch for our own hooks: the spawned `claude -p` is a full
        // Claude Code session and would otherwise re-fire inject/ingest hooks
        // recursively (loop + cost amplification)
        env: { ...process.env, RECOLLECT_DISABLE: "1" },
      });
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("extractor timed out"));
    }, 180_000);
    let out = "";
    let errOut = "";
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (errOut += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`extractor exited ${code}: ${errOut.slice(0, 300)}`));
        return;
      }
      resolve(out);
    });
    child.stdin.end(prompt);
  });
}

/** Pull the first balanced JSON object out of model output. */
function parseJsonBlock(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = inString;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const projectLabel = (cwd: string): string => (cwd ? path.basename(cwd) : "");

/**
 * Extract memories from one session transcript and write them to the vault.
 */
export async function extractSession(
  cfg: Config,
  { transcript, session = "", cwd = "" }: { transcript: string; session?: string; cwd?: string }
): Promise<ExtractResult> {
  const digest = digestTranscript(transcript);
  if (!digest || digest.length < 500) {
    return { written: 0, skipped: true, reason: "transcript_too_small" };
  }

  const existing = listFacts(cfg.vaultPath);
  // corpus-aware context: the model can only emit resolvable `supersedes`
  // ids if the real ids are in the prompt — without this the version chain
  // is dead weight
  const recent = existing
    .slice()
    .sort((a, b) => String(b.meta.created).localeCompare(String(a.meta.created)))
    .slice(0, 15)
    .map((f) => `- [${f.type}] id: ${f.id} — ${f.title}`)
    .join("\n");

  const template = fs.readFileSync(promptPath(), "utf8");
  const prompt = template
    .replace("{{EXISTING_MEMORIES}}", recent || "(none yet)")
    .replace("{{PROJECT}}", projectLabel(cwd) || "(unknown)")
    .replace("{{TRANSCRIPT}}", digest);

  const rawOut = await runExtractor(cfg, prompt);
  let resultText = rawOut;
  const envelope = parseJsonBlock(rawOut);
  if (envelope && typeof envelope.result === "string") resultText = envelope.result;
  const parsed = parseJsonBlock(resultText);
  if (!parsed || !Array.isArray(parsed.facts)) return { written: 0, skipped: true, reason: "no_parse" };

  const seen = new Set(existing.map((f) => normalizeForDedup(f.title + " " + f.body)));
  const liveIds = new Set(existing.map((f) => f.id));
  let written = 0;
  const writtenFacts: Array<{ id: string; text: string }> = [];
  for (const cand of (parsed.facts as FactCandidate[]).slice(0, MAX_FACTS_PER_SESSION * 2)) {
    if (written >= MAX_FACTS_PER_SESSION) break;
    if (!cand?.body || !cand?.title) continue;
    if ((cand.confidence ?? 0) < MIN_CONFIDENCE) continue;
    if (hasSecret(cand.title) || hasSecret(cand.body)) continue;
    const key = normalizeForDedup(cand.title + " " + cand.body);
    if (seen.has(key)) continue;
    seen.add(key);
    const { id } = writeFact(cfg.vaultPath, {
      type: (FACT_TYPES as readonly string[]).includes(cand.type || "") ? cand.type : "fact",
      title: String(cand.title).slice(0, 120),
      body: String(cand.body).slice(0, 4000),
      entities: (cand.entities || []).slice(0, 8).map(String),
      files: (cand.files || []).slice(0, 8).map(String),
      tags: (cand.tags || []).slice(0, 8).map(String),
      importance: cand.importance,
      confidence: cand.confidence,
      project: projectLabel(cwd),
      source_session: session,
    });
    const supersedes = (cand.supersedes || []).filter((sid) => liveIds.has(sid));
    if (supersedes.length) applySupersedes(cfg.vaultPath, id, supersedes);
    written++;
    writtenFacts.push({ id, text: `${cand.title}\n${cand.body}` });
  }

  // embedding write-through (best-effort — reindex backfills on failure)
  if (writtenFacts.length) {
    try {
      const embed = await getEmbedder();
      if (embed) {
        const cacheDir = cacheRoot(cfg);
        for (const f of writtenFacts) {
          saveEmbedding(cacheDir, f.id, await embed(f.text, "passage"));
        }
      }
    } catch {
      /* backfilled later by `recollect reindex` */
    }
  }

  if (written && cfg.gitSync) {
    syncVault(
      cfg.vaultPath,
      `recollect: ${written} memories from session ${session.slice(0, 8) || "manual"}`
    );
  }
  return { written, skipped: false };
}
