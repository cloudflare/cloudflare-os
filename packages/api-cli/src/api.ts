// `cf-os api [public] <command> [arguments] [<command> [arguments]]... [options]`
// `cf-os api search "<task>"`
// `cf-os api types [<service>]`
// `cf-os api create-account <username> [--display-name <name>]`
//
// Drives a running Cloudflare OS instance through its Cap'n Web API, the one the browser uses. The
// commands are not written here: they are the generated table (generated/commands.ts), which
// `pnpm api-schema:generate` writes from packages/workshop-shared/src/api.ts. This module reads the
// instance's address and the sign-in to use, then hands the walk to run.ts, or, for `search`, ranks
// the table's commands against the task, or, for `types`, prints the API's agent declarations
// (types.ts), or, for `create-account`, makes a password account, which no generated command may,
// since its password comes from the environment (create-account.ts). Without `--url`, the instance
// is the one the environment names (session.ts resolveTarget), which cloudflare-os-starter's `cf-os`
// sets when it runs this CLI.
//
// main.ts hands every token after `api` here, so the flags of each segment are parsed here, against
// that segment's command in the table.

import { constants, createReadStream, type Stats } from "node:fs";
import { access, lstat, readFile, readlink, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { table as generatedTable } from "../generated/commands.ts";
import type { ArgSource } from "./codec.ts";
import { accountHash, createAccount, createAccountHelp, DRY_RUN_HASH, parseCreateAccount } from "./create-account.ts";
import { UsageError, type Output } from "./output.ts";
import {
  commandHelp,
  decodeCalls,
  dryRunAnswers,
  dryRunChain,
  execute,
  incompleteChain,
  nodeHelp,
  parseInvocation,
  parseSearch,
  parseTypes,
  searchCommands,
  searchHelp,
  untypedHelp,
  type RunIo,
} from "./run.ts";
import { connect, defaultInstance, defaultSessionDeps, resolveAuth, resolveTarget, type SessionDeps } from "./session.ts";
import type { ApiTable } from "./table.ts";
import { agentTypes, typesHelp } from "./types.ts";

/** Where `cf-os api` runs, as main.ts gives it. */
export interface ApiContext {
  /** Where relative paths resolve. */
  cwd: string;
  out: Output;
}

/** Everything `cf-os api` touches besides the context, so tests can stand in for each. */
export interface ApiDeps extends SessionDeps {
  /** The command table: the generated one. */
  table: ApiTable;
  /** Raw stdout: help, NDJSON events and stream bytes. */
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  /** Read for `-` arguments. */
  stdin: NodeJS.ReadableStream;
  /** Calls `listener` on SIGINT; returns the function that stops listening. */
  onInterrupt(listener: () => void): () => void;
}

/** The process's own. */
export function defaultDeps(): ApiDeps {
  return {
    ...defaultSessionDeps(),
    table: generatedTable,
    stdout: process.stdout,
    // Read only for a `-` argument: touching process.stdin sooner would set it up for nothing.
    get stdin() {
      return process.stdin;
    },
    onInterrupt: (listener) => {
      process.on("SIGINT", listener);
      return () => process.off("SIGINT", listener);
    },
  };
}

/** A Node byte stream as a web one of plain `Uint8Array` chunks, the type capnweb sends as bytes. */
function webBytes(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return (Readable.toWeb(Readable.from(stream)) as unknown as ReadableStream<Uint8Array | string>).pipeThrough(
    new TransformStream<Uint8Array | string, Uint8Array>({
      transform: (chunk, controller) => controller.enqueue(typeof chunk === "string"
        ? new TextEncoder().encode(chunk)
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
    }));
}

/** Why a file could not be read, as `no such file (ENOENT)`: the code alone says little to most. */
function fileFault(error: unknown): string {
  const { code, message } = error as NodeJS.ErrnoException;
  const words: Record<string, string> = {
    ENOENT: "no such file",
    EISDIR: "it is a directory, not a file",
    EACCES: "permission denied",
    EPERM: "permission denied",
    ENAMETOOLONG: "the name is too long",
    ELOOP: "too many levels of symbolic links",
  };
  return code === undefined ? message : code in words ? `${words[code]} (${code})` : code;
}

/**
 * `path`, where `--out` would write, checked before anything is sent, in a dry run too: a directory,
 * a missing directory, one it cannot write to or a path the file system cannot resolve (too long, a
 * loop of links) would otherwise fail only once the call had run. A link to a file not yet made is
 * written through, so where it points is what is checked.
 */
async function checkOutput(path: string): Promise<void> {
  let found: Stats | undefined;
  try {
    found = await stat(path);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw new UsageError(`--out ${path}: ${fileFault(error)}.`);
    const link = await lstat(path).catch(() => undefined);
    if (link?.isSymbolicLink()) return checkOutput(resolve(dirname(path), await readlink(path)));
  }
  if (found?.isDirectory()) throw new UsageError(`--out ${path}: it is a directory, not a file.`);
  const directory = dirname(path);
  if (!found && !(await stat(directory).catch(() => undefined))?.isDirectory()) {
    throw new UsageError(`--out ${path}: its directory ${directory} does not exist.`);
  }
  try {
    await access(found ? path : directory, constants.W_OK);
  } catch {
    throw new UsageError(`--out ${path}: ${found ? "it" : `its directory ${directory}`} cannot be written.`);
  }
}

/** `cf-os api`, given every token after `api`. Resolves to the exit code; a failure is thrown. */
export async function run(tokens: string[], ctx: ApiContext, deps: ApiDeps = defaultDeps()): Promise<number> {
  const { table } = deps;
  // `types` prints declarations, the result itself, as plain text, as a byte stream's result is
  // written raw: wrapped in JSON, TypeScript would have to be unescaped before it could be read.
  const types = parseTypes(tokens);
  if (types) {
    // The declarations outgrow a pipe's buffer, so `| head` closes it mid-write: that EPIPE is the
    // reader being done, not a failure. Any other error is still thrown, as with no listener.
    deps.stdout.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
    deps.stdout.write(types.help ? `${typesHelp()}\n` : agentTypes(types.service));
    return 0;
  }
  // `search` finds commands in the table, before any walk: it connects to nothing.
  const search = parseSearch(tokens);
  if (search?.help) {
    deps.stdout.write(`${searchHelp()}\n`);
    return 0;
  }
  if (search) {
    if (!search.query.trim()) throw new UsageError('search needs a task: `cf-os api search "<describe the task>"`.');
    const matches = searchCommands(table, search.query);
    if (matches.length === 0) ctx.out.log("No command matches. `cf-os api --help` lists the first ones.");
    ctx.out.json(matches);
    return 0;
  }
  const account = parseCreateAccount(tokens);
  if (account?.help) {
    deps.stdout.write(`${createAccountHelp(defaultInstance(deps.env))}\n`);
    return 0;
  }
  if (account) {
    const target = resolveTarget(account.url, deps.env);
    // A public call: the inferred mode only says whether Access's edge needs its token.
    const auth = resolveAuth({ auth: account.auth }, deps.env, target.origin);
    if (account.dryRun) {
      ctx.out.json({
        url: target.url,
        auth: { mode: auth.mode },
        on: table.public,
        chain: [{ method: "createAccount", args: [account.username, account.displayName, DRY_RUN_HASH] }],
      });
      return 0;
    }
    const hash = await accountHash(account.username, deps.env, table.constants.SERVICE_SALT);
    // Its hint names --url as connected to: the origin alone, without credentials, path or query.
    return createAccount({ ...account, url: account.url === undefined ? undefined : target.origin }, hash,
      () => connect(target, auth, { serviceSalt: table.constants.SERVICE_SALT, needsSignIn: false, timeoutMs: millis(account.timeout) },
        deps), ctx.out);
  }
  const invocation = parseInvocation(table, tokens);
  if (invocation.help) {
    const target = invocation.help;
    const help = target.kind === "node" ? nodeHelp(table, target.node, invocation.path, defaultInstance(deps.env), target.call)
      : target.kind === "command" ? commandHelp(table, target.node, target.name, invocation.path, target.at, invocation.literal)
      : untypedHelp(invocation.path.slice(0, target.at), target.about);
    deps.stdout.write(`${invocation.misread ? `${invocation.misread}\n\n` : ""}${help}\n`);
    return 0;
  }
  // Nothing to call yet: a usage error, saying that nothing was sent and how to finish the chain.
  if (invocation.end.kind === "node" || invocation.end.kind === "untyped") {
    throw new UsageError(incompleteChain(table, invocation));
  }

  const { flags } = invocation;
  let stdinRead = false;
  const readStdin = async (): Promise<Uint8Array> => {
    stdinRead = true;
    const chunks: Uint8Array[] = [];
    for await (const chunk of deps.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    return new Uint8Array(Buffer.concat(chunks));
  };
  const source: ArgSource = {
    readFile: async (path) => {
      try {
        return new Uint8Array(await readFile(resolve(ctx.cwd, path)));
      } catch (error) {
        throw new UsageError(`could not read @${path}: ${fileFault(error)}.`, { cause: error });
      }
    },
    readStdin,
    // A stream argument's file, checked before connecting rather than failing once its call is sent.
    checkFile: async (path, typed) => {
      const file = resolve(ctx.cwd, path);
      try {
        if ((await stat(file)).isDirectory()) throw Object.assign(new Error(file), { code: "EISDIR" });
        await access(file, constants.R_OK);
      } catch (error) {
        throw new UsageError(`could not read ${typed}: ${fileFault(error)}.`);
      }
    },
  };
  // Only a run that needs an instance gets here, help, search and types having returned: without
  // --url, its environment's default (CFOS_API_URL, or CFOS_API_URL_UNAVAILABLE's reason) is read
  // now, before any argument is decoded, so a run with no instance fails, dry runs included, and a
  // run with --url never reads it.
  const target = resolveTarget(flags.url, deps.env);
  const auth = resolveAuth(flags, deps.env, target.origin);
  const decoded = await decodeCalls(table, invocation, source);
  const { calls, answers } = decoded;
  if (flags.out !== undefined && flags.out !== "-") await checkOutput(resolve(ctx.cwd, flags.out));
  if (flags.dryRun) {
    ctx.out.json({
      url: target.url,
      auth: auth.username === undefined ? { mode: auth.mode } : { mode: auth.mode, username: auth.username },
      on: invocation.public ? table.public : table.root,
      chain: dryRunChain(calls),
      ...answers.size ? { answers: dryRunAnswers(decoded) } : {},
    });
    return 0;
  }

  const io: RunIo = {
    out: ctx.out,
    stdout: deps.stdout,
    openStream: (path) => {
      if (path === "-") {
        if (stdinRead) throw new UsageError("Only one argument can read stdin (-).");
        return webBytes(deps.stdin);
      }
      // Checked as it was decoded (ArgSource.checkFile).
      return webBytes(createReadStream(resolve(ctx.cwd, path)));
    },
    outputPath: (path) => resolve(ctx.cwd, path),
    onInterrupt: deps.onInterrupt,
  };
  return execute(table, invocation, decoded,
    () => connect(target, auth,
      { serviceSalt: table.constants.SERVICE_SALT, needsSignIn: !invocation.public, timeoutMs: millis(flags.timeout) }, deps), io);
}

/** `--timeout`'s seconds as milliseconds. connect() is called as the run's timer starts, so it is what is left. */
const millis = (seconds: number | undefined) => seconds === undefined ? undefined : seconds * 1000;
