#!/usr/bin/env node

// Writes `src/generated/admin-api.schema.json`, the schema this Worker bundles: the part of the
// Workshop API's schema an `AdminApi` stub reaches, less the methods ADMIN_AGENT_KINDS omits
// (src/subset.ts). The sessions, the agent's declarations and the check of each call's arguments
// are built from it (src/surface.ts).
//
// Reads `packages/api-schema/generated/workshop-api.schema.json`, which is generated and not
// committed either: whatever runs this generates that first (the `generate` task depends on
// `@gadgets/api-schema#generate`; `test:run` and Wrangler's build command chain the two). The file
// is written only when its contents change, since Wrangler watches `src`.
//
// Usage: node packages/gatekeeper-admin/scripts/generate-schema.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Schema } from "@gadgets/api-schema/schema";
import { adminSchema } from "../src/subset.ts";

const PACKAGE = join(import.meta.dirname, "..");
const SOURCE = join(PACKAGE, "..", "api-schema", "generated", "workshop-api.schema.json");
const OUTPUT = join(PACKAGE, "src", "generated", "admin-api.schema.json");

const schema = JSON.parse(readFileSync(SOURCE, "utf8")) as Schema;
const contents = `${JSON.stringify(adminSchema(schema), null, 2)}\n`;
if (!existsSync(OUTPUT) || readFileSync(OUTPUT, "utf8") !== contents) {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, contents);
}
