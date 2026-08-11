// PreCompact + SessionEnd: run the (LLM) extraction, detached so the hook
// returns in milliseconds while the extractor works in the background.
import { disabled, readHookJson, spawnDetached, ingestArgs } from "./_recollect.mjs";

if (disabled()) process.exit(0);
const hook = await readHookJson();
if (hook.transcript_path) spawnDetached(ingestArgs(hook));
process.exit(0);
