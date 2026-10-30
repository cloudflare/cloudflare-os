// `cf-os api types`: the generated copy is api-schema's agent declarations, and the command prints
// them whole or per service, refusing a service they do not have, from the entry point as an agent
// runs it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { declarations, fragments } from "../generated/agent-types.ts";
import { UsageError } from "./output.ts";
import { agentTypes, typesHelp } from "./types.ts";

const MAIN = join(import.meta.dirname, "main.ts");
/** api-schema's generated declarations, which `pnpm api-schema:generate` copies beside the command table. */
const UPSTREAM = join(import.meta.dirname, "..", "..", "api-schema", "generated");

/** `cf-os api <args>`, as the root `pnpm cf-os` script runs it, with none of the caller's environment but PATH. */
function api(...args: string[]) {
  return spawnSync(process.execPath, [MAIN, "api", ...args], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
}

test("the generated copy is api-schema's declarations and fragments, verbatim", () => {
  assert.equal(declarations, readFileSync(join(UPSTREAM, "workshop-api.agent.d.ts"), "utf8"));
  assert.deepEqual(fragments, JSON.parse(readFileSync(join(UPSTREAM, "workshop-api.fragments.json"), "utf8")));
});

test("prints the whole declarations, or one service's, as plain text on stdout, connecting to nothing", () => {
  const whole = api("types");
  assert.equal(whole.status, 0, whole.stderr);
  assert.equal(whole.stdout, declarations);
  assert.match(whole.stdout, /^export interface AuthenticatedApi \{$/m);

  // Runtime options are taken and ignored: an unreachable --url is never dialled.
  const one = api("--url", "https://example.invalid", "types", "AdminApi");
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.stdout, fragments.AdminApi);
  assert.match(one.stdout, /^export interface AdminApi \{$/m);
  assert.doesNotMatch(one.stdout, /^export interface AuthenticatedApi \{$/m);

  const help = api("types", "--help");
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout, `${typesHelp()}\n`);
  assert.match(help.stdout, new RegExp(`^Services: ${Object.keys(fragments).join(", ")}\\.$`, "m"));
  assert.match(api("--help").stdout, /^`cf-os api types \[<service>\]` prints the API as TypeScript declarations/m);
});

test("an unknown service, or a second one, is a usage error naming the services, printing nothing", () => {
  const unknown = api("types", "Nope");
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /^No service "Nope" in the API's declarations\. The services: ActionsSubscriber, AdminApi, .*\bOverseer\b.*\.$/m);
  assert.throws(() => agentTypes("toString"), UsageError);
  assert.throws(() => agentTypes("B", { declarations: "", fragments: { A: "a" } }),
    (error: unknown) => error instanceof UsageError && error.message === 'No service "B" in the API\'s declarations. The services: A.');

  const two = api("types", "AdminApi", "Overseer");
  assert.equal(two.status, 2);
  assert.equal(two.stdout, "");
  assert.match(two.stderr, /types takes one service, but "Overseer" follows "AdminApi"\./);
});
