import assert from "node:assert/strict";
import test from "node:test";
import { table } from "../generated/commands.ts";
import { accountHash, createAccountHelp, parseCreateAccount } from "./create-account.ts";
import { UsageError } from "./output.ts";
import { passwordHash } from "./session.ts";

const SALT = table.constants.SERVICE_SALT;

/** What CFOS_API_URL_UNAVAILABLE says in a starter whose deployment file is not configured. */
const REASON = "deployment.jsonc is not configured yet (https://<your-domain>): pass --url <origin>.";

/** `text` with every run of whitespace one space, so wrapped help reads as one line. */
const flat = (text: string) => text.replace(/\s+/g, " ");

test("`create-account` is the command only as the first word that is not an option", () => {
  assert.deepEqual(parseCreateAccount(["create-account", "bob"]),
    { username: "bob", displayName: "bob", url: undefined, auth: undefined, dryRun: false, help: false });
  assert.deepEqual(parseCreateAccount(["--url", "http://localhost:8787", "create-account", "bob", "--display-name", "Bob B", "--dry-run"]),
    { username: "bob", displayName: "Bob B", url: "http://localhost:8787", auth: undefined, dryRun: true, help: false });
  assert.deepEqual(parseCreateAccount(["create-account", "-h"]), { username: "", displayName: "", url: undefined, auth: undefined, dryRun: false, help: true });
  assert.equal(parseCreateAccount(["open-notebook", "create-account"]), undefined);
  assert.equal(parseCreateAccount(["search", "create-account"]), undefined);
});

function usage(tokens: string[], message: RegExp): void {
  assert.throws(() => parseCreateAccount(tokens), (error: Error) => error instanceof UsageError && message.test(error.message));
}

test("`create-account` usage errors name what is wrong and its help", () => {
  usage(["create-account"], /^create-account needs <username>\. Run `cf-os api create-account --help`\.$/);
  // An extra argument is most likely a password: it is not echoed, and the error says where one goes.
  usage(["create-account", "bob", "s3cret"], /^create-account takes one username, but another argument follows "bob"; the password comes from CFOS_API_PASSWORD/);
  assert.throws(() => parseCreateAccount(["create-account", "bob", "s3cret"]), (error: Error) => !error.message.includes("s3cret"));
  // The password never comes from argv, and the account is the argument, not a sign-in.
  usage(["create-account", "bob", "--password", "x"], /Unknown option '--password'.*Run `cf-os api create-account --help` for its options\.$/);
  usage(["create-account", "bob", "--username", "alice"], /Unknown option '--username'/);
  usage(["create-account", "bob", "--display-name"], /--display-name/);
  // --auth says how to pass Access's edge, as for a public command; no one signs in, so not password.
  assert.equal(parseCreateAccount(["create-account", "bob", "--auth", "token"])?.auth, "token");
  usage(["create-account", "bob", "--auth", "password"], /^create-account signs in as no one: --auth is access or token\./);
  // Runtime options before the word still find create-account, which then refuses those it does not take.
  for (const option of ["--username", "--timeout", "--out"]) {
    usage([option, "x", "create-account", "alice"], new RegExp(`^Unknown option '${option}'.*Run .cf-os api create-account --help. for its options[.]$`));
  }
  // It calls nothing that takes a callback, so nothing it does is answered.
  usage(["create-account", "bob", "--answer", "X.y=1"], /^Unknown option '--answer'.*Run `cf-os api create-account --help` for its options\.$/);
});

test("the password is CFOS_API_PASSWORD, hashed as sign-in hashes it; unset, the failure names it", async () => {
  assert.deepEqual(await accountHash("bob", { CFOS_API_PASSWORD: "hunter2" }, SALT), await passwordHash("bob", "hunter2", SALT));
  await assert.rejects(accountHash("bob", {}, SALT), /^Error: create-account reads the secret from CFOS_API_PASSWORD, which is not set/);
});

test("its help says it is for a local or test instance, where the password comes from and how to act as the user", () => {
  const help = createAccountHelp();
  assert.match(help, /^Usage: cf-os api create-account <username> \[--display-name <name>\]/);
  assert.match(help, /on a local or test instance/);
  assert.match(help, /The password comes from CFOS_API_PASSWORD, never the command line/);
  assert.match(help, /cf-os api whoami --url http:\/\/localhost:8787 --username bob/);
  assert.ok(flat(help).includes("--url <origin> the instance (default: http://localhost:8787, where `pnpm dev-server` listens; " +
    "CFOS_API_URL names another); http:// only for a local dev server"));
  // In a starter with no deployment origin, its --url line gives the reason instead of a default.
  const none = flat(createAccountHelp({ kind: "unavailable", reason: REASON }));
  assert.ok(none.includes(`No default here: ${REASON}`));
  assert.ok(!none.includes("the instance (default:"));
});
