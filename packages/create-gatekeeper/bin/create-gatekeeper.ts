#!/usr/bin/env node

// `pnpm create-gatekeeper <name>`: writes `packages/gatekeeper-<name>`, registers it where the
// repository lists gatekeepers by hand, and generates its Worker config and types.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { AUTH_KINDS, namesFor, scaffold, stops, type Names, type ScaffoldOptions } from "../src/scaffold.ts";

const USAGE = `Usage: pnpm create-gatekeeper <name> --auth <${AUTH_KINDS.join("|")}> [options]

Writes packages/gatekeeper-<name>, a gatekeeper built on gatekeeper-kit.

  <name>             The vendor id, e.g. "pagerduty": lowercase, hyphens between words.
  --auth <kind>      How a user connects: ${AUTH_KINDS.join(", ")}.
  --display <text>   The provider's name as users read it, e.g. "PagerDuty".
  --out <dir>        Write the package here instead, and register nothing.
  --no-install       Don't run "pnpm install" and "pnpm types:generate" afterwards.
`;

const ROOT = join(import.meta.dirname, "..", "..", "..");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Inserts `line` after the last line of `path` that `after` matches. */
function insertAfterLast(path: string, after: RegExp, line: string): void {
  const lines = readFileSync(path, "utf8").split("\n");
  const index = lines.findLastIndex(existing => after.test(existing));
  if (index < 0) fail(`${relative(ROOT, path)} no longer has a line matching ${after}; register the gatekeeper there by hand.`);
  lines.splice(index + 1, 0, line);
  writeFileSync(path, lines.join("\n"));
}

/** Adds the gatekeeper to the lists the repository keeps by hand. */
function register(names: Names, auth: ScaffoldOptions["auth"]): void {
  insertAfterLast(join(ROOT, "README.md"), /^\* \[.*\]\(packages\/gatekeeper-[a-z0-9-]+\/README\.md\)$/,
    `* [${names.display}](packages/gatekeeper-${names.name}/README.md)`);
  if (auth === "oauth") {
    insertAfterLast(join(ROOT, "scripts", "run-dev-server.ts"), /^  "gatekeeper-[a-z0-9-]+": \{ id: "[A-Z0-9_]+", secret: "[A-Z0-9_]+" \},$/,
      `  "gatekeeper-${names.name}": { id: "${names.constant}_CLIENT_ID", secret: "${names.constant}_CLIENT_SECRET" },`);
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
  const options = { name: positionals[0], display: values.display, auth: values.auth as ScaffoldOptions["auth"] };
  names = namesFor(options);
  files = scaffold(options);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const dir = values.out ?? join(ROOT, "packages", `gatekeeper-${names.name}`);
if (existsSync(dir)) fail(`${dir} already exists.`);
for (const [path, file] of files) {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  if ("symlink" in file) symlinkSync(file.symlink, target);
  else writeFileSync(target, file.text);
}
console.log(`Wrote ${files.size} files to ${relative(process.cwd(), dir) || dir}.`);

if (values.out === undefined) {
  register(names, values.auth as ScaffoldOptions["auth"]);
  console.log("Registered it in README.md" + (values.auth === "oauth" ? " and scripts/run-dev-server.ts." : "."));
  if (!values["no-install"]) {
    run("pnpm", ["install"]);
    run("pnpm", ["types:generate"]);
  }
}

const left = stops(files);
console.log(`\n${left.length} decisions are left, each marked STOP(<id>) where it applies:`);
for (const { path, id } of left) console.log(`  ${id.padEnd(22)} ${path}`);
console.log(`\nThe package's tests fail until none is left. Then, by hand:
  - add the gatekeeper's row to the table in docs/observers.md
  - write its README, and its tests against a fake of the provider
Follow the write-gatekeeper skill (.agents/skills/write-gatekeeper/SKILL.md) throughout.`);
