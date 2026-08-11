import fs from "node:fs";
import path from "node:path";

const MODEL = "Xenova/multilingual-e5-small"; // 384-dim, multilingual, runs fully offline
const DIM = 384;

let embedderPromise = null;

/**
 * Lazily load the local embedding pipeline. @huggingface/transformers is an
 * optional dependency — when missing or broken this resolves to null and the
 * caller degrades to lexical-only search. Never throws.
 */
export function getEmbedder() {
  if (process.env.RECOLLECT_NO_EMBED === "1") return Promise.resolve(null);
  if (!embedderPromise) {
    embedderPromise = (async () => {
      try {
        const { pipeline } = await import("@huggingface/transformers");
        const pipe = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
        // e5 models require a task prefix; keep it byte-stable for cache validity.
        return async (text, kind = "query") => {
          const out = await pipe(`${kind}: ${String(text).slice(0, 2000)}`, {
            pooling: "mean",
            normalize: true,
          });
          return Float32Array.from(out.data);
        };
      } catch {
        return null;
      }
    })();
  }
  return embedderPromise;
}

const embDir = (cacheDir) => path.join(cacheDir, "embeddings");

export function saveEmbedding(cacheDir, id, vec) {
  const dir = embDir(cacheDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.f32`), Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
}

/** Load all persisted vectors into memory: Map<id, Float32Array>. */
export function loadEmbeddings(cacheDir) {
  const map = new Map();
  let names = [];
  try {
    names = fs.readdirSync(embDir(cacheDir));
  } catch {
    return map;
  }
  for (const name of names) {
    if (!name.endsWith(".f32")) continue;
    try {
      const buf = fs.readFileSync(path.join(embDir(cacheDir), name));
      if (buf.length !== DIM * 4) continue;
      map.set(name.replace(/\.f32$/, ""), new Float32Array(buf.buffer, buf.byteOffset, DIM));
    } catch {
      /* skip unreadable vector */
    }
  }
  return map;
}

/** Remove vectors whose fact no longer exists (superseded/deleted). */
export function pruneEmbeddings(cacheDir, liveIds) {
  let names = [];
  try {
    names = fs.readdirSync(embDir(cacheDir));
  } catch {
    return 0;
  }
  let pruned = 0;
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith(".f32")) continue;
    const id = name.replace(/\.f32$/, "");
    if (liveIds.has(id)) continue;
    const file = path.join(embDir(cacheDir), name);
    try {
      // keep very recent files — they may belong to a concurrent write-through
      if (now - fs.statSync(file).mtimeMs < 60 * 60 * 1000) continue;
      fs.unlinkSync(file);
      pruned++;
    } catch {
      /* best-effort */
    }
  }
  return pruned;
}

/** Dot product of two L2-normalized vectors = cosine similarity. */
export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
