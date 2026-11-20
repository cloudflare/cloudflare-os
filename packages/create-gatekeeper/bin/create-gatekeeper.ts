#!/usr/bin/env node

// `pnpm create-gatekeeper <name>`: writes `packages/gatekeeper-<name>`, registers it where the
// repository lists gatekeepers by hand, and generates its Worker config and types.

import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
  AUTH_KINDS, OPENAPI_DOCUMENT, OPENAPI_OPERATIONS, namesFor, scaffold, stops,
  type Names, type OpenApiOptions, type ScaffoldOptions,
} from "../src/scaffold.ts";

const USAGE = `Usage: pnpm create-gatekeeper <name> --auth <${AUTH_KINDS.join("|")}> [options]

Writes packages/gatekeeper-<name>, a gatekeeper built on gatekeeper-kit.

  <name>             The vendor id, e.g. "pagerduty": 1-20 lowercase letters and digits.
  --auth <kind>      How a user connects: "oauth", an authorization-code grant with PKCE, or
                     "api-key", a key the user pastes into the connect page.
  --hooks            Push events to gadgets, from a webhook the provider delivers to.
  --display <text>   The provider's name as users read it, e.g. "PagerDuty".
  --openapi <file>   The provider's OpenAPI description, a JSON file. The package keeps a copy,
                     pinned by its hash, and a script that generates the typed client's schema
                     from it. Nothing is fetched.
  --operations <ids> With --openapi, the operationIds the gatekeeper calls, separated by commas:
                     their schema is generated now. Without it, the description's operations
                     are printed to choose from, and none is generated.
  --out <dir>        Write the package here instead, and register nothing.
  --no-install       Don't run "pnpm install" and "pnpm types:generate" afterwards.

Don't run it to try it out in a checkout you will commit from: use --out.
`;

const ROOT = join(import.meta.dirname, "..", "..", "..");
/** The kit's schema generator, run by path so that it works before the new package is installed. */
const OPENAPI_SCHEMA_BIN = join(ROOT, "packages", "gatekeeper-kit", "bin", "openapi-schema.ts");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Inserts `line` after the last line of `path` that `after` matches. */
function insertAfterLast(path: string, after: RegExp, line: string): void {
  const lines = readFileSync(path, "utf8").split("\n");
  // Already there, from a run that was interrupted.
  if (lines.includes(line)) return;
  const index = lines.findLastIndex(existing => after.test(existing));
  if (index < 0) fail(`${relative(ROOT, path)} no longer has a line matching ${after}; register the gatekeeper there by hand.`);
  lines.splice(index + 1, 0, line);
  writeFileSync(path, lines.join("\n"));
}

/** Replaces the one match of `pattern` in `path`. */
function replaceOnce(path: string, pattern: RegExp, replacement: string): void {
  const text = readFileSync(path, "utf8");
  if (text.includes(replacement)) return;
  if (!pattern.test(text)) fail(`${relative(ROOT, path)} no longer matches ${pattern}; register the gatekeeper there by hand.`);
  writeFileSync(path, text.replace(pattern, replacement));
}

