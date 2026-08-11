import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cacheRoot } from "./config.mjs";
import { createContext, dispatch } from "./engine.mjs";
import { callDaemon } from "./daemon/client.mjs";
import { writeFact } from "./vault.mjs";
import { getEmbedder, saveEmbedding } from "./search/embeddings.mjs";
import { syncVault } from "./gitsync.mjs";

/**
 * MCP stdio server. Reads go daemon-first (shared warm index); if the daemon
 * is down we keep a lazily-created in-process context for the life of this
 * MCP process. Writes always run in-process.
 */
export async function runMcp(cfg) {
  let inlineCtx = null;
  const query = async (payload) => {
    const viaDaemon = await callDaemon(cacheRoot(cfg), payload);
    if (viaDaemon?.ok) return viaDaemon;
    if (!inlineCtx) inlineCtx = createContext(cfg);
    return dispatch(inlineCtx, payload);
  };
  const asText = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

  const server = new McpServer({ name: "recollect", version: "0.1.0" });

  server.registerTool(
    "search",
    {
      description:
        "Search personal session memories (hybrid BM25 + embeddings). Use before starting work, when debugging, or when asking 'have I dealt with this before?'.",
      inputSchema: { query: z.string(), k: z.number().optional() },
    },
    async ({ query: q, k }) => asText((await query({ op: "search", query: q, k: k || 8 })).hits || [])
  );

  server.registerTool(
    "get",
    {
      description: "Fetch the full text of one memory by id.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => asText(await query({ op: "get", id }))
  );

  server.registerTool(
    "related_to_file",
    {
      description: "Memories tied to a specific file path (past bugs, gotchas, decisions).",
      inputSchema: { file: z.string() },
    },
    async ({ file }) => asText((await query({ op: "related", file, k: 5 })).hits || [])
  );

  server.registerTool(
    "remember",
    {
      description:
        "Save a memory immediately (no LLM). Use when the user says 'remember this' or states a durable preference/decision.",
      inputSchema: {
        text: z.string(),
        title: z.string().optional(),
        type: z.enum(["fact", "feedback", "project", "procedural", "reference", "insight"]).optional(),
      },
    },
    async ({ text, title, type }) => {
      const t = (title || text.split(/[.!?\n]/)[0]).slice(0, 120);
      const { id } = writeFact(cfg.vaultPath, { type: type || "fact", title: t, body: text });
      try {
        const embed = await getEmbedder();
        if (embed) saveEmbedding(cacheRoot(cfg), id, await embed(`${t}\n${text}`, "passage"));
      } catch {
        /* reindex later */
      }
      if (cfg.gitSync) syncVault(cfg.vaultPath, "recollect: manual memory (mcp)");
      return asText({ saved: id });
    }
  );

  await server.connect(new StdioServerTransport());
}
