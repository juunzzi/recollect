#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).catch((err) => {
  console.error(`recollect: ${err?.message || err}`);
  process.exit(1);
});