/** Adds the gatekeeper to the lists the repository keeps by hand. Safe to repeat. */
function register(names: Names, auth: ScaffoldOptions["auth"], hooks: boolean): void {
  // The release manifest's test builds every deployable package from a stand-in bundle.
  const fixture = join(ROOT, "scripts", "release", "testdata", "fixture-bundles", `gatekeeper-${names.name}`);
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, `${names.name}.js`), `export default {}; // fixture bundle for gatekeeper-${names.name}\n`);
  insertAfterLast(join(ROOT, "README.md"), /^\* \[.*\]\(packages\/gatekeeper-[a-z0-9-]+\/README\.md\)$/,
    `* [${names.display}](packages/gatekeeper-${names.name}/README.md)`);
  if (auth === "oauth") {
    insertAfterLast(join(ROOT, "scripts", "run-dev-server.ts"), /^  "gatekeeper-[a-z0-9-]+": \{ id: "[A-Z0-9_]+", secret: "[A-Z0-9_]+" \},$/,
      `  "gatekeeper-${names.name}": { id: "${names.constant}_CLIENT_ID", secret: "${names.constant}_CLIENT_SECRET" },`);
  }
  if (hooks) {
    // The dev server passes the webhook's signing secret through from the shell or `.dev.vars`.
    insertAfterLast(join(ROOT, "scripts", "run-dev-server.ts"), /^  "gatekeeper-[a-z0-9-]+": \[.*\],$/,
      `  "gatekeeper-${names.name}": ["${names.constant}_WEBHOOK_SECRET"],`);
    // Wrangler's generated types lack `restore`, which a hook's delivery stub is made with.
    replaceOnce(join(ROOT, "scripts", "generate-worker-types.ts"), /"\]\.includes\(basename\(pkgDir\)\)/,
      `", "gatekeeper-${names.name}"].includes(basename(pkgDir))`);
  }
}

/**
 * Runs the kit's schema generator, and returns what it printed. A failure is reported in its own
 * words, with `scratch`, a file of this command's that it was given, named as `shown` instead.
 */
