#!/usr/bin/env node

// Generates `packages/api-schema/generated/` from the Workshop API,
// `packages/workshop-shared/src/api.ts`: its capnweb-schema, and the declarations and tool catalog
// an agent holding an `AuthenticatedApi` stub is given. From the same schema and declarations it
// also renders `pnpm cf-os api`'s command table and its copy of the agent declarations, in
// `packages/api-cli/generated/` (rendered by `packages/api-cli/generator/emit.ts`). The extractor and
// emitters know nothing of this repository; this script is the one place that names the API's file,
// its entry interface, its constants and the agent's root, and the only part that writes to disk.
//
// Neither directory is committed. Whatever reads them generates them first, with --if-stale: the
// `@gadgets/api-schema#generate` task, which the CLI's `build` and `test` and the integration tests
// depend on, the CLI's and the integration tests' direct `test:run`, and the root `cf-os` script.
//
// It does the same for each gatekeeper app UI: a gatekeeper whose management app's capability (the
// `ui` of `getGatekeeperApp(<vendor>)`) has a declared interface exports it as `AppApi` from its
// `src/app-api.ts` (`export type { ContextApi as AppApi } from "./context-types.ts"`), and this
// script extracts that interface's schema under the package's own tsconfig and writes it, with its
// declarations, to
// `generated/gatekeeper-apps/<vendor>.schema.json` and `.d.ts`, and hands it to the CLI's generator,
// which types the `ui` by vendor id. The declaration lives with the gatekeeper, so the Workshop API
// (and workshop-shared) still depends on no gatekeeper, and no list of them is kept here.
//
// With --if-stale it generates only when something it would write has changed. Each generation
// records, in `generated/.inputs.json`, a SHA-256 of every file it read (the tsconfigs, with what they
// extend, and the sources the extractions read outside `node_modules`, gatekeepers' `src/app-api.ts`
// among them, this script's own modules, and `pnpm-lock.yaml` for everything installed) and of every
// file it wrote. --if-stale generates when one of them differs or is gone, or a gatekeeper has a new
// `src/app-api.ts`; reading the hashes loads no TypeScript, so a current checkout pays only for that.
//
// stdout is one JSON object for scripts, `{"files": [...]}`: the repo-relative paths written or
// removed. With --if-stale stdout stays empty, so `pnpm cf-os`'s is the CLI's alone. Everything
// else goes to stderr.
//
// Usage: node packages/api-schema/scripts/generate.ts [--if-stale]

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// By relative path, not as a package: `@gadgets/api-cli` type-imports this package, so a dependency
// back would close a workspace cycle.
import { type AppApi, generate as renderCliFiles } from "../../api-cli/generator/emit.ts";
import { emitDeclarations } from "../src/emit/dts.ts";
import { emitToolCatalog } from "../src/emit/tools.ts";
// Type-only: the extractor loads TypeScript, which --if-stale skips when nothing is stale.
import type { ExtractOptions } from "../src/extract.ts";
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

/** Where a gatekeeper declares its app UI's interface, from its package: as {@link APP_API_EXPORT}. */
export const APP_API_FILE = "src/app-api.ts";

/** The name a gatekeeper's {@link APP_API_FILE} exports its app UI's interface as. */
export const APP_API_EXPORT = "AppApi";

/** A gatekeeper with an {@link APP_API_FILE}, which declares its app UI's interface. */
export interface GatekeeperAppSource {
  /** Its vendor id: `context` for `packages/gatekeeper-context`. */
  vendor: string;
  /** Its {@link APP_API_FILE}, from the repository root, `/`-separated. */
  file: string;
  /** What to extract: the interface, under the package's own tsconfig. */
  source: ExtractOptions;
}

/** A {@link GatekeeperAppSource} with its interface's schema. */
export interface GatekeeperApp extends GatekeeperAppSource {
  schema: Schema;
}

/**
 * Every `packages/gatekeeper-*` package with an {@link APP_API_FILE}, by vendor id. The vendor id is
 * the backend's: its
 * `GATEKEEPER_<NAME>` binding (which `scripts/run-dev-server.ts` names after the package's directory,
 * `gatekeeper-context` as `GATEKEEPER_CONTEXT`) without the prefix, lowercased
 * (`workshop-backend/src/auth/auth-vendors.ts`).
 */
