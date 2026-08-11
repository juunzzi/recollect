import path from "node:path";
import { cacheRoot } from "./config.mjs";
import { listFacts, getFact, markerMtime } from "./vault.mjs";
import { buildIndex } from "./search/lexical.mjs";
import { getEmbedder, loadEmbeddings } from "./search/embeddings.mjs";
import { hybridSearch } from "./search/hybrid.mjs";

/**
 * A warm search context over one vault. Used identically by the daemon, the
 * MCP server, and the inline CLI fallback — one code path, three transports.
 */
export function createContext(cfg, { embeddings = true } = {}) {
  const ctx = {
    cfg,
    cacheDir: cacheRoot(cfg),
    facts: [],
    index: null,
    embMap: new Map(),
    embedQuery: null,
    builtAt: 0,
    useEmbeddings: embeddings,
  };
  rebuild(ctx);
  return ctx;
}

function rebuild(ctx) {
  ctx.facts = listFacts(ctx.cfg.vaultPath);
  ctx.index = buildIndex(ctx.facts);
  ctx.embMap = ctx.useEmbeddings ? loadEmbeddings(ctx.cacheDir) : new Map();
  ctx.builtAt = Date.now();
}

/** Cheap staleness check via the vault write marker; rebuild when stale. */
export function ensureFresh(ctx) {
  if (markerMtime(ctx.cfg.vaultPath) > ctx.builtAt) rebuild(ctx);
}

async function embedQueryFn(ctx) {
  if (!ctx.useEmbeddings || ctx.embMap.size === 0) return null;
  if (!ctx.embedQuery) ctx.embedQuery = await getEmbedder();
  return ctx.embedQuery;
}

export async function opSearch(ctx, { query, k = 8 }) {
  ensureFresh(ctx);
  const embedQuery = await embedQueryFn(ctx);
  const hits = await hybridSearch({
    facts: ctx.facts,
    index: ctx.index,
    embMap: ctx.embMap,
    embedQuery,
    query,
    k,
  });
  const byId = new Map(ctx.facts.map((f) => [f.id, f]));
  return hits
    .map((h) => ({ ...h, fact: byId.get(h.id) }))
    .filter((h) => h.fact)
    .map((h) => ({
      id: h.id,
      score: Number(h.score.toFixed(4)),
      via: h.via,
      type: h.fact.type,
      title: h.fact.title,
      body: h.fact.body,
      meta: h.fact.meta,
    }));
}

/** Facts related to a file path: frontmatter `files` suffix match first, then lexical. */
export async function opRelated(ctx, { file, k = 4 }) {
  ensureFresh(ctx);
  const norm = String(file || "").replace(/\\/g, "/");
  const direct = [];
  for (const f of ctx.facts) {
    for (const p of f.meta.files || []) {
      const fp = String(p).replace(/\\/g, "/");
      if (norm.endsWith(fp) || fp.endsWith(norm) || (fp.length > 8 && norm.includes(fp))) {
        direct.push({ id: f.id, score: 1, via: "files", type: f.type, title: f.title, body: f.body, meta: f.meta });
        break;
      }
    }
  }
  if (direct.length >= k) return direct.slice(0, k);
  const segments = norm.split("/").filter(Boolean).slice(-3).join(" ");
  const rest = segments
    ? (await opSearch(ctx, { query: segments, k })).filter(
        (h) => h.score >= 0.5 && !direct.some((d) => d.id === h.id)
      )
    : [];
  return [...direct, ...rest].slice(0, k);
}

export function opGet(ctx, { id }) {
  const fact = getFact(ctx.cfg.vaultPath, id);
  if (!fact) return null;
  return { id: fact.id, type: fact.type, title: fact.title, body: fact.body, meta: fact.meta };
}

export function opStatus(ctx) {
  ensureFresh(ctx);
  const byType = {};
  for (const f of ctx.facts) byType[f.type] = (byType[f.type] || 0) + 1;
  return {
    ok: true,
    pid: process.pid,
    vault: ctx.cfg.vaultPath,
    facts: ctx.facts.length,
    byType,
    embeddings: ctx.embMap.size,
    builtAt: ctx.builtAt,
  };
}

/** Transport-neutral dispatcher shared by daemon HTTP, MCP, and inline CLI. */
export async function dispatch(ctx, req) {
  switch (req.op) {
    case "search":
      return { ok: true, hits: await opSearch(ctx, req) };
    case "related":
      return { ok: true, hits: await opRelated(ctx, req) };
    case "get": {
      const fact = opGet(ctx, req);
      return fact ? { ok: true, fact } : { ok: false, reason: "not_found" };
    }
    case "status":
      return opStatus(ctx);
    default:
      return { ok: false, reason: `unknown op: ${req.op}` };
  }
}
