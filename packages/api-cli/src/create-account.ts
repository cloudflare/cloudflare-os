// `cf-os api create-account <username> [--display-name <name>]`: a password account on the instance,
// made through `PublicApi.createAccount` as the frontend's sign-up page makes one, so that whoever
// tests against a local or test instance has users to act as (`--username <name>`). A deployment
// refuses it from the CLI, which it limits to its admins (README.md, "Deployment admins only").
//
// createAccount takes a password hash, so the generated table leaves it out (generator/emit.ts's
// CREDENTIAL_METHODS): a secret never comes from argv. This command reads the password from
// CFOS_API_PASSWORD, as password sign-in does, and hashes it as sign-in does (session.ts's
// passwordHash), so the same CFOS_API_PASSWORD signs the new account in.

import { UsageError, type Output } from "./output.ts";
import { commandWord, CREATE_ACCOUNT, parseSegment, RUNTIME_OPTIONS, timeoutSeconds, urlHelp } from "./run.ts";
import { DEV_SERVER_URL, defaultInstance, type DefaultInstance, passwordHash, requireEnv, type Session } from "./session.ts";

/** Its options: the API options, and the new account's display name. */
const OPTIONS = { ...RUNTIME_OPTIONS, "display-name": { type: "string" } } as const;

/**
 * Why each API option that does not apply to create-account is refused, rather than ignored: each
 * would otherwise be taken to do what it does for a generated command.
 */
const INAPPLICABLE: Partial<Record<keyof typeof OPTIONS, string>> = {
  username: "create-account signs in as no one, and the new account's name is its <username> argument; " +
    "--username then signs in as it",
  answer: "its call asks nothing back",
  out: "it prints the new account as JSON on stdout",
};

/** `create-account`'s arguments, parsed. */
export interface CreateAccountArgs {
  /** Empty only with `help`. */
  username: string;
  displayName: string;
  /** `--url` as given; createAccount prints it, so it is passed the origin it resolved to. */
  url?: string;
  /** `access` or `token`: how to pass Access's edge, as for a public command; inferred when unset. */
  auth?: string;
  dryRun: boolean;
  /** Seconds: the run fails once they have passed. */
  timeout?: number;
  help: boolean;
}

/**
 * The arguments when `tokens` -- everything after `cf-os api` but the global options -- are a
 * `create-account` (the first word that is not an option), else undefined.
 */
export function parseCreateAccount(tokens: string[]): CreateAccountArgs | undefined {
  // Found with every option `cf-os api` knows, as search and types are, so a runtime option before
  // the word does not hide it.
  if (commandWord(tokens, OPTIONS) !== CREATE_ACCOUNT) return undefined;
  const { values, positionals: [, username, extra] } = parseSegment(tokens, OPTIONS, CREATE_ACCOUNT);
  const help = values.help === true;
  for (const [option, why] of Object.entries(INAPPLICABLE)) {
    if (values[option] !== undefined) {
      throw new UsageError(`--${option} does not apply to create-account: ${why}. Run \`cf-os api create-account --help\` for its options.`);
    }
  }
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
  const timeout = timeoutSeconds(values.timeout as string | undefined);
  return {
    username: username ?? "",
    displayName: (values["display-name"] as string | undefined) ?? username ?? "",
    url: values.url as string | undefined,
    auth: values.auth as string | undefined,
    dryRun: values["dry-run"] === true,
    ...timeout === undefined ? {} : { timeout },
    help,
  };
}

/** Help for `cf-os api create-account`, its `--url` line saying what `instance`, the default instance, is. */
export function createAccountHelp(instance: DefaultInstance = defaultInstance({})): string {
  return [
    "Usage: cf-os api create-account <username> [--display-name <name>] [--url <origin>] [--auth access|token]",
    "                                [--timeout <seconds>] [--dry-run]",
    "",
    "Creates a password account to act as, on a local or test instance (PublicApi.createAccount, as the",
    "sign-up page calls it). A deployment refuses it, as it limits the CLI to its admins, and so does an",
    "instance with signups or password sign-in off.",
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
    "  --timeout <seconds>    fail if the account is not made after this long; without it, no limit",
    "  --dry-run              print the call as JSON on stdout, without the password; connect to nothing",
    "",
    "The other API options do not apply, and are refused, saying why: --username (the new account's name",
    "is <username>), --answer and --out.",
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
  const { promise: expired, reject: expire } = Promise.withResolvers<never>();
  expired.catch(() => {});
  const timer = args.timeout === undefined ? undefined
    : setTimeout(() => expire(new Error(`timed out after ${args.timeout}s.`)), args.timeout * 1000);
  /** `promise`, unless `--timeout` runs out first. */
  const within = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, expired]);
  // Kept so that a session which opens after the timeout is still closed: its socket would otherwise
  // hold the process open.
  const connecting = connect();
  let session: Session | undefined;
  try {
    session = await within(connecting);
    let token: unknown;
    try {
      token = await within(Promise.resolve(session.main.createAccount(args.username, args.displayName, hash)));
    } catch (error) {
      const explained = await within(session.explain(error));
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
    clearTimeout(timer);
    if (session) close(session);
    else connecting.then(close, () => {});
  }
}

/** Closes `session`'s connection. */
function close(session: Session): void {
  try {
    session.main[Symbol.dispose]();
  } catch {
    // Already broken: there is nothing left to release.
  }
}
