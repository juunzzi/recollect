import type MiniSearch from "minisearch";
import { cacheRoot, type Config } from "./config.js";
import { listFacts, getFact, markerMtime, type Fact, type FactMeta } from "./vault.js";
import { buildIndex } from "./search/lexical.js";
import { getEmbedder, loadEmbeddings, type EmbedFn } from "./search/embeddings.js";
import { hybridSearch } from "./search/hybrid.js";

export interface EngineContext {
  cfg: Config;
  cacheDir: string;
  facts: Fact[];
  index: MiniSearch;
  embMap: Map<string, Float32Array>;
  embedQuery: EmbedFn | null;
  builtAt: number;
  useEmbeddings: boolean;
}

export interface SearchHit {
  id: string;
  score: number;
  via: string;
  type: string;
  title: string;
  body: string;
  meta: FactMeta;
}

export type RpcRequest =
  | { op: "search"; query: string; k?: number }
  | { op: "related"; file: string; k?: number }
  | { op: "get"; id: string }
  | { op: "status" }
  | { op: "shutdown" };

export type RpcResponse =
  | { ok: true; hits: SearchHit[] }
  | { ok: true; fact: SearchHit }
  | (StatusResult & { ok: true })
  | { ok: false; reason: string };

export interface StatusResult {
  pid: number;
  vault: string;
  facts: number;
  byType: Record<string, number>;
  embeddings: number;
  builtAt: number;
}

/**
 * A warm search context over one vault. Used identically by the daemon, the
 * MCP server, and the inline CLI fallback — one code path, three transports.
 */
export function createContext(
  cfg: Config,
  { embeddings = true }: { embeddings?: boolean } = {}
): EngineContext {
  const ctx: EngineContext = {
    cfg,
    cacheDir: cacheRoot(cfg),
    facts: [],
    index: undefined as unknown as MiniSearch,
    embMap: new Map(),
    embedQuery: null,
    builtAt: 0,
    useEmbeddings: embeddings,
  };
  rebuild(ctx);
  return ctx;
}

function rebuild(ctx: EngineContext): void {
  ctx.facts = listFacts(ctx.cfg.vaultPath);
  ctx.index = buildIndex(ctx.facts);
  ctx.embMap = ctx.useEmbeddings ? loadEmbeddings(ctx.cacheDir) : new Map();
  ctx.builtAt = Date.now();
}

/** Cheap staleness check via the vault write marker; rebuild when stale. */
export function ensureFresh(ctx: EngineContext): void {
  if (markerMtime(ctx.cfg.vaultPath) > ctx.builtAt) rebuild(ctx);
}

async function embedQueryFn(ctx: EngineContext): Promise<EmbedFn | null> {
  if (!ctx.useEmbeddings || ctx.embMap.size === 0) return null;
  if (!ctx.embedQuery) ctx.embedQuery = await getEmbedder();
  return ctx.embedQuery;
}

export async function opSearch(
  ctx: EngineContext,
  { query, k = 8 }: { query: string; k?: number }
): Promise<SearchHit[]> {
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
  const out: SearchHit[] = [];
  for (const h of hits) {
    const fact = byId.get(h.id);
    if (!fact) continue;
    out.push({
      id: h.id,
      score: Number(h.score.toFixed(4)),
      via: h.via,
      type: fact.type,
      title: fact.title,
      body: fact.body,
      meta: fact.meta,
    });
  }
  return out;
}

/** Facts related to a file path: frontmatter `files` suffix match first, then lexical. */
export async function opRelated(
  ctx: EngineContext,
  { file, k = 4 }: { file: string; k?: number }
): Promise<SearchHit[]> {
  ensureFresh(ctx);
  const norm = String(file || "").replace(/\\/g, "/");
  const direct: SearchHit[] = [];
  for (const f of ctx.facts) {
    for (const p of f.meta.files || []) {
      const fp = String(p).replace(/\\/g, "/");
      if (norm.endsWith(fp) || fp.endsWith(norm) || (fp.length > 8 && norm.includes(fp))) {
        direct.push({
          id: f.id,
          score: 1,
          via: "files",
          type: f.type,
          title: f.title,
          body: f.body,
          meta: f.meta,
        });
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

export function opGet(ctx: EngineContext, { id }: { id: string }): SearchHit | null {
  const fact = getFact(ctx.cfg.vaultPath, id);
  if (!fact) return null;
  return {
    id: fact.id,
    score: 1,
    via: "get",
    type: fact.type,
    title: fact.title,
    body: fact.body,
    meta: fact.meta,
  };
}

export function opStatus(ctx: EngineContext): StatusResult & { ok: true } {
  ensureFresh(ctx);
  const byType: Record<string, number> = {};
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
export async function dispatch(ctx: EngineContext, req: RpcRequest): Promise<RpcResponse> {
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
      return { ok: false, reason: `unknown op: ${(req as { op?: string }).op}` };
  }
}
