import { disabled, readHookJson, spawnDetached, ingestArgs } from "./_recollect.mjs";

if (disabled()) process.exit(0);
const hook = await readHookJson();
if (hook.transcript_path) spawnDetached(ingestArgs(hook, ["--mark"]));
process.exit(0);
