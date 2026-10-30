// `cf-os api create-account <username> [--display-name <name>]`: a password account on the instance,
// made through `PublicApi.createAccount` as the frontend's sign-up page makes one, so that whoever
// tests against a local or test instance has users to act as (`--username <name>`). A deployment
// usually signs users in through Access instead, and refuses it.
//
// createAccount takes a password hash, so the generated table leaves it out (generator/emit.ts's
// CREDENTIAL_METHODS): a secret never comes from argv. This command reads the password from
// CFOS_API_PASSWORD, as password sign-in does, and hashes it as sign-in does (session.ts's
// passwordHash), so the same CFOS_API_PASSWORD signs the new account in.

import { parseArgs } from "node:util";
import { UsageError, type Output } from "./output.ts";
import { CREATE_ACCOUNT, RUNTIME_OPTIONS, urlHelp } from "./run.ts";
import { DEV_SERVER_URL, defaultInstance, type DefaultInstance, passwordHash, requireEnv, type Session } from "./session.ts";

const OPTIONS = {
  "display-name": { type: "string" },
  url: { type: "string" },
  auth: { type: "string" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** `create-account`'s arguments, parsed. */
export interface CreateAccountArgs {
  /** Empty only with `help`. */
  username: string;
  displayName: string;
  url?: string;
  /** `access` or `token`: how to pass Access's edge, as for a public command; inferred when unset. */
  auth?: string;
  dryRun: boolean;
  help: boolean;
}

/**
 * The arguments when `tokens` -- everything after `cf-os api` but the global options -- are a
 * `create-account` (the first word that is not an option), else undefined.
 */
export function parseCreateAccount(tokens: string[]): CreateAccountArgs | undefined {
  // Found with every option `cf-os api` knows, as search and types are, so a runtime option before
  // the word does not hide it; the strict parse then rejects the ones it does not take.
  const loose = parseArgs({ args: tokens, options: { ...RUNTIME_OPTIONS, ...OPTIONS }, strict: false, allowPositionals: true });
  if (loose.positionals[0] !== CREATE_ACCOUNT) return undefined;
  let parsed: { values: { "display-name"?: string; url?: string; auth?: string; "dry-run"?: boolean; help?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({ args: tokens, options: OPTIONS, strict: true, allowPositionals: true });
  } catch (error) {
    const message = (error as Error).message.replace(/[^.!?]$/, "$&.");
    throw new UsageError(`${message} Run \`cf-os api create-account --help\` for its options.`);
  }
  const { values, positionals: [, username, extra] } = parsed;
  const help = values.help === true;
  if (!help && !username) {
    throw new UsageError("create-account needs <username>. Run `cf-os api create-account --help`.");
  }
  if (extra !== undefined) {
    // Not quoted: an extra argument is most likely a password, which is never echoed.
    throw new UsageError(`create-account takes one username, but another argument follows "${username}"; the password ` +
      "comes from CFOS_API_PASSWORD, never the command line. Run `cf-os api create-account --help`.");
  }
  if (values.auth === "password") {
    throw new UsageError("create-account signs in as no one: --auth is access or token. The new account's password " +
      "comes from CFOS_API_PASSWORD.");
  }
  return {
    username: username ?? "",
    displayName: values["display-name"] ?? username ?? "",
    url: values.url,
    auth: values.auth,
    dryRun: values["dry-run"] === true,
    help,
  };
}

/** Help for `cf-os api create-account`, its `--url` line saying what `instance`, the default instance, is. */
export function createAccountHelp(instance: DefaultInstance = defaultInstance({})): string {
  return [
    "Usage: cf-os api create-account <username> [--display-name <name>] [--url <origin>] [--auth access|token] [--dry-run]",
    "",
    "Creates a password account to act as, on a local or test instance (PublicApi.createAccount, as the",
    "sign-up page calls it). A deployment behind Cloudflare Access, or with signups or password sign-in",
    "off, refuses it.",
    "",
    "The password comes from CFOS_API_PASSWORD, never the command line, hashed as password sign-in",
    "hashes it. Then act as the new user with the same CFOS_API_PASSWORD and --username:",
    `  CFOS_API_PASSWORD=... cf-os api create-account bob --url ${DEV_SERVER_URL}`,
    `  CFOS_API_PASSWORD=... cf-os api whoami --url ${DEV_SERVER_URL} --username bob`,
    "",
    "Arguments:",
    "  <username>             a letter, then letters, digits or _; --username repeats it exactly, as the",
    "                         password's hash includes it",
    "",
    "Options:",
    "  --display-name <name>  the name others see (default: the username)",
    ...urlHelp(instance, 25),
    "  --auth access|token    access sends a Cloudflare Access token; token, for an instance not behind",
    "                         Access, sends nothing, as no one signs in (default: token for an http://",
    "                         origin or with CFOS_API_TOKEN set, else access)",
    "  --dry-run              print the call as JSON on stdout, without the password; connect to nothing",
    "",
    'Prints {"username", "displayName"} as JSON on stdout. A refusal (signups closed, password sign-in',
    "off, the name taken or invalid) fails, exit 1, naming the cause.",
  ].join("\n");
}

/** What `--dry-run` shows in the password hash's place. */
export const DRY_RUN_HASH = { $passwordHash: "CFOS_API_PASSWORD" };

/**
 * The hash of the new account's password, from CFOS_API_PASSWORD, as `--username <name>` will sign
 * in with it. Read and hashed before connecting: argon2id takes a moment.
 */
export async function accountHash(username: string, env: NodeJS.ProcessEnv, serviceSalt: readonly number[]): Promise<Uint8Array> {
  return passwordHash(username, requireEnv(env, "CFOS_API_PASSWORD", "create-account",
    " (the new account's password, which --username then signs in with)"), serviceSalt);
}

/**
 * Creates the account in a session from `connect`, without signing in, and prints it. The session
 * token createAccount returns is dropped unprinted: signing in again with `--username` makes another.
 */
export async function createAccount(
  args: CreateAccountArgs,
  hash: Uint8Array,
  connect: () => Promise<Session>,
  out: Output,
): Promise<number> {
  const session = await connect();
  try {
    let token: unknown;
    try {
      token = await session.main.createAccount(args.username, args.displayName, hash);
    } catch (error) {
      const explained = await session.explain(error);
      if (explained !== error) throw explained;
      throw new Error(`could not create the account ${args.username}: ${(error as Error)?.message ?? String(error)}`, { cause: error });
    }
    if (typeof token !== "string") {
      throw new Error(`could not create the account ${args.username}: the name is taken. Pick another, or act as it with ` +
        `--username ${args.username} and its password in CFOS_API_PASSWORD.`);
    }
    out.log(`Created ${args.username}. Act as it with \`cf-os api --username ${args.username} <command>\`` +
      `${args.url ? ` and --url ${args.url}` : ""}, the password in CFOS_API_PASSWORD.`);
    out.json({ username: args.username, displayName: args.displayName });
    return 0;
  } finally {
    try {
      session.main[Symbol.dispose]();
    } catch {
      // Already broken: there is nothing left to release.
    }
  }
}