export function findGatekeeperApps(root = ROOT): GatekeeperAppSource[] {
  const packages = join(root, "packages");
  return readdirSync(packages).filter((name) => name.startsWith("gatekeeper-")).toSorted().flatMap((name) => {
    const entry = join(packages, name, APP_API_FILE);
    if (!existsSync(entry)) return [];
    const vendor = name.toUpperCase().replaceAll("-", "_").slice("GATEKEEPER_".length).toLowerCase();
    return [{
      vendor,
      file: `packages/${name}/${APP_API_FILE}`,
      source: { entry, tsconfig: join(packages, name, "tsconfig.json"), entryName: APP_API_EXPORT },
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
    header: `Generated from ${app.file} (${app.schema.entry}, exported as ${APP_API_EXPORT}) by\n` +
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

/** Where each generation records the hashes of the files it read and wrote, for --if-stale. */
export const INPUTS_PATH = "packages/api-schema/generated/.inputs.json";

/** What {@link INPUTS_PATH} holds: a SHA-256 by repo-relative path. */
interface Inputs {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** The SHA-256 of the file at `path`, from the repository root, or undefined if there is none. */
function hashFile(path: string): string | undefined {
  const file = join(ROOT, path);
  return existsSync(file) ? sha256(readFileSync(file)) : undefined;
}

/** `file`, absolute, from the repository root and `/`-separated. */
const fromRoot = (file: string) => relative(ROOT, file).split(sep).join("/");

/** Every gatekeeper's {@link APP_API_FILE}, from the repository root. */
function gatekeeperAppFiles(): string[] {
  return findGatekeeperApps().map((app) => app.file);
}

/**
 * This script and every module it imports by relative path, from the repository root: the code
 * that decides what a generation writes. Packages it imports are `pnpm-lock.yaml`'s.
 */
function generatorModules(): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    // A statement's `from`, at the start of its line or after a multi-line import's `}`: not one in a comment.
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(/^\s*(?:import|export|\})[^\n]*?\bfrom\s+"(\.\.?\/[^"]+\.ts)"/gm)) {
      visit(join(dirname(file), specifier!));
    }
  };
  visit(fileURLToPath(import.meta.url));
  return [...seen].map(fromRoot);
}

/** Why the generated files may not be what generating now would write, or undefined if they are. */
export function staleness(): string | undefined {
  const record = join(ROOT, INPUTS_PATH);
  if (!existsSync(record)) return "it has not run in this checkout";
  const { inputs, outputs } = JSON.parse(readFileSync(record, "utf8")) as Inputs;
  for (const [path, hash] of Object.entries(outputs)) {
    if (hashFile(path) !== hash) return `${path} is gone or was changed`;
  }
  for (const path of gatekeeperAppFiles()) {
    if (!(path in inputs)) return `${path} is new`;
  }
  for (const [path, hash] of Object.entries(inputs)) {
    if (hashFile(path) !== hash) return `${path} changed`;
  }
  return undefined;
}

/**
 * Regenerates every file {@link renderApiSchema} renders, writing only those whose content changed,
 * removes a gatekeeper app UI's files left from a gatekeeper that no longer declares one, and
 * records {@link INPUTS_PATH}. Returns the repo-relative paths written or removed.
 */
export async function generateApiSchema(): Promise<string[]> {
  const { extractSchemaAndSources } = await import("../src/extract.ts");
  const sources = new Set<string>();
  const extract = (options: ExtractOptions) => {
    const extracted = extractSchemaAndSources(options);
    for (const file of extracted.sources) sources.add(file);
    return extracted.schema;
  };
  const apps = findGatekeeperApps().map((app) => ({ ...app, schema: extract(app.source) }));
  const files = renderApiSchema(extract(API_SOURCE), apps);
  const written = files.flatMap(({ path, contents }) => {
    const file = join(ROOT, path);
    if (existsSync(file) && readFileSync(file, "utf8") === contents) return [];
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
    console.error(`gen ${path}`);
    return [path];
  });
  const appsDir = join(ROOT, GATEKEEPER_APPS_DIR);
  // Only names this generator writes count as left over: a .DS_Store or an editor's swap file there is not.
  const left = (existsSync(appsDir) ? readdirSync(appsDir) : [])
    .filter((name) => name.endsWith(".schema.json") || name.endsWith(".d.ts"))
    .map((name) => `${GATEKEEPER_APPS_DIR}/${name}`)
    .filter((path) => !files.some((file) => file.path === path)).toSorted();
  for (const path of left) {
    rmSync(join(ROOT, path));
    console.error(`rm ${path}`);
  }
  // Recorded last, so a generation that fails or is interrupted leaves the next --if-stale to run.
  const read = [...sources].map(fromRoot).filter((path) => !path.startsWith("../") && !path.split("/").includes("node_modules"));
  const inputs = Object.fromEntries([...new Set([...read, ...generatorModules(), "pnpm-lock.yaml"])]
    .toSorted().map((path) => [path, hashFile(path)!]));
  const outputs = Object.fromEntries(files.map(({ path, contents }) => [path, sha256(contents)]));
  writeFileSync(join(ROOT, INPUTS_PATH), json({ inputs, outputs } satisfies Inputs));
  return [...written, ...left];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ifStale = process.argv.includes("--if-stale");
  try {
    const why = ifStale ? staleness() : undefined;
    if (!ifStale || why !== undefined) {
      if (ifStale) console.error(`Generating the API schema, since ${why}.`);
      const files = await generateApiSchema();
      if (!ifStale) process.stdout.write(`${JSON.stringify({ files })}\n`);
    }
  } catch (error) {
    console.error(`API schema generation failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
