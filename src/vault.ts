import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import matter from "gray-matter";

export const FACT_TYPES = [
  "fact",
  "feedback",
  "project",
  "procedural",
  "reference",
  "insight",
] as const;
export type FactType = (typeof FACT_TYPES)[number];

export interface FactMeta {
  id: string;
  type: string;
  title: string;
  created: string;
  is_latest?: boolean;
  superseded_by?: string;
  entities?: string[];
  files?: string[];
  tags?: string[];
  importance?: number;
  confidence?: number;
  project?: string;
  source_session?: string;
  supersedes?: string[];
  [key: string]: unknown;
}

export interface Fact {
  id: string;
  type: string;
  title: string;
  body: string;
  meta: FactMeta;
  file: string;
}

export interface FactInput {
  id?: string;
  type?: string;
  title?: string;
  body?: string;
  created?: string;
  entities?: string[];
  files?: string[];
  tags?: string[];
  importance?: number;
  confidence?: number;
  project?: string;
  source_session?: string;
  supersedes?: string[];
}

const factsDir = (vaultPath: string) => path.join(vaultPath, "facts");
// lives inside .git/ so it is never committed — a marker file in the vault
// itself would show up as churn in every sync commit
const markerPath = (vaultPath: string) => path.join(vaultPath, ".git", "recollect-lastwrite");
const legacyMarkerPath = (vaultPath: string) => path.join(vaultPath, ".recollect-lastwrite");

/** Touched on every write so the daemon can detect staleness without scanning. */
export function touchMarker(vaultPath: string): void {
  try {
    fs.writeFileSync(markerPath(vaultPath), String(Date.now()));
  } catch {
    /* best-effort — markerMtime falls back to directory mtimes */
  }
  try {
    fs.unlinkSync(legacyMarkerPath(vaultPath)); // clean up pre-0.2 marker
  } catch {
    /* already gone */
  }
}

/**
 * Freshness signal = max(marker, facts dirs). The marker covers in-place
 * edits (supersede flips) which don't change directory mtimes; the directory
 * mtimes cover changes that arrive without a marker touch (git pull from
 * another machine).
 */
export function markerMtime(vaultPath: string): number {
  let max = 0;
  const consider = (p: string) => {
    try {
      const m = fs.statSync(p).mtimeMs;
      if (m > max) max = m;
    } catch {
      /* missing path contributes nothing */
    }
  };
  consider(markerPath(vaultPath));
  const facts = factsDir(vaultPath);
  consider(facts);
  try {
    for (const d of fs.readdirSync(facts, { withFileTypes: true })) {
      if (d.isDirectory()) consider(path.join(facts, d.name));
    }
  } catch {
    /* no facts dir yet */
  }
  return max;
}

export function slugify(title: string): string {
  const s = String(title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "memory";
}

export function newId(title: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const rand = crypto.randomBytes(3).toString("hex");
  return `${date}-${time}-${rand}-${slugify(title)}`;
}

/** List every active fact in the vault. */
export function listFacts(
  vaultPath: string,
  { includeSuperseded = false }: { includeSuperseded?: boolean } = {}
): Fact[] {
  const root = factsDir(vaultPath);
  const out: Fact[] = [];
  let typeDirs: fs.Dirent[] = [];
  try {
    typeDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const dir of typeDirs) {
    const dirPath = path.join(root, dir.name);
    for (const name of fs.readdirSync(dirPath)) {
      if (!name.endsWith(".md")) continue;
      const file = path.join(dirPath, name);
      try {
        const parsed = matter(fs.readFileSync(file, "utf8"));
        const meta = (parsed.data || {}) as FactMeta;
        if (!includeSuperseded && meta.is_latest === false) continue;
        out.push({
          id: meta.id || name.replace(/\.md$/, ""),
          type: meta.type || dir.name,
          title: meta.title || "",
          body: parsed.content.trim(),
          meta,
          file,
        });
      } catch {
        /* skip broken note — never let one bad file take down the corpus */
      }
    }
  }
  return out;
}

export function getFact(vaultPath: string, id: string): Fact | null {
  return listFacts(vaultPath, { includeSuperseded: true }).find((f) => f.id === id) || null;
}

export function writeFact(vaultPath: string, fact: FactInput): { id: string; file: string } {
  const type: FactType = (FACT_TYPES as readonly string[]).includes(fact.type || "")
    ? (fact.type as FactType)
    : "fact";
  const id = fact.id || newId(fact.title || "");
  const dir = path.join(factsDir(vaultPath), type);
  fs.mkdirSync(dir, { recursive: true });
  const meta: FactMeta = {
    id,
    type,
    title: fact.title || "",
    created: fact.created || new Date().toISOString(),
    is_latest: true,
    ...(fact.entities?.length ? { entities: fact.entities } : {}),
    ...(fact.files?.length ? { files: fact.files } : {}),
    ...(fact.tags?.length ? { tags: fact.tags } : {}),
    ...(fact.importance ? { importance: fact.importance } : {}),
    ...(fact.confidence ? { confidence: fact.confidence } : {}),
    ...(fact.project ? { project: fact.project } : {}),
    ...(fact.source_session ? { source_session: fact.source_session } : {}),
    ...(fact.supersedes?.length ? { supersedes: fact.supersedes } : {}),
  };
  const file = path.join(dir, `${id}.md`);
  fs.writeFileSync(file, matter.stringify(`\n${(fact.body || "").trim()}\n`, meta));
  touchMarker(vaultPath);
  return { id, file };
}

/**
 * Mark old facts as superseded by flipping frontmatter only — the file never
 * moves, so links and git history stay intact.
 */
export function applySupersedes(
  vaultPath: string,
  newFactId: string,
  supersededIds: string[]
): number {
  let applied = 0;
  for (const oldId of supersededIds || []) {
    const old = getFact(vaultPath, oldId);
    if (!old || old.meta.is_latest === false) continue;
    try {
      const parsed = matter(fs.readFileSync(old.file, "utf8"));
      parsed.data.is_latest = false;
      parsed.data.superseded_by = newFactId;
      fs.writeFileSync(old.file, matter.stringify(parsed.content, parsed.data));
      applied++;
    } catch {
      /* best-effort */
    }
  }
  if (applied) touchMarker(vaultPath);
  return applied;
}

/** Normalized body used for mechanical exact-duplicate detection. */
export function normalizeForDedup(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[`*_#>\[\]()]/g, "")
    .trim();
}
