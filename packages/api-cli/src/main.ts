#!/usr/bin/env node

// `cf-os` in cloudflare-os, which has only `api`: `pnpm cf-os api ...` calls a running instance's
// API (api.ts). The root `pnpm cf-os` script runs this file, and cloudflare-os-starter's `cf-os api`
// is to run it from its submodule (packages/api-cli/README.md, "Running it from another repository").
// cf-os's other commands (init, check, deploy, update, ...) are the starter's, so here any other
// command is refused, saying where it lives.

import { isAbsolute, relative } from "node:path";
import { run } from "./api.ts";
import { consoleOutput, UsageError, type Output } from "./output.ts";

/** What `cf-os` prints for no command, or `--help`. */
function usage(): string {
  return [
    "Usage: cf-os api [public] <command> [arguments] [<command> [arguments]]... [options]",
    "",
    "Calls a running Cloudflare OS instance's API, with commands generated from",
    "packages/workshop-shared/src/api.ts. Here cf-os has only `api`; its other commands (init, check,",
    "deploy, update, ...) are cloudflare-os-starter's: https://github.com/cloudflare/cloudflare-os-starter.",
    "",
    'Run `cf-os api --help` for its commands and options, or `cf-os api search "<task>"` to find one.',
  ].join("\n");
}

/** What {@link cli} runs against, so tests can stand in for the process. */
export interface CliDeps {
  /** Where relative paths resolve: the directory the command was typed in. */
  cwd: string;
  out: Output;
  /** Raw stdout, for `--help`. */
  stdout: NodeJS.WritableStream;
}

/**
 * `cf-os <argv>`. Resolves to the exit code: 0; 1 for a failed call or a command cf-os does not
 * have here; 2 for a usage error, the command to change before it runs again (nothing was sent, or
 * the server asked for an `--answer` the command did not give); 130 on SIGINT.
 */
export async function cli(argv: string[], deps: CliDeps): Promise<number> {
  const [name] = argv;
  if (name === "api") {
    try {
      return await run(argv.slice(1), { cwd: deps.cwd, out: deps.out });
    } catch (error) {
      if (error instanceof UsageError) {
        deps.out.log(error.message);
        return 2;
      }
      // One line, no stack: a failure of the call, already explained by the session.
      deps.out.log(`\nAPI call failed. ${(error as Error)?.message ?? String(error)}`);
      return 1;
    }
  }
  if (name === undefined) {
    deps.out.log(usage());
    return 1;
  }
  if (name === "--help" || name === "-h") {
    deps.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (name.startsWith("-")) {
    deps.out.log(`cf-os takes its command first: \`pnpm cf-os api [options]\` (\`pnpm cf-os api --help\`); got "${name}".`);
    return 1;
  }
  deps.out.log(`cf-os has no command "${name}" here: in cloudflare-os it has only \`api\` (\`pnpm cf-os api --help\`). ` +
    "Its other commands (init, check, deploy, update, ...) are cloudflare-os-starter's: " +
    "https://github.com/cloudflare/cloudflare-os-starter.");
  return 1;
}

/**
 * The directory the command was typed in. A package script (`pnpm -w cf-os` from a package) runs
 * from the root and records the directory it was started from in `INIT_CWD`; that one is taken only
 * when it lies below, so an unrelated outer script's is ignored.
 */
export function invocationDir(cwd: string, env: NodeJS.ProcessEnv): string {
  const started = env.npm_lifecycle_event ? env.INIT_CWD : undefined;
  if (!started) return cwd;
  const below = relative(cwd, started);
  return below && !below.startsWith("..") && !isAbsolute(below) ? started : cwd;
}

/**
 * Ends the process with exit code `code`. A failed run exits once stdout and stderr have flushed,
 * rather than waiting on a socket still closing; a successful run is left to the event loop.
 */
export async function finish(code: number, exit: (code: number) => void = process.exit): Promise<void> {
  if (code === 0) {
    process.exitCode = code;
    return;
  }
  await Promise.all([process.stdout, process.stderr].map((stream) =>
    new Promise<void>((flushed) => stream.write("", () => flushed()))));
  exit(code);
}

if (import.meta.main) {
  await finish(await cli(process.argv.slice(2), { cwd: invocationDir(process.cwd(), process.env), out: consoleOutput(), stdout: process.stdout }));
}
