#!/usr/bin/env node

// `pnpm create-gatekeeper <name>`: writes `packages/gatekeeper-<name>`, registers it where the
// repository lists gatekeepers by hand, and generates its Worker config and types.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { AUTH_KINDS, namesFor, scaffold, stops, type Names, type ScaffoldOptions } from "../src/scaffold.ts";

const USAGE = `Usage: pnpm create-gatekeeper <name> --auth <${AUTH_KINDS.join("|")}> [options]

Writes packages/gatekeeper-<name>, a gatekeeper built on gatekeeper-kit.

  <name>             The vendor id, e.g. "pagerduty": 1-20 lowercase letters and digits.
  --auth <kind>      How a user connects: "oauth", an authorization-code grant with PKCE, or
                     "api-key", a key the user pastes into the connect page.
  --hooks            Push events to gadgets, from a webhook the provider delivers to.
  --display <text>   The provider's name as users read it, e.g. "PagerDuty".
  --out <dir>        Write the package here instead, and register nothing.
  --no-install       Don't run "pnpm install" and "pnpm types:generate" afterwards.

Don't run it to try it out in a checkout you will commit from: use --out.
`;

const ROOT = join(import.meta.dirname, "..", "..", "..");

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

let names: Names;
let files: ReturnType<typeof scaffold>;
try {
  const options = { name: positionals[0], display: values.display, auth: values.auth as ScaffoldOptions["auth"], hooks: values.hooks };
  names = namesFor(options);
  files = scaffold(options);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const dir = values.out ?? join(ROOT, "packages", `gatekeeper-${names.name}`);
// A release folds the hyphens out of a package's name to make its install slug, the route and
// binding this name becomes, so a package with another name can already have it.
const owner = values.out === undefined ? readdirSync(join(ROOT, "packages")).find(other =>
  other !== `gatekeeper-${names.name}` && other.startsWith("gatekeeper-") &&
    other.slice("gatekeeper-".length).replaceAll("-", "") === names.name) : undefined;
if (owner !== undefined) fail(`packages/${owner} already has the install slug "${names.name}": use another name.`);
if (existsSync(dir)) {
  fail(`${dir} already exists.` + (values.out === undefined
    ? " If an earlier run was interrupted, delete it and run this again: registering twice is harmless." : ""));
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
