import { disabled, injectExec, spawnDetached } from "./_recollect.mjs";

if (disabled()) process.exit(0);
spawnDetached(["server", "ensure"]); // warm daemon for this session's searches
spawnDetached(["ingest", "--catchup"]); // extract sessions that died quietly
spawnDetached(["reindex"]); // backfill embeddings for peer-pulled facts
injectExec("session-start");
