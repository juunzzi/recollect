import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config.mjs";

/**
 * Pending queue: every Stop hook cheaply marks "this session has new content".
 * Extraction happens later (SessionEnd/PreCompact, or catch-up on the next
 * SessionStart if the session died without firing SessionEnd). This keeps the
 * LLM cost at ~1 call per session instead of 1 per turn.
 */
const pendingFile = () => path.join(configDir(), "state", "pending.json");

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(pendingFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeAll(map) {
  const file = pendingFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 2));
}

export function markPending({ session, transcript, cwd }) {
  if (!session || !transcript) return;
  const map = readAll();
  map[session] = { transcript, cwd: cwd || "", marked: Date.now() };
  writeAll(map);
}

export function clearPending(session) {
  const map = readAll();
  if (map[session]) {
    delete map[session];
    writeAll(map);
  }
}

/**
 * Sessions ready for catch-up extraction: marked, and their transcript hasn't
 * changed for `quietMs` (the session is very likely over).
 */
export function duePending({ quietMs = 10 * 60 * 1000, limit = 3 } = {}) {
  const map = readAll();
  const due = [];
  const now = Date.now();
  for (const [session, entry] of Object.entries(map)) {
    let mtime = 0;
    try {
      mtime = fs.statSync(entry.transcript).mtimeMs;
    } catch {
      // transcript gone — drop the entry
      delete map[session];
      continue;
    }
    if (now - mtime >= quietMs) due.push({ session, ...entry });
  }
  writeAll(map);
  return due.sort((a, b) => a.marked - b.marked).slice(0, limit);
}
