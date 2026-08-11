import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cacheRoot, type Config } from "./config.js";
import { createContext, dispatch, type EngineContext, type RpcRequest, type RpcResponse } from "./engine.js";
import { callDaemon } from "./daemon/client.js";
import { writeFact, FACT_TYPES } from "./vault.js";
import { getEmbedder, saveEmbedding } from "./search/embeddings.js";
import { syncVault } from "./gitsync.js";

/**
 * MCP stdio server. Reads go daemon-first (shared warm index); if the daemon
 * is down we keep a lazily-created in-process context for the life of this
 * MCP process. Writes always run in-process.
 */
export async function runMcp(cfg: Config): Promise<void> {
  let inlineCtx: EngineContext | null = null;
  const query = async (payload: RpcRequest): Promise<RpcResponse> => {
    const viaDaemon = await callDaemon(cacheRoot(cfg), payload);
    if (viaDaemon?.ok) return viaDaemon;
    if (!inlineCtx) inlineCtx = createContext(cfg);
    return dispatch(inlineCtx, payload);
  };
  const asText = (obj: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  });

  const server = new McpServer({ name: "recollect", version: "0.1.0" });

  server.registerTool(
    "search",
    {
      description:
        "Search personal session memories (hybrid BM25 + embeddings). Use before starting work, when debugging, or when asking 'have I dealt with this before?'.",
      inputSchema: { query: z.string(), k: z.number().optional() },
    },
    async ({ query: q, k }) => {
      const res = await query({ op: "search", query: q, k: k || 8 });
      return asText(res.ok && "hits" in res ? res.hits : []);
    }
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
    async ({ file }) => {
      const res = await query({ op: "related", file, k: 5 });
      return asText(res.ok && "hits" in res ? res.hits : []);
    }
  );

  server.registerTool(
    "remember",
    {
      description:
        "Save a memory immediately (no LLM). Use when the user says 'remember this' or states a durable preference/decision.",
      inputSchema: {
        text: z.string(),
        title: z.string().optional(),
        type: z.enum(FACT_TYPES).optional(),
      },
    },
    async ({ text, title, type }) => {
      const t = (title || text.split(/[.!?\n]/)[0] || "").slice(0, 120);
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
