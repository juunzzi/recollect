import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import matter from "gray-matter";

export const FACT_TYPES = ["fact", "feedback", "project", "procedural", "reference", "insight"];

const factsDir = (vaultPath) => path.join(vaultPath, "facts");
const markerPath = (vaultPath) => path.join(vaultPath, ".recollect-lastwrite");

/** Touched on every write so the daemon can detect staleness without scanning. */
export function touchMarker(vaultPath) {
  try {
    fs.writeFileSync(markerPath(vaultPath), String(Date.now()));
  } catch {
    /* best-effort */
  }
}

export function markerMtime(vaultPath) {
  try {
    return fs.statSync(markerPath(vaultPath)).mtimeMs;
  } catch {
    return 0;
  }
}

export function slugify(title) {
  const s = String(title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "memory";
}

export function newId(title, now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const rand = crypto.randomBytes(3).toString("hex");
  return `${date}-${time}-${rand}-${slugify(title)}`;
}

/** List every active fact in the vault: [{id, type, title, body, meta, file}] */
export function listFacts(vaultPath, { includeSuperseded = false } = {}) {
  const root = factsDir(vaultPath);
  const out = [];
  let typeDirs = [];
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
        const meta = parsed.data || {};
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

export function getFact(vaultPath, id) {
  return listFacts(vaultPath, { includeSuperseded: true }).find((f) => f.id === id) || null;
}

export function writeFact(vaultPath, fact) {
  const type = FACT_TYPES.includes(fact.type) ? fact.type : "fact";
  const id = fact.id || newId(fact.title);
  const dir = path.join(factsDir(vaultPath), type);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
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
export function applySupersedes(vaultPath, newFactId, supersededIds) {
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
export function normalizeForDedup(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[`*_#>\[\]()]/g, "")
    .trim();
}
