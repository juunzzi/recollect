import fs from "node:fs";
import path from "node:path";
import { cacheRoot, type Config } from "./config.js";
import { createContext, dispatch, type RpcRequest, type RpcResponse, type SearchHit } from "./engine.js";
import { callDaemon } from "./daemon/client.js";
import { cutLowRelevance } from "./search/hybrid.js";
import { listFacts } from "./vault.js";

interface HookInput {
  session_id?: string;
  prompt?: string;
  tool_input?: { file_path?: string; notebook_path?: string };
  [key: string]: unknown;
}

/** Read the hook JSON from stdin with a hard guard so a hook can never hang. */
export function readHookInput(timeoutMs = 3000): Promise<HookInput> {
  return new Promise((resolve) => {
    let raw = "";
    const done = () => {
      try {
        resolve(JSON.parse(raw) as HookInput);
      } catch {
        resolve({});
      }
    };
    const guard = setTimeout(done, timeoutMs);
    if (process.stdin.isTTY || process.stdin.readableEnded) {
      clearTimeout(guard);
      resolve({});
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => (raw += c));
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

/**
 * Daemon-first query with inline fallback. Inline skips embeddings — a cold
 * model load would blow the hook latency budget; BM25-only is fine there.
 */
async function query(cfg: Config, payload: RpcRequest): Promise<RpcResponse | null> {
  const cacheDir = cacheRoot(cfg);
  const viaDaemon = await callDaemon(cacheDir, payload);
  if (viaDaemon?.ok) return viaDaemon;
  try {
    const ctx = createContext(cfg, { embeddings: false });
    return await dispatch(ctx, payload);
  } catch {
    return null;
  }
}

const hitsOf = (res: RpcResponse | null): SearchHit[] =>
  res && res.ok && "hits" in res ? res.hits : [];

/* per-session "already injected" filter so the same memory is not repeated */
const seenFile = (cacheDir: string, session: string) =>
  path.join(cacheDir, "seen", `${session}.json`);

function filterSeen(cfg: Config, session: string, hits: SearchHit[]): SearchHit[] {
  if (!session) return hits;
  const file = seenFile(cacheRoot(cfg), session);
  let seen: string[] = [];
  try {
    seen = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* first injection this session */
  }
  const fresh = hits.filter((h) => !seen.includes(h.id));
  if (fresh.length) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify([...seen, ...fresh.map((h) => h.id)].slice(-200)));
    } catch {
      /* best-effort */
    }
  }
  return fresh;
}

const GUARD =
  "> Personal memory recalled by recollect (reference only — may be stale; " +
  "trust current code over memory; silently ignore irrelevant items).";

function renderHits(hits: SearchHit[], { full = false }: { full?: boolean } = {}): string {
  return hits
    .map((h) => {
      const date = String(h.meta?.created || "").slice(0, 10);
      const firstLines = full ? h.body : h.body.split("\n").slice(0, 3).join(" ").slice(0, 400);
      return `- **[${h.type}]** ${h.title} _(${date}, id: \`${h.id}\`)_\n  ${firstLines}`;
    })
    .join("\n");
}

/**
 * When the engine is installed but the vault isn't usable yet, session-start
 * injects setup guidance instead of silently doing nothing — an open-source
 * install must explain itself. Other events stay silent.
 */
function setupBanner(cfg: Config): string {
  if (!cfg.vaultPath) {
    return (
      "## recollect: memory vault not set up\n" +
      "> The recollect plugin is installed but has no vault, so no memories are being " +
      "saved or recalled. One-time setup (tell the user; do not run it unprompted):\n" +
      ">\n" +
      "> 1. (recommended) create a **private** repo for the vault, e.g. `gh repo create <you>/recollect-vault --private`\n" +
      "> 2. `recollect init --remote git@github.com:<you>/recollect-vault.git` " +
      "(or just `recollect init` for a local-only vault at `~/recollect-vault`)\n"
    );
  }
  if (!fs.existsSync(cfg.vaultPath)) {
    return (
      "## recollect: vault missing\n" +
      `> Configured vault \`${cfg.vaultPath}\` does not exist on this machine. ` +
      "Tell the user to run `recollect init` (re-clones the remote if one was configured).\n"
    );
  }
  return "";
}

export async function inject(cfg: Config, event: string): Promise<string> {
  const hook = await readHookInput();
  const session = String(hook.session_id || "");

  if (event === "session-start") {
    const banner = setupBanner(cfg);
    if (banner) return banner;
    // profile is built from vault recency directly — no LLM, no daemon needed
    return sessionProfile(cfg);
  }

  if (!cfg.vaultPath || !fs.existsSync(cfg.vaultPath)) return "";

  if (event === "prompt-submit") {
    const prompt = String(hook.prompt || "").trim();
    if (prompt.length < 8) return "";
    const res = await query(cfg, { op: "search", query: prompt, k: cfg.injectLimit });
    let hits = cutLowRelevance(hitsOf(res));
    hits = filterSeen(cfg, session, hits).slice(0, cfg.injectLimit);
    if (!hits.length) return "";
    return `## recollect memory\n${GUARD}\n\n${renderHits(hits)}\n`;
  }

  if (event === "pre-tool-use") {
    const file = hook.tool_input?.file_path || hook.tool_input?.notebook_path || "";
    if (!file) return "";
    const res = await query(cfg, { op: "related", file, k: 3 });
    let hits = hitsOf(res);
    hits = filterSeen(cfg, session, hits);
    if (!hits.length) return "";
    const context = `## recollect memory for this file\n${GUARD}\n\n${renderHits(hits, { full: true })}\n`;
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context },
    });
  }

  return "";
}

/** Session-start profile: most recent memories, feedback (standing rules) pinned. */
function sessionProfile(cfg: Config): string {
  const facts = listFacts(cfg.vaultPath);
  if (!facts.length) return "";
  const byCreated = (a: { meta: { created: string } }, b: { meta: { created: string } }) =>
    String(b.meta.created).localeCompare(String(a.meta.created));
  const feedback = facts.filter((f) => f.type === "feedback").sort(byCreated).slice(0, 5);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = facts
    .filter((f) => f.type !== "feedback" && new Date(f.meta.created).getTime() > cutoff)
    .sort(byCreated)
    .slice(0, 8);
  if (!feedback.length && !recent.length) return "";
  const section = (title: string, items: typeof facts) =>
    items.length
      ? `\n### ${title}\n${items.map((f) => `- [${f.type}] ${f.title} _(id: \`${f.id}\`)_`).join("\n")}`
      : "";
  return (
    `## recollect memory profile\n${GUARD}\n` +
    section("Standing rules", feedback) +
    section("Recent (7 days)", recent) +
    `\n\n> Full text via MCP \`get\` (id above) or \`search\`.\n`
  );
}
