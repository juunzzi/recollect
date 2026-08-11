import { disabled, injectExec } from "./_recollect.mjs";

if (disabled()) process.exit(0);
injectExec("pre-tool-use");
