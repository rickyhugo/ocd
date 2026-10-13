// Regenerates schema/ocd.schema.json from the config Zod schema.
// Run: pnpm run schema (from the repo root).
import { writeFileSync } from "node:fs";

import { configJsonSchema } from "../src/config-schema.ts";

const target = new URL("../../../schema/ocd.schema.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
