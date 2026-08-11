import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createContext, dispatch, type RpcRequest } from "../engine.js";
import type { Config } from "../config.js";

const IDLE_EXIT_MS = 30 * 60 * 1000;

export const portFile = (cacheDir: string): string => path.join(cacheDir, "daemon.json");

export interface DaemonInfo {
  pid: number;
  port: number;
  started: number;
}

export function readDaemonInfo(cacheDir: string): DaemonInfo | null {
  try {
    return JSON.parse(fs.readFileSync(portFile(cacheDir), "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

/**
 * Foreground daemon: warm hybrid-search context on loopback HTTP.
 * Always binds an ephemeral port — the port file is the single source of truth.
 */
export async function runDaemon(cfg: Config, cacheDir: string): Promise<number> {
  const ctx = createContext(cfg);
  let idleTimer: NodeJS.Timeout | undefined;
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
    req.on("data", (c: string) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", async () => {
      let payload: RpcRequest = { op: "status" };
      try {
        payload = JSON.parse(raw) as RpcRequest;
      } catch {
        /* fall through to dispatch error */
      }
      let result;
      try {
        result = await dispatch(ctx, payload);
      } catch (err) {
        result = { ok: false as const, reason: String((err as Error)?.message || err) };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      if (payload.op === "shutdown") shutdown("rpc");
    });
  });

  const shutdown = (why: string) => {
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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  fs.writeFileSync(
    portFile(cacheDir),
    JSON.stringify({ pid: process.pid, port, started: Date.now() })
  );
  resetIdle();

  // Warm the embedder in the background so the first real search is fast.
  import("../search/embeddings.js").then((m) => m.getEmbedder()).catch(() => {});
  return port;
}
