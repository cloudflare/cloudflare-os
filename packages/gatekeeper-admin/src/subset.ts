// The schema this Worker bundles, cut from the Workshop API's.
//
// scripts/generate-schema.ts loads this module under plain `node`, which strips types and
// resolves a relative import only by its real file name, hence the `.ts` below.

import { FORMAT, type Schema } from "@gadgets/api-schema/schema";
import { subsetSchema } from "@gadgets/api-schema/subset";
import { ADMIN_AGENT_KINDS } from "./kinds.ts";

const ROOT = "AdminApi";

/**
 * What a holder of an AdminApi stub reaches in the Workshop API's `schema`, less the methods
 * ADMIN_AGENT_KINDS omits, each kept method with its true parameters and result.
 *
 * Throws for a `schema` in another format than this code reads, which the subset would relabel
 * as its own. Throws, naming each method, when ADMIN_AGENT_KINDS and `schema`'s AdminApi do not
 * name the same methods. The Worker's own type-check holds the two together (surface.ts); the
 * script that writes the schema runs without it.
 */
export function adminSchema(schema: Schema): Schema {
  if (schema.format !== FORMAT) {
    throw new Error(`The Workshop API's schema is in format ${schema.format}, not ${FORMAT}.`);
  }
  const declared = schema.services[ROOT]!.methods.map((method) => method.name);
  const classified = Object.keys(ADMIN_AGENT_KINDS);
  const problems = [
    ...classified.filter((name) => !declared.includes(name))
      .map((name) => `ADMIN_AGENT_KINDS names ${name}, which ${ROOT} does not declare`),
    ...declared.filter((name) => !classified.includes(name))
      .map((name) => `${ROOT}.${name} has no kind in ADMIN_AGENT_KINDS`),
  ];
  if (problems.length > 0) {
    throw new Error(`${problems.join("; ")} (packages/gatekeeper-admin/src/kinds.ts)`);
  }
  const omit = Object.entries(ADMIN_AGENT_KINDS)
    .filter(([, kind]) => kind === "omitted").map(([name]) => `${ROOT}.${name}`).toSorted();
  return subsetSchema(schema, { root: ROOT, omit });
}
