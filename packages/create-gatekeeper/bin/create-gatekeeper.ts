#!/usr/bin/env node

// `pnpm create-gatekeeper <name>`: writes `packages/gatekeeper-<name>`, registers it where the
// repository lists gatekeepers by hand, and generates its Worker config and types.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AUTH_KINDS, OPENAPI_OPERATIONS, OPENAPI_URL, namesFor, openApiDocument, openApiUrlRefusal, scaffold, stops,
  type Names, type OpenApiOptions, type ScaffoldOptions,
} from "../src/scaffold.ts";

const USAGE = `Usage: pnpm create-gatekeeper <name> --auth <${AUTH_KINDS.join("|")}> [options]

Writes packages/gatekeeper-<name>, a gatekeeper built on gatekeeper-kit.

  <name>             The vendor id, e.g. "pagerduty": 1-20 lowercase letters and digits.
  --auth <kind>      How a user connects: "oauth", an authorization-code grant with PKCE, or
                     "api-key", a key the user pastes into the connect page.
  --hooks <kind>     Push events to gadgets, from webhooks the provider delivers to: "app", one
                     webhook for the deployment, set up by hand or in the provider's OAuth app,
                     or "subscription", webhooks the gatekeeper adds through the provider's API.
  --display <text>   The provider's name as users read it, e.g. "PagerDuty".
  --openapi <file>   The provider's OpenAPI description, a JSON or YAML file. The package gets a script
                     that generates the typed client's schema from it, pinned by its hash, and
                     no copy of it. Nothing is fetched.
  --openapi-url <url>
                     Where that description is published, an https URL: the script then
                     generates from there. Without it the script takes the file.
  --fetch            Download the description from --openapi-url, in place of --openapi. What it
                     serves now is what the package is pinned to.
  --keep-description Keep a copy of the description in the package, and generate from that.
  --operations <ids> With --openapi, the operationIds the gatekeeper calls, separated by commas,
                     or a file of the lines printed for them: their schema is generated now.
                     Without it, the description's operations are printed to choose from, and
                     none is generated.
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
function register(names: Names, auth: ScaffoldOptions["auth"], hooks: ScaffoldOptions["hooks"]): void {
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
    // The dev server passes through, from the shell or `.dev.vars`, the secret an app's webhook
    // signs with, or the origin of the tunnel a gatekeeper's own webhooks deliver to.
    insertAfterLast(join(ROOT, "scripts", "run-dev-server.ts"), /^  "gatekeeper-[a-z0-9-]+": \[.*\],$/,
      `  "gatekeeper-${names.name}": ["${names.constant}_WEBHOOK_${hooks === "app" ? "SECRET" : "ORIGIN"}"],`);
    // Wrangler's generated types lack `restore`, which a hook's delivery stub is made with.
    replaceOnce(join(ROOT, "scripts", "generate-worker-types.ts"), /"\]\.includes\(basename\(pkgDir\)\)/,
      `", "gatekeeper-${names.name}"].includes(basename(pkgDir))`);
  }
}

/**
 * Runs the kit's schema generator, and returns what it printed, however long: a large
 * description lists more than the megabyte a child is allowed by default.
 * @throws Error in the generator's own words, with `scratch`, a file of this command's that it
 * was given, named as `shown` instead.
 */
function openapiSchema(args: string[], scratch?: string, shown?: string): string {
  const result = spawnSync(process.execPath, [OPENAPI_SCHEMA_BIN, ...args], { encoding: "utf8", maxBuffer: Infinity });
  if (result.status !== 0) {
    const said = result.stderr.trim() || "gatekeeper-openapi-schema failed.";
    throw new Error(scratch === undefined || shown === undefined ? said : said.replaceAll(scratch, shown));
  }
  return result.stdout;
}

/**
 * `text` as a shell takes one argument: quoted, unless it is plain. cmd.exe takes a path's
 * backslashes as they are, and knows only double quotes.
 */
