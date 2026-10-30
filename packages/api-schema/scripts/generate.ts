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
// It does the same for each gatekeeper app UI: a gatekeeper whose management app's capability (the
// `ui` of `getGatekeeperApp(<vendor>)`) has a declared interface names it in its package.json,
// `"cloudflareOs": {"appApi": "src/context-types.ts#ContextApi"}`, and this script extracts that
// interface's schema under the package's own tsconfig and writes it, with its declarations, to
// `generated/gatekeeper-apps/<vendor>.schema.json` and `.d.ts`, and hands it to the CLI's generator,
// which types the `ui` by vendor id. The declaration lives with the gatekeeper, so the Workshop API
// (and workshop-shared) still depends on no gatekeeper, and no list of them is kept here.
//
// stdout is one JSON object for scripts, `{"files": [...]}`: the repo-relative paths written or,
// with --check, stale. Everything else goes to stderr.
//
// Usage: node packages/api-schema/scripts/generate.ts [--check]

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
// By relative path, not as a package: `@gadgets/api-cli` type-imports this package, so a dependency
// back would close a workspace cycle.
import { type AppApi, generate as renderCliFiles } from "../../api-cli/generator/emit.ts";
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

/** Where the gatekeeper app UIs' files go, from the repository root. */
export const GATEKEEPER_APPS_DIR = "packages/api-schema/generated/gatekeeper-apps";

/** A gatekeeper whose package.json names its app UI's interface (`cloudflareOs.appApi`). */
export interface GatekeeperAppSource {
  /** Its vendor id: `context` for `packages/gatekeeper-context`. */
  vendor: string;
  /** The file declaring the interface, from the repository root, `/`-separated. */
  file: string;
  /** What to extract: the interface, under the package's own tsconfig. */
  source: ExtractOptions;
}

/** A {@link GatekeeperAppSource} with its interface's schema. */
export interface GatekeeperApp extends GatekeeperAppSource {
  schema: Schema;
}

/**
 * Every `packages/gatekeeper-*` package whose package.json has `cloudflareOs.appApi`, a
 * `<file>#<Interface>` relative to the package, by vendor id. The vendor id is the backend's: its
 * `GATEKEEPER_<NAME>` binding (which `scripts/run-dev-server.ts` names after the package's directory,
 * `gatekeeper-context` as `GATEKEEPER_CONTEXT`) without the prefix, lowercased
 * (`workshop-backend/src/auth/auth-vendors.ts`).
 */
export function findGatekeeperApps(root = ROOT): GatekeeperAppSource[] {
  const packages = join(root, "packages");
  return readdirSync(packages).filter((name) => name.startsWith("gatekeeper-")).toSorted().flatMap((name) => {
    const manifest = join(packages, name, "package.json");
    if (!existsSync(manifest)) return [];
    const appApi: unknown = (JSON.parse(readFileSync(manifest, "utf8")) as { cloudflareOs?: { appApi?: unknown } })
      .cloudflareOs?.appApi;
    if (appApi === undefined) return [];
    const match = typeof appApi === "string" ? /^([^#]+\.ts)#([A-Za-z_$][\w$]*)$/.exec(appApi) : null;
    if (!match) throw new Error(`packages/${name}/package.json: cloudflareOs.appApi needs "<file>.ts#<Interface>", not ${JSON.stringify(appApi)}`);
    const [, file, entryName] = match as unknown as [string, string, string];
    const vendor = name.toUpperCase().replaceAll("-", "_").slice("GATEKEEPER_".length).toLowerCase();
    return [{
      vendor,
      file: `packages/${name}/${file}`,
      source: { entry: join(packages, name, file), tsconfig: join(packages, name, "tsconfig.json"), entryName },
    }];
  });
}

/** One generated file: its path from the repository root, `/`-separated, and its text. */
export interface GeneratedFile {
  path: string;
  contents: string;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Every generated file's path and contents, rendered from `schema` and the gatekeeper app UIs
 * `apps`: api-schema's, the apps', then the CLI's.
 */
export function renderApiSchema(schema: Schema, apps: GatekeeperApp[] = []): GeneratedFile[] {
  const agent = { root: AGENT_ROOT, omit: AGENT_OMIT };
  const declarations = emitDeclarations(schema, { ...agent, header: DTS_HEADER });
  const fragments = Object.fromEntries(Object.entries(declarations.fragments)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const appDeclarations = Object.fromEntries(apps.map((app) => [app.vendor, emitDeclarations(app.schema, {
    root: app.schema.entry,
    header: `Generated from ${app.file} (${app.schema.entry}, named by its package.json's cloudflareOs.appApi) by\n` +
      "packages/api-schema/scripts/generate.ts -- do not edit.\n" +
      `The app UI of the ${app.vendor} gatekeeper: the \`ui\` of getGatekeeperApp("${app.vendor}").\n` +
      "Change that file and run `pnpm api-schema:generate`.",
  }).full]));
  const cliApps: AppApi[] = apps.map(({ vendor, schema: appSchema }) => ({ vendor, schema: appSchema }));
  return [
    { path: "packages/api-schema/generated/workshop-api.schema.json", contents: json(schema) },
    { path: "packages/api-schema/generated/workshop-api.agent.d.ts", contents: declarations.full },
    { path: "packages/api-schema/generated/workshop-api.fragments.json", contents: json(fragments) },
    { path: "packages/api-schema/generated/workshop-api.tools.json", contents: json(emitToolCatalog(schema, agent)) },
    ...apps.flatMap((app) => [
      { path: `${GATEKEEPER_APPS_DIR}/${app.vendor}.schema.json`, contents: json(app.schema) },
      { path: `${GATEKEEPER_APPS_DIR}/${app.vendor}.d.ts`, contents: appDeclarations[app.vendor]! },
    ]),
    ...renderCliFiles(schema, { declarations: declarations.full, fragments, apps: appDeclarations }, cliApps)
      .map((file) => ({ path: `packages/api-cli/${file.path}`, contents: file.contents })),
  ];
}

/**
 * Regenerates every file {@link renderApiSchema} renders, writing only those whose content changed,
 * and removes a gatekeeper app UI's files left from a gatekeeper that no longer declares one. With
 * `check`, writes and removes nothing. Returns the repo-relative paths that differed.
 */
export function generateApiSchema({ check }: { check: boolean }): string[] {
  const apps = findGatekeeperApps().map((app) => ({ ...app, schema: extractSchema(app.source) }));
  const files = renderApiSchema(extractSchema(API_SOURCE), apps);
  const changed = files.flatMap(({ path, contents }) => {
    const file = join(ROOT, path);
    if (existsSync(file) && readFileSync(file, "utf8") === contents) return [];
    if (!check) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
      console.error(`gen ${path}`);
    }
    return [path];
  });
  const appsDir = join(ROOT, GATEKEEPER_APPS_DIR);
  // Only names this generator writes count as left over: a .DS_Store or an editor's swap file there is not.
  const left = (existsSync(appsDir) ? readdirSync(appsDir) : [])
    .filter((name) => name.endsWith(".schema.json") || name.endsWith(".d.ts"))
    .map((name) => `${GATEKEEPER_APPS_DIR}/${name}`)
    .filter((path) => !files.some((file) => file.path === path)).toSorted();
  for (const path of check ? [] : left) {
    rmSync(join(ROOT, path));
    console.error(`rm ${path}`);
  }
  return [...changed, ...left];
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