function openapiSchema(args: string[], scratch?: string, shown?: string): string {
  const result = spawnSync(process.execPath, [OPENAPI_SCHEMA_BIN, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    const said = result.stderr.trim() || "gatekeeper-openapi-schema failed.";
    fail(scratch === undefined || shown === undefined ? said : said.replaceAll(scratch, shown));
  }
  return result.stdout;
}

/**
 * Reads the description at `path`, and with `ids`, the operationIds separated by commas, generates
 * the schema of those operations. Nothing of the package is written yet, so a description or an
 * operation the generator refuses leaves nothing behind.
 * @returns What the scaffold needs, and the lines of every operation the description has.
 */
function readOpenApi(path: string, ids: string | undefined): { openapi: OpenApiOptions; listed: string[] } {
  let document: string;
  try {
    document = readFileSync(path, "utf8");
  } catch (error) {
    fail(`Could not read --openapi ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const listed = openapiSchema([path, "--list"]).split("\n").filter(line => line !== "");
  if (ids === undefined) return { openapi: { document }, listed };

  const chosen = new Set(ids.split(",").map(id => id.trim()).filter(id => id !== ""));
  if (chosen.size === 0) fail("--operations names no operation.");
  const lines = listed.filter(line => chosen.delete((JSON.parse(line) as { operationId: string }).operationId));
  if (chosen.size > 0) {
    fail(`The description has no operation ${[...chosen].join(", ")}. Run this without --operations to list the ones it has.`);
  }
  const operations = lines.map(line => `${line}\n`).join("");

  const work = mkdtempSync(join(tmpdir(), "create-gatekeeper-openapi-"));
  try {
    const list = join(work, OPENAPI_OPERATIONS);
    writeFileSync(list, operations);
    const out = join(work, "schema");
    // The list is this command's own file, gone by the time a failure is read.
    openapiSchema([path, "--out", out, "--operations", list], list, "--operations");
    const schema = new Map(readdirSync(out, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const file = join(entry.parentPath, entry.name);
        return [relative(out, file).replaceAll("\\", "/"), readFileSync(file, "utf8")] as const;
      }));
    return { openapi: { document, generated: { operations, schema } }, listed };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function run(command: string, args: string[]): void {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) fail(`"${command} ${args.join(" ")}" failed; the package is written, so fix that and run it again.`);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      auth: { type: "string" },
      display: { type: "string" },
      hooks: { type: "boolean" },
      openapi: { type: "string" },
      operations: { type: "string" },
      out: { type: "string" },
      "no-install": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (error) {
  fail(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
}
const { values, positionals } = parsed;
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (positionals.length !== 1 || values.auth === undefined) fail(USAGE);
if (values.operations !== undefined && values.openapi === undefined) fail(`--operations needs --openapi.\n\n${USAGE}`);

let names: Names;
let files: ReturnType<typeof scaffold>;
let described: ReturnType<typeof readOpenApi> | undefined;
let dir: string;
try {
  const options = { name: positionals[0], display: values.display, auth: values.auth as ScaffoldOptions["auth"], hooks: values.hooks };
  names = namesFor(options);
  dir = values.out ?? join(ROOT, "packages", `gatekeeper-${names.name}`);
  // A release folds the hyphens out of a package's name to make its install slug, the route and
  // binding this name becomes, so a package with another name can already have it.
  const owner = values.out === undefined ? readdirSync(join(ROOT, "packages")).find(other =>
    other !== `gatekeeper-${names.name}` && other.startsWith("gatekeeper-") &&
      other.slice("gatekeeper-".length).replaceAll("-", "") === names.name) : undefined;
  if (owner !== undefined) throw new Error(`packages/${owner} already has the install slug "${names.name}": use another name.`);
  if (existsSync(dir)) {
    throw new Error(`${dir} already exists.` + (values.out === undefined
      ? " If an earlier run was interrupted, delete it and run this again: registering twice is harmless." : ""));
  }
  if (values.openapi !== undefined) described = readOpenApi(values.openapi, values.operations);
  files = scaffold({ ...options, openapi: described?.openapi });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
for (const [path, file] of files) {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  if ("symlink" in file) symlinkSync(file.symlink, target);
  else writeFileSync(target, file.text);
}
console.log(`Wrote ${files.size} files to ${relative(process.cwd(), dir) || dir}.`);

if (values.out === undefined) {
  register(names, values.auth as ScaffoldOptions["auth"], values.hooks === true);
  console.log("Registered it in README.md, the scripts that list gatekeepers by name, and the release test's fixture bundles.");
  if (!values["no-install"]) {
    // The new package is not in the lockfile, which an install in CI would otherwise refuse to change.
    run("pnpm", ["install", "--no-frozen-lockfile"]);
    run("pnpm", ["types:generate", `gatekeeper-${names.name}`]);
  }
}

if (described?.openapi.generated) {
  console.log(`\nGenerated the schema of ${described.openapi.generated.operations.trimEnd().split("\n").length} operations ` +
    `into src/openapi, from ${OPENAPI_DOCUMENT} and ${OPENAPI_OPERATIONS}. The scaffold's own calls are still invented:\n` +
    `STOP(api) in src/${names.name}-api-schema.ts says how to move them onto the provider's.`);
} else if (described) {
  console.log(`\nNo operation is chosen, so no schema is generated. The description has these ${described.listed.length}.
Put the lines of the ones the gatekeeper calls in ${OPENAPI_OPERATIONS}, then run
"pnpm --filter @gadgets/${names.name}-gatekeeper generate:openapi" and import the generated Api, as
STOP(api) in src/${names.name}-api-schema.ts says:\n`);
  for (const line of described.listed) console.log(line);
}

const left = stops(files);
console.log(`\n${left.length} decisions are left, each marked STOP(<id>) where it applies. Everything the package
does with the provider is invented until they are made. Take them in this order, and get the
operator's approval of the session API, resource types and subresource model (the first three)
before going on, as the write-gatekeeper skill's Step 3 requires:`);
for (const { path, id } of left) console.log(`  ${id.padEnd(22)} ${path}`);
console.log(`\nThe package's tests fail until none is left and no invented value remains. Then, by hand:
  - add the gatekeeper's row to the table in docs/observers.md
  - write its README, and its tests against a fake of the provider
  - update the release manifest's golden file:
      UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts` + (values.auth === "api-key" ? `
  - it takes no deploy inputs, so a second install would be identical: add it to SINGLETON in
    scripts/release/manifest-lib.ts, or give it an input that tells installs apart` : "") + `
Follow the write-gatekeeper skill (.agents/skills/write-gatekeeper/SKILL.md) throughout.`);
