import fs from "node:fs";

/**
 * Digest a Claude Code session transcript (.jsonl) into plain text for the
 * extractor. Tool outputs are aggressively truncated — they dominate byte
 * count but rarely contain memory-worthy signal, and oversized digests cause
 * deterministic context-overflow failures in the extractor model.
 */
const MAX_DIGEST_CHARS = 120_000;
const MAX_TOOL_RESULT_CHARS = 300;

export function digestTranscript(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const lines = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry?.message?.role || entry?.type;
    const content = entry?.message?.content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content === "string") {
      if (content.trim()) lines.push(`${role}: ${content.trim()}`);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "text" && block.text?.trim()) {
        lines.push(`${role}: ${block.text.trim()}`);
      } else if (block.type === "tool_use") {
        const input = JSON.stringify(block.input || {}).slice(0, 200);
        lines.push(`assistant→tool ${block.name}: ${input}`);
      } else if (block.type === "tool_result") {
        const text = (
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c) => c.text || "").join(" ")
              : ""
        ).slice(0, MAX_TOOL_RESULT_CHARS);
        if (text.trim()) lines.push(`tool result: ${text.trim()}`);
      }
    }
  }
  if (!lines.length) return null;
  let text = lines.join("\n");
  if (text.length > MAX_DIGEST_CHARS) {
    // keep head + tail; the middle of long sessions is mostly tool churn
    const head = text.slice(0, MAX_DIGEST_CHARS * 0.4);
    const tail = text.slice(-MAX_DIGEST_CHARS * 0.6);
    text = `${head}\n\n[... transcript truncated ...]\n\n${tail}`;
  }
  return text;
}