function shellArgument(text: string): string {
  if (process.platform === "win32") return /^[\w@+=:,./\\-]+$/.test(text) ? text : `"${text}"`;
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/** The lines of `listed` for the operationIds in `ids`, which commas separate. */
function chosenLines(listed: string[], ids: string): string {
  const chosen = new Set(ids.split(",").map(id => id.trim()).filter(id => id !== ""));
  const lines = listed.filter(line => chosen.delete((JSON.parse(line) as { operationId: string }).operationId));
  if (chosen.size > 0) {
    throw new Error(`The description has no operation ${[...chosen].join(", ")}. Run this without --operations to list the ones it has.`);
  }
  return lines.map(line => `${line}\n`).join("");
}

/**
 * Downloads the description at `url` into a directory of its own, removed on exit, as the text
 * the package's own script will read from there, so that the two hash alike.
 * @returns The file's path.
 * @throws Error for a URL that is not `https`, that names a user or password, or that does not
 * serve the description.
 */
async function fetchOpenApi(url: string): Promise<string> {
  if (!OPENAPI_URL.test(url)) throw new Error(openApiUrlRefusal(url));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetching ${url} failed with status ${response.status}.`);
  const text = await response.text();
  const dir = mkdtempSync(join(tmpdir(), "create-gatekeeper-fetched-"));
  // On any way out: a failure exits from where it is found.
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, openApiDocument(text));
  writeFileSync(path, text);
  console.log(`Fetched ${url}: ${Buffer.byteLength(text)} bytes, SHA-256 ${createHash("sha256").update(text).digest("hex")}.`);
  return path;
}

/**
 * Reads the description at `path`, and with `ids`, generates the schema of the operations it
 * names: operationIds, or a file of their lines as listed, which an id with a comma in it needs.
 * Nothing of the package is written yet, so a description or an operation the generator refuses
 * leaves nothing behind.
 * @returns What the scaffold needs, and the lines of every operation the description has.
 * @throws Error for a description or operations that cannot be read or generated from.
 */
function readOpenApi(path: string, ids: string | undefined): { openapi: OpenApiOptions; listed: string[] } {
  let document: string;
  try {
    document = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read --openapi ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const listed = openapiSchema([path, "--list"]).split("\n").filter(line => line !== "");
  if (ids === undefined) return { openapi: { document }, listed };

  // A file's lines are the generator's to check, as they are whenever the schema is generated again.
  const operations = existsSync(ids) ? readFileSync(ids, "utf8") : chosenLines(listed, ids);
  if (operations.trim() === "") throw new Error("--operations names no operation.");

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
      hooks: { type: "string" },
      openapi: { type: "string" },
      "openapi-url": { type: "string" },
      fetch: { type: "boolean" },
      "keep-description": { type: "boolean" },
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
// As an unset variable leaves it: joined to a file's name, it is the current directory.
if (values.out === "") fail("--out names no directory.");
const url = values["openapi-url"];
if (values.fetch && (url === undefined || values.openapi !== undefined)) {
  fail(`--fetch downloads the description from --openapi-url, in place of --openapi.\n\n${USAGE}`);
}
for (const option of ["operations", "openapi-url", "keep-description"] as const) {
  if (values[option] !== undefined && values.openapi === undefined && !values.fetch) {
    fail(`--${option} needs --openapi, or --fetch to download the description.\n\n${USAGE}`);
  }
}
if (url !== undefined && values["keep-description"] && !values.fetch) {
  fail(`--keep-description generates from the package's copy, which leaves --openapi-url nothing to do.\n\n${USAGE}`);
}

let names: Names;
let files: ReturnType<typeof scaffold>;
let described: ReturnType<typeof readOpenApi> | undefined;
let dir: string;
try {
  const options = { name: positionals[0], display: values.display, auth: values.auth as ScaffoldOptions["auth"], hooks: values.hooks as ScaffoldOptions["hooks"] };
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
  const file = values.fetch ? await fetchOpenApi(url!) : values.openapi;
  if (file !== undefined) described = readOpenApi(file, values.operations);
  const source = { url, copy: values["keep-description"] };
  files = scaffold({ ...options, openapi: described && { ...described.openapi, ...source } });
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
  register(names, values.auth as ScaffoldOptions["auth"], values.hooks as ScaffoldOptions["hooks"]);
  console.log("Registered it in README.md, the scripts that list gatekeepers by name, and the release test's fixture bundles.");
  if (!values["no-install"]) {
    // The new package is not in the lockfile, which an install in CI would otherwise refuse to change.
    run("pnpm", ["install", "--no-frozen-lockfile"]);
    run("pnpm", ["types:generate", `gatekeeper-${names.name}`]);
  }
}

if (described?.openapi.generated) {
  console.log(`\nGenerated the schema of ${described.openapi.generated.operations.trimEnd().split("\n").length} operations ` +
    `into src/openapi, from the description and ${OPENAPI_OPERATIONS}. The scaffold's own calls are still invented:\n` +
    `STOP(api) in src/${names.name}-api-schema.ts says how to move them onto the provider's.`);
} else if (described) {
  console.log(`\nNo operation is chosen, so no schema is generated. The description has these ${described.listed.length}.
Put the lines of the ones the gatekeeper calls in ${OPENAPI_OPERATIONS}, then run
"pnpm --filter @gadgets/${names.name}-gatekeeper generate:openapi" and import the generated Api, as
STOP(api) in src/${names.name}-api-schema.ts says:\n`);
  for (const line of described.listed) console.log(line);
}
if (described && !values["keep-description"] && values["openapi-url"] === undefined) {
  console.log(`\nThe package keeps no copy of the description and knows no URL for it: generate:openapi takes the file,
"pnpm --filter @gadgets/${names.name}-gatekeeper generate:openapi ${shellArgument(relative(dir, resolve(values.openapi!)))}", and checks it by its hash.`);
}
if (described && url?.includes("?") && !values["keep-description"]) {
  console.log("\nThe URL's query string is now in package.json's generate:openapi script: commit it only if it carries no token.");
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
