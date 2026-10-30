// `cf-os` as the root `pnpm cf-os` script and cloudflare-os-starter run it: a spawned
// `node src/main.ts`, with none of the caller's environment but PATH and what each case sets. And the
// runtime's import graph, which the starter relies on to run this file with nothing but Node and the
// submodule's workspace install.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { invocationDir } from "./main.ts";

const MAIN = join(import.meta.dirname, "main.ts");
const PACKAGE = join(import.meta.dirname, "..");

/** What CFOS_API_URL_UNAVAILABLE says in a starter whose deployment file is not configured. */
const REASON = "deployment.jsonc is not configured yet (https://<your-domain>): pass --url <origin>.";

/** `text` with every run of whitespace one space, so wrapped help reads as one line. */
const flat = (text: string) => text.replace(/\s+/g, " ");

function cfOs(args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [MAIN, ...args], { env: { PATH: process.env.PATH ?? "", ...extra }, encoding: "utf8" });
}

test("a command other than api is refused, saying cf-os's other commands are cloudflare-os-starter's", () => {
  const deploy = cfOs(["deploy"]);
  assert.equal(deploy.status, 1);
  assert.equal(deploy.stdout, "");
  assert.match(deploy.stderr, /cf-os has no command "deploy" here: in cloudflare-os it has only `api` \(`pnpm cf-os api --help`\)\. .*cloudflare-os-starter's: https:\/\/github\.com\/cloudflare\/cloudflare-os-starter\./);
});

test("no command prints the usage on stderr, --help on stdout; an option before the command is refused", () => {
  const none = cfOs([]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /^Usage: cf-os api \[public\]/);
  const help = cfOs(["--help"]);
  assert.equal(help.status, 0);
  assert.ok(help.stdout.startsWith("Usage: cf-os api [public]"));
  const option = cfOs(["--url", "x"]);
  assert.equal(option.status, 1);
  assert.match(option.stderr, /takes its command first/);
});

test("the default instance is the local dev server, or CFOS_API_URL's", () => {
  const dev = cfOs(["api", "--dry-run", "whoami"]);
  assert.equal(dev.status, 0, dev.stderr);
  assert.deepEqual(JSON.parse(dev.stdout), { url: "ws://localhost:8787/api", auth: { mode: "token" }, on: "AuthenticatedApi", chain: [{ method: "whoami", args: [] }] });
  const named = cfOs(["api", "--dry-run", "whoami"], { CFOS_API_URL: "https://os.example.com" });
  assert.equal(named.status, 0, named.stderr);
  assert.deepEqual(JSON.parse(named.stdout), { url: "wss://os.example.com/api", auth: { mode: "access" }, on: "AuthenticatedApi", chain: [{ method: "whoami", args: [] }] });
});

test("a misused option of create-account, search, types or a generated command exits 2 in the CLI's words, never node:util's", () => {
  const cases: [string[], string][] = [
    [["--username", "x", "create-account", "y"], "--username does not apply to create-account: create-account signs in as no one"],
    [["create-account", "y", "--displayname", "X"], "Unknown option --displayname for create-account. Did you mean --display-name?"],
    [["search", "x", "--limit", "3"], "Unknown option --limit for search. Run `cf-os api search --help` for its options."],
    [["types", "--nope"], "Unknown option --nope for types. Run `cf-os api types --help` for its options."],
    [["list-workspaces", "--help=foo"], "--help takes no value: run `cf-os api list-workspaces --help`."],
  ];
  for (const [args, message] of cases) {
    const run = cfOs(["api", ...args], { CFOS_API_PASSWORD: "unused" });
    assert.equal(run.status, 2, args.join(" "));
    assert.equal(run.stdout, "", args.join(" "));
    assert.ok(run.stderr.startsWith(message), `${args.join(" ")}: ${run.stderr}`);
    assert.doesNotMatch(run.stderr, /To specify a positional|place it at the end|argument is ambiguous|does not take an argument/, args.join(" "));
  }
});

test("with CFOS_API_URL_UNAVAILABLE, a run that needs an instance exits 2 with the reason alone; search, help and --url work", () => {
  const env = { CFOS_API_URL_UNAVAILABLE: REASON };
  const call = cfOs(["api", "--dry-run", "whoami"], env);
  assert.equal(call.status, 2);
  assert.equal(call.stdout, "");
  assert.equal(call.stderr, `${REASON}\n`);
  const search = cfOs(["api", "search", "list chats"], env);
  assert.equal(search.status, 0, search.stderr);
  assert.ok(Array.isArray(JSON.parse(search.stdout)));
  const help = cfOs(["api", "--help"], env);
  assert.equal(help.status, 0, help.stderr);
  assert.ok(flat(help.stdout).includes(`No default here: ${REASON}`));
  const explicit = cfOs(["api", "--url", "http://localhost:9999", "--dry-run", "whoami"], env);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).url, "ws://localhost:9999/api");
});

test("a usage error exits 2, printing nothing on stdout", () => {
  const nope = cfOs(["api", "nope"]);
  assert.equal(nope.status, 2);
  assert.equal(nope.stdout, "");
  assert.match(nope.stderr, /AuthenticatedApi has no command "nope"/);
});

/** A module's imports: static ones (`import type` and `export type` excluded: erased) and literal dynamic ones. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [
    ...[...source.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]),
    ...[...source.matchAll(/\bimport\("([^"]+)"\)/g)].map((match) => match[1]),
  ];
}

/** Every module reachable from `entry` by value imports, and the packages they import. */
function closure(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
      else packages.add(specifier);
    }
  }
  return { files, packages };
}

test("the runtime loads node builtins, capnweb, hash-wasm and its own src/ and generated/ only", () => {
  // cloudflare-os-starter runs this file from its submodule with nothing but Node and the
  // submodule's workspace install: no build, and nothing of @gadgets/* at run time.
  const { files, packages } = closure(MAIN);
  for (const name of packages) assert.ok(name.startsWith("node:") || name === "capnweb" || name === "hash-wasm", name);
  for (const file of files) {
    const at = relative(PACKAGE, file);
    assert.ok(["src", "generated"].includes(at.split(/[\\/]/)[0]), at);
  }
  assert.ok([...files].some((file) => file.endsWith(join("generated", "commands.ts"))));
  const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies).toSorted(), ["capnweb", "hash-wasm"]);
});

test("relative paths resolve where the command was typed: INIT_CWD under a package script, when it is below", () => {
  const script = { npm_lifecycle_event: "cf-os" };
  assert.equal(invocationDir("/repo", { ...script, INIT_CWD: "/repo/packages/x" }), "/repo/packages/x");
  assert.equal(invocationDir("/repo", { ...script, INIT_CWD: "/" }), "/repo");
  assert.equal(invocationDir("/repo", { ...script, INIT_CWD: "/elsewhere" }), "/repo");
  assert.equal(invocationDir("/repo", { INIT_CWD: "/repo/packages/x" }), "/repo");
});

test("a credential missing from the environment exits 2, nothing sent, without 'API call failed.'", () => {
  const token = cfOs(["api", "--url", "http://localhost:1", "whoami"]);
  assert.equal(token.status, 2, token.stderr);
  assert.equal(token.stderr, "--auth token reads the secret from CFOS_API_TOKEN, which is not set " +
    "(or sign in with --username <name> and CFOS_API_PASSWORD).\n");
  const password = cfOs(["api", "--url", "http://localhost:1", "--username", "bob", "whoami"]);
  assert.equal(password.status, 2, password.stderr);
  assert.doesNotMatch(password.stderr, /API call failed/);
});
