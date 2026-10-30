#!/usr/bin/env node

// Generates the committed files in `packages/api-schema/generated/` from the Workshop API,
// `packages/workshop-shared/src/api.ts`: its capnweb-schema, and the declarations and tool catalog
// an agent holding an `AuthenticatedApi` stub is given. From the same schema and declarations it
// also renders `pnpm cf-os api`'s committed command table and its copy of the agent declarations, in
// `packages/api-cli/generated/` (rendered by `packages/api-cli/generator/emit.ts`). The extractor and
// emitters know nothing of this repository; this script is the one place that names the API's file,
// its entry interface, its constants and the agent's root, and the only part that writes to disk.
// `pnpm api-schema:check` (part of `pnpm lint` and CI) keeps every one of those files in step with
// api.ts, as `pnpm configs:check` does the Worker configs.
//
// stdout is one JSON object for scripts, `{"files": [...]}`: the repo-relative paths written or,
// with --check, stale. Everything else goes to stderr.
//
// Usage: node packages/api-schema/scripts/generate.ts [--check]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
// By relative path, not as a package: `@gadgets/api-cli` type-imports this package, so a dependency
// back would close a workspace cycle.
import { generate as renderCliFiles } from "../../api-cli/generator/emit.ts";
import { emitDeclarations } from "../src/emit/dts.ts";
import { emitToolCatalog } from "../src/emit/tools.ts";
import { type ExtractOptions, extractSchema } from "../src/extract.ts";
import type { Schema } from "../src/schema.ts";

const PACKAGE = join(import.meta.dirname, "..");
const ROOT = join(PACKAGE, "..", "..");
const SHARED = join(ROOT, "packages", "workshop-shared");

/** The Workshop API: everything reachable from `PublicApi`, under its package's own tsconfig. */
export const API_SOURCE: ExtractOptions = {
  entry: join(SHARED, "src", "api.ts"),
  tsconfig: join(SHARED, "tsconfig.json"),
  entryName: "PublicApi",
  constants: ["SERVICE_SALT"],
};

/** The service an agent (a Gatekeeper, a code-mode agent) holds a stub of. */
export const AGENT_ROOT = "AuthenticatedApi";

/**
 * Methods an agent never calls: it is handed an already-authenticated stub, so the ways to obtain
 * or change credentials are left out of its surface, with whatever only they reach.
 */
export const AGENT_OMIT = ["authenticate", "authenticateFromCfAccess", "createAccount", "login", "changePassword"];

const DTS_HEADER =
  "Generated from packages/workshop-shared/src/api.ts by packages/api-schema/scripts/generate.ts -- do not edit.\n" +
  `The Workshop API as an agent holding an ${AGENT_ROOT} stub sees it, without the credential methods.\n` +
  "Change api.ts and run `pnpm api-schema:generate`.";

/** One generated file: its path from the repository root, `/`-separated, and its text. */
export interface GeneratedFile {
  path: string;
  contents: string;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Every generated file's path and contents, rendered from `schema`: api-schema's, then the CLI's. */
export function renderApiSchema(schema: Schema): GeneratedFile[] {
  const agent = { root: AGENT_ROOT, omit: AGENT_OMIT };
  const declarations = emitDeclarations(schema, { ...agent, header: DTS_HEADER });
  const fragments = Object.fromEntries(Object.entries(declarations.fragments)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return [
    { path: "packages/api-schema/generated/workshop-api.schema.json", contents: json(schema) },
    { path: "packages/api-schema/generated/workshop-api.agent.d.ts", contents: declarations.full },
    { path: "packages/api-schema/generated/workshop-api.fragments.json", contents: json(fragments) },
    { path: "packages/api-schema/generated/workshop-api.tools.json", contents: json(emitToolCatalog(schema, agent)) },
    ...renderCliFiles(schema, { declarations: declarations.full, fragments })
      .map((file) => ({ path: `packages/api-cli/${file.path}`, contents: file.contents })),
  ];
}

/**
 * Regenerates every file {@link renderApiSchema} renders, writing only those whose content changed.
 * With `check`, writes nothing. Returns the repo-relative paths that differed.
 */
export function generateApiSchema({ check }: { check: boolean }): string[] {
  const files = renderApiSchema(extractSchema(API_SOURCE));
  return files.flatMap(({ path, contents }) => {
    const file = join(ROOT, path);
    if (existsSync(file) && readFileSync(file, "utf8") === contents) return [];
    if (!check) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
      console.error(`gen ${path}`);
    }
    return [path];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  try {
    const files = generateApiSchema({ check });
    process.stdout.write(`${JSON.stringify({ files })}\n`);
    if (check && files.length > 0) {
      console.error(`API schema out of date (run \`pnpm api-schema:generate\`):\n  ${files.join("\n  ")}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`API schema generation failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
