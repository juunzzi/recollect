import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  loadConfig,
  saveConfig,
  requireVault,
  cacheRoot,
  disabled,
  type Config,
} from "./config.js";
import { listFacts, writeFact, getFact, touchMarker } from "./vault.js";
import { createContext, dispatch, type RpcRequest, type RpcResponse } from "./engine.js";
import { callDaemon, daemonAlive, ensureDaemon } from "./daemon/client.js";
import { runDaemon, readDaemonInfo } from "./daemon/server.js";
import { inject } from "./inject.js";
import { markPending, clearPending, duePending } from "./ingest/pending.js";
import { extractSession } from "./ingest/extract.js";
import { syncVault } from "./gitsync.js";
import {
  getEmbedder,
  loadEmbeddings,
  saveEmbedding,
  pruneEmbeddings,
} from "./search/embeddings.js";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function queryEngine(cfg: Config, payload: RpcRequest): Promise<RpcResponse> {
  const viaDaemon = await callDaemon(cacheRoot(cfg), payload);
  if (viaDaemon?.ok) return viaDaemon;
  const ctx = createContext(cfg);
  return dispatch(ctx, payload);
}

const hitsOf = (res: RpcResponse) => (res.ok && "hits" in res ? res.hits : []);

const HELP = `recollect — personal session memory for Claude Code

  init --vault <path> [--remote <git-url>]   set up the vault (clones remote if given)
  search <query> [--k N] [--json]            hybrid search over memories
  get <id>                                   print one memory
  related --file <path> [--json]             memories tied to a file
  remember <text> [--type t] [--title s]     save a memory manually (no LLM)
  ingest --transcript <p> [--session s] [--cwd d]  extract memories from a transcript
  ingest --catchup                           extract from sessions that ended quietly
  inject --event <e>                         (hook entry) print context for an event
  server <run|ensure|stop|status>            manage the warm search daemon
  mcp                                        run the MCP stdio server
  reindex                                    backfill/prune local embeddings
  sync                                       git commit/pull/push the vault
  status                                     show vault + daemon status

Env: RECOLLECT_VAULT, RECOLLECT_DISABLE=1, RECOLLECT_NO_EMBED=1, RECOLLECT_EXTRACTOR(_MODEL)`;

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);
  const cfg = loadConfig();

  switch (command) {
    case "init": {
      // zero-argument init must just work: default to ~/recollect-vault
      const vault = String(flags.vault || cfg.vaultPath || "~/recollect-vault");
      const vaultPath = path.resolve(vault.replace(/^~(?=$|\/)/, process.env.HOME || ""));
      const remote = flags.remote ? String(flags.remote) : "";
      if (!fs.existsSync(vaultPath)) {
        if (remote) {
          execFileSync("git", ["clone", remote, vaultPath], { stdio: "inherit" });
        } else {
          fs.mkdirSync(vaultPath, { recursive: true });
        }
      }
      fs.mkdirSync(path.join(vaultPath, "facts"), { recursive: true });
      if (!fs.existsSync(path.join(vaultPath, ".git"))) {
        execFileSync("git", ["init"], { cwd: vaultPath, stdio: "ignore" });
      }
      if (remote) {
        // attach the remote to an existing local vault too (re-running init is safe)
        const remotes = execFileSync("git", ["remote"], { cwd: vaultPath, encoding: "utf8" });
        if (!remotes.split("\n").includes("origin")) {
          execFileSync("git", ["remote", "add", "origin", remote], {
            cwd: vaultPath,
            stdio: "ignore",
          });
        }
      }
      saveConfig({ vaultPath, ...(remote ? { remote } : {}) });
      touchMarker(vaultPath);
      syncVault(vaultPath, "recollect: init vault");
      if (remote) {
        try {
          execFileSync("git", ["push", "-u", "origin", "HEAD"], {
            cwd: vaultPath,
            stdio: "ignore",
            timeout: 60_000,
          });
        } catch {
          console.log("note: could not push to the remote yet — check access, then run `recollect sync`");
        }
      }
      console.log(`vault ready at ${vaultPath}${remote ? ` (remote: ${remote})` : " (local only)"}`);
      if (!remote) {
        console.log(`\ntip: back your memories with a PRIVATE repo so they sync across machines:`);
        console.log(`  gh repo create <you>/recollect-vault --private`);
        console.log(`  recollect init --remote git@github.com:<you>/recollect-vault.git`);
      }
      console.log(`\nif the Claude Code plugin is not installed yet:`);
      console.log(`  claude plugin marketplace add juunzzi/recollect`);
      console.log(`  claude plugin install recollect@recollect`);
      return;
    }

    case "search": {
      requireVault(cfg);
      const q = positional.join(" ");
      if (!q) throw new Error("usage: recollect search <query>");
      const res = await queryEngine(cfg, { op: "search", query: q, k: Number(flags.k || 8) });
      const hits = hitsOf(res);
      if (flags.json) {
        console.log(JSON.stringify(hits, null, 2));
        return;
      }
      for (const h of hits) console.log(`${h.score.toFixed(3)} [${h.type}] ${h.title}  (${h.id})`);
      return;
    }

    case "get": {
      requireVault(cfg);
      const id = positional[0];
      if (!id) throw new Error("usage: recollect get <id>");
      const fact = getFact(cfg.vaultPath, id);
      if (!fact) throw new Error(`not found: ${id}`);
      console.log(`# [${fact.type}] ${fact.title}\n\n${fact.body}`);
      return;
    }

    case "related": {
      requireVault(cfg);
      if (!flags.file) throw new Error("usage: recollect related --file <path>");
      const res = await queryEngine(cfg, { op: "related", file: String(flags.file), k: 5 });
      const hits = hitsOf(res);
      if (flags.json) {
        console.log(JSON.stringify(hits, null, 2));
        return;
      }
      for (const h of hits) console.log(`[${h.type}] ${h.title}  (${h.id})`);
      return;
    }

    case "remember": {
      requireVault(cfg);
      const text = positional.join(" ");
      if (!text) throw new Error("usage: recollect remember <text>");
      const title = String(flags.title || text.split(/[.!?\n]/)[0]).slice(0, 120);
      const { id } = writeFact(cfg.vaultPath, {
        type: String(flags.type || "fact"),
        title,
        body: text,
      });
      try {
        const embed = await getEmbedder();
        if (embed) saveEmbedding(cacheRoot(cfg), id, await embed(`${title}\n${text}`, "passage"));
      } catch {
        /* reindex later */
      }
      if (cfg.gitSync) syncVault(cfg.vaultPath, "recollect: manual memory");
      console.log(`saved ${id}`);
      return;
    }

    case "inject": {
      if (disabled()) return;
      try {
        const out = await inject(cfg, String(flags.event || ""));
        if (out) process.stdout.write(out);
      } catch {
        /* injection must never break a session — empty output, exit 0 */
      }
      return;
    }

    case "ingest": {
      if (disabled()) return;
      requireVault(cfg);
      if (flags.mark) {
        markPending({
          session: String(flags.session || ""),
          transcript: String(flags.transcript || ""),
          cwd: String(flags.cwd || ""),
        });
        return;
      }
      if (flags.catchup) {
        for (const entry of duePending()) {
          try {
            const res = await extractSession(cfg, entry);
            clearPending(entry.session);
            if (process.env.RECOLLECT_DEBUG) {
              console.error(`catchup ${entry.session}: ${JSON.stringify(res)}`);
            }
          } catch (err) {
            if (process.env.RECOLLECT_DEBUG) {
              console.error(`catchup failed: ${(err as Error).message}`);
            }
          }
        }
        return;
      }
      if (!flags.transcript) {
        throw new Error("usage: recollect ingest --transcript <path> [--session s] [--cwd d]");
      }
      const res = await extractSession(cfg, {
        transcript: String(flags.transcript),
        session: String(flags.session || ""),
        cwd: String(flags.cwd || ""),
      });
      clearPending(String(flags.session || ""));
      console.log(JSON.stringify(res));
      return;
    }

    case "server": {
      requireVault(cfg);
      const sub = positional[0] || "status";
      const cacheDir = cacheRoot(cfg);
      if (sub === "run") {
        const port = await runDaemon(cfg, cacheDir);
        if (process.env.RECOLLECT_DEBUG) console.error(`daemon on 127.0.0.1:${port}`);
        return new Promise<never>(() => {}); // stay alive until idle-exit/SIGTERM
      }
      if (sub === "ensure") {
        await ensureDaemon(cacheDir);
        return;
      }
      if (sub === "stop") {
        const res = await callDaemon(cacheDir, { op: "shutdown" });
        console.log(res ? "stopped" : "not running");
        return;
      }
      const alive = await daemonAlive(cacheDir);
      const info = readDaemonInfo(cacheDir);
      console.log(alive ? `running (pid ${info?.pid}, port ${info?.port})` : "not running");
      return;
    }

    case "mcp": {
      requireVault(cfg);
      const { runMcp } = await import("./mcp.js");
      await runMcp(cfg);
      return new Promise<never>(() => {});
    }

    case "reindex": {
      requireVault(cfg);
      const facts = listFacts(cfg.vaultPath);
      const cacheDir = cacheRoot(cfg);
      const existing = loadEmbeddings(cacheDir);
      const missing = facts.filter((f) => !existing.has(f.id));
      if (missing.length) {
        const embed = await getEmbedder();
        if (!embed) {
          console.log("embeddings unavailable (optional dependency not installed) — lexical-only mode");
          return;
        }
        for (const f of missing) {
          saveEmbedding(cacheDir, f.id, await embed(`${f.title}\n${f.body}`, "passage"));
        }
      }
      const pruned = pruneEmbeddings(cacheDir, new Set(facts.map((f) => f.id)));
      if (pruned) touchMarker(cfg.vaultPath);
      console.log(`embedded ${missing.length}, pruned ${pruned}, total facts ${facts.length}`);
      return;
    }

    case "sync": {
      requireVault(cfg);
      console.log(JSON.stringify(syncVault(cfg.vaultPath)));
      return;
    }

    case "status": {
      requireVault(cfg);
      const res = await queryEngine(cfg, { op: "status" });
      const alive = await daemonAlive(cacheRoot(cfg));
      console.log(
        JSON.stringify(
          { ...res, daemon: alive ? "running" : "stopped", vault: cfg.vaultPath },
          null,
          2
        )
      );
      return;
    }

    default:
      console.log(HELP);
  }
}
