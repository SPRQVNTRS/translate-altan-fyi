#!/usr/bin/env tsx
import { registry } from "#app/cms/registry";
import { getCollection, getDataset } from "#app/cms/loader.server";

async function main() {
  let errors = 0;
  for (const [name, cfg] of Object.entries(registry)) {
    try {
      if (cfg.type === "content") {
        await getCollection(name, { filterDrafts: false });
        // Also rudimentary unique check is inside loader; any error would throw.
        console.log(`✔ content:${name} OK`);
      } else {
        await getDataset(name);
        console.log(`✔ data:${name} OK`);
      }
    } catch (e) {
      errors++;
      console.error(`✖ Issue in ${cfg.type}:${name}:`);
      console.error(e);
    }
  }
  if (errors > 0) {
    console.error(`Validation failed with ${errors} error(s).`);
    process.exit(1);
  }
  console.log("All collections validated successfully.");
}

main();
