import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readDaemonInfo } from "./server.js";
import type { RpcResponse } from "../engine.js";

/**
 * Call the daemon; resolve null on ANY failure (not running, warming, timeout).
 * Callers fall back to an in-process context — same code path, just colder.
 */
export function callDaemon(
  cacheDir: string,
  payload: unknown,
  { connectMs = 250, respMs = 2000 }: { connectMs?: number; respMs?: number } = {}
): Promise<RpcResponse | null> {
  const info = readDaemonInfo(cacheDir);
  if (!info?.port) return Promise.resolve(null);
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: info.port,
        method: "POST",
        path: "/rpc",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: respMs,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (raw += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw) as RpcResponse);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.setTimeout(respMs, () => req.destroy());
    req.on("socket", (s: net.Socket) =>
      s.setTimeout(connectMs, () => {
        if (s.connecting) req.destroy();
      })
    );
    req.on("error", () => resolve(null));
    req.end(body);
  });
}

export async function daemonAlive(cacheDir: string): Promise<boolean> {
  const res = await callDaemon(cacheDir, { op: "status" }, { connectMs: 250, respMs: 500 });
  return !!res?.ok;
}

/** Idempotent lazy-spawn: probe, and if dead start a detached daemon. */
export async function ensureDaemon(cacheDir: string): Promise<boolean> {
  if (await daemonAlive(cacheDir)) return true;
  const bin = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "bin",
    "recollect.mjs"
  );
  try {
    const child = spawn(process.execPath, [bin, "server", "run"], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    return false;
  }
  return true;
}
