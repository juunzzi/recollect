import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createContext, dispatch } from "../engine.mjs";

const IDLE_EXIT_MS = 30 * 60 * 1000;

export const portFile = (cacheDir) => path.join(cacheDir, "daemon.json");

export function readDaemonInfo(cacheDir) {
  try {
    return JSON.parse(fs.readFileSync(portFile(cacheDir), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Foreground daemon: warm hybrid-search context on loopback HTTP.
 * Always binds an ephemeral port — the port file is the single source of truth.
 */
export async function runDaemon(cfg, cacheDir) {
  const ctx = createContext(cfg);
  let idleTimer = null;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => shutdown("idle"), IDLE_EXIT_MS);
  };

  const server = http.createServer((req, res) => {
    resetIdle();
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: process.pid, facts: ctx.facts.length }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/rpc") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", async () => {
      let payload = {};
      try {
        payload = JSON.parse(raw);
      } catch {
        /* fall through to dispatch error */
      }
      let result;
      try {
        result = await dispatch(ctx, payload);
      } catch (err) {
        result = { ok: false, reason: String(err?.message || err) };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      if (payload.op === "shutdown") shutdown("rpc");
    });
  });

  const shutdown = (why) => {
    try {
      fs.unlinkSync(portFile(cacheDir));
    } catch {
      /* ok */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
    if (process.env.RECOLLECT_DEBUG) console.error(`recollect daemon exiting (${why})`);
  };

  process.on("SIGTERM", () => shutdown("sigterm"));
  process.on("SIGINT", () => shutdown("sigint"));

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  fs.writeFileSync(portFile(cacheDir), JSON.stringify({ pid: process.pid, port, started: Date.now() }));
  resetIdle();

  // Warm the embedder in the background so the first real search is fast.
  import("../search/embeddings.mjs").then((m) => m.getEmbedder()).catch(() => {});
  return port;
}
