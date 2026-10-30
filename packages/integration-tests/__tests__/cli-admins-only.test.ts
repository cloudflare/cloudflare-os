// `cf-os api`, the real CLI (packages/api-cli), against the Workshop: on a local instance it may act
// as anyone; redeployed as a deployment (no WORKSHOP_ENVIRONMENT), only as a deployment admin,
// while a browser's session is unaffected.

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_USERNAME, startTestGatekeeperHarness, type Harness } from "../src/harness.js";
import { connect, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../api-cli/src/main.ts");
const PASSWORD = "integration-test-password";
const REFUSED = "On this deployment the cf-os CLI is limited to deployment admins";

// Redeployed halfway through, so this file owns its harness and runs serially.
let harness: Harness;
const [bob, carol] = nextUsernames("bob", "carol");

beforeAll(async () => {
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  await harness?.server.close();
});

/** `cf-os api --url <harness> <args>`, with `env` and nothing inherited but PATH. */
function cfOsApi(args: string[], env: Record<string, string> = {})
    : Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(settle => {
    execFile(process.execPath, [CLI, "api", "--url", harness.url.origin, ...args],
        { env: { PATH: process.env.PATH ?? "", ...env } },
        (error, stdout, stderr) => settle({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr,
        }));
  });
}

describe("on a local instance", () => {
  it("lets the CLI make accounts, read the public API and sign in as anyone", async () => {
    for (const username of [ADMIN_USERNAME, bob!]) {
      const made = await cfOsApi(["create-account", username], { CFOS_API_PASSWORD: PASSWORD });
      expect(made, made.stderr).toMatchObject({ code: 0 });
      expect(JSON.parse(made.stdout)).toMatchObject({ username });
    }
    const config = await cfOsApi(["public", "get-server-config"]);
    expect(config, config.stderr).toMatchObject({ code: 0 });

    const asBob = await cfOsApi(["--username", bob!, "am-i-admin"], { CFOS_API_PASSWORD: PASSWORD });
    expect(asBob, asBob.stderr).toMatchObject({ code: 0 });
    expect(JSON.parse(asBob.stdout)).toBe(false);
  });
});

describe("on a deployment", () => {
  beforeAll(async () => {
    await harness.redeployWorkshop(config => {
      delete config.vars!.WORKSHOP_ENVIRONMENT;
    });
    // The redeploy resolves at the first reload, which may still be the Workshop's earlier build.
    await waitFor("the Workshop to run as a deployment", async () =>
      (await harness.server.getWorker("workshop-backend").getEnv()).WORKSHOP_ENVIRONMENT === undefined
        ? true : null);
  });

  it("lets the CLI sign in as a deployment admin", async () => {
    const asAdmin = await cfOsApi(["--username", ADMIN_USERNAME, "am-i-admin"],
        { CFOS_API_PASSWORD: PASSWORD });
    expect(asAdmin, asAdmin.stderr).toMatchObject({ code: 0 });
    expect(JSON.parse(asAdmin.stdout)).toBe(true);
  });

  it("refuses the CLI anyone else, by password or token, and every call that signs no one in", async () => {
    const asBob = await cfOsApi(["--username", bob!, "am-i-admin"], { CFOS_API_PASSWORD: PASSWORD });
    expect(asBob).toMatchObject({ code: 1, stdout: "" });
    expect(asBob.stderr).toContain(REFUSED);

    // A browser signs carol up, and her session token is refused from the CLI.
    using publicApi = connect(harness.url);
    const token = await publicApi.createAccount(carol!, carol!, new Uint8Array([1, 2, 3]));
    if (token === null) throw new Error(`${carol} was taken.`);
    const asCarol = await cfOsApi(["--auth", "token", "am-i-admin"], { CFOS_API_TOKEN: token });
    expect(asCarol).toMatchObject({ code: 1 });
    expect(asCarol.stderr).toContain(REFUSED);

    const [dave] = nextUsernames("dave");
    for (const args of [["create-account", dave!], ["public", "get-server-config"]]) {
      const refused = await cfOsApi(args, { CFOS_API_PASSWORD: PASSWORD });
      expect(refused).toMatchObject({ code: 1, stdout: "" });
      expect(refused.stderr).toContain(REFUSED);
    }
  });

  it("leaves a browser's session alone", async () => {
    const [erin] = nextUsernames("erin");
    using publicApi = connect(harness.url);
    expect((await publicApi.getServerConfig()).signupsEnabled).toBe(true);
    using erinApi = await signUp(publicApi, erin!);
    expect(await erinApi.amIAdmin()).toBe(false);
  });
});
