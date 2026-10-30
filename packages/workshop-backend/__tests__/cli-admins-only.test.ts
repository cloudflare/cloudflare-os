// `cf-os api` on a deployment: a session whose upgrade names the CLI in its User-Agent may act only
// as a deployment admin, unless the instance is a local one (WORKSHOP_ENVIRONMENT "development" or
// "test").

import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { describe, expect, it, vi } from "vitest";
import type { UserDurableObject } from "../src/user.js";
import server from "../src/server.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// The Access JWT is taken as verified, naming whoever the request's assertion header does.
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(async (token: string) => ({ payload: { email: token } })),
}));

const CLI = "cf-os-api/1.0.0";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const REFUSED = /On this deployment the cf-os CLI is limited to deployment admins/;
const ORIGIN = "https://workshop.example";

// No admin config is stored: every read of it gets the defaults (signups open).
const BLUEPRINTS = { get: async () => null } as unknown as KVNamespace;

function unique(prefix: string): string {
  return prefix + crypto.randomUUID().replaceAll("-", "");
}

/** The deployment's env, with `admins` as ADMINS, and `environment` as WORKSHOP_ENVIRONMENT. */
function deployment(admins: string[], options: { environment?: string; access?: boolean } = {}): Cloudflare.Env {
  return {
    ...env,
    BLUEPRINTS,
    ADMINS: admins,
    ...(options.environment === undefined ? {} : { WORKSHOP_ENVIRONMENT: options.environment }),
    ...(options.access ? { CF_ACCESS_AUD: "aud", CF_ACCESS_ISS: "https://team.cloudflareaccess.com" } : {}),
  } as Cloudflare.Env;
}

/** A PublicApi session on `deploymentEnv`, opened with `userAgent` (and an Access identity, `as`). */
async function connect(deploymentEnv: Cloudflare.Env, userAgent: string | undefined, as?: string)
    : Promise<RpcStub<PublicApi>> {
  const headers: Record<string, string> = { Upgrade: "websocket", Origin: ORIGIN };
  if (userAgent !== undefined) headers["User-Agent"] = userAgent;
  if (as !== undefined) headers["cf-access-jwt-assertion"] = as;
  // The first /api request installs the bundled blueprints, which needs storage these tests lack.
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "exports", { value: Object.create(ctx.exports, {
    AdminSettings: { value: { getByName: () => ({ ensureBundledBlueprintsInstalled: async () => true }) } },
  }) });
  const response = await server.fetch(new Request(`${ORIGIN}/api`, { headers }), deploymentEnv, ctx);
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

/** A password account's session token, made directly in its user DO. */
async function account(username: string): Promise<string> {
  const secret = await env.TEST_USER.getByName(username)
      .createAccount(username, username, new Uint8Array([1, 2, 3]));
  if (secret === null) throw new Error(`${username} exists already.`);
  return `${username}:${secret}`;
}

describe("cf-os api on a deployment", () => {
  it("signs in as a deployment admin, with a token or a password", async () => {
    const admin = unique("admin");
    const token = await account(admin);
    using api = await connect(deployment([admin]), CLI);
    using session = api.authenticate(token);
    expect(await session.amIAdmin()).toBe(true);

    const password = await api.login(admin, new Uint8Array([1, 2, 3]));
    if (password === null) throw new Error("The admin's password was refused.");
    using again = api.authenticate(password);
    expect(await again.amIAdmin()).toBe(true);
  });

  it("refuses a sign-in as anyone else, by token or password", async () => {
    const user = unique("user");
    const token = await account(user);
    using api = await connect(deployment([unique("admin")]), CLI);
    await expect(api.authenticate(token).amIAdmin()).rejects.toThrow(REFUSED);

    // The password still checks out; the session token it yields is refused like any other.
    const password = await api.login(user, new Uint8Array([1, 2, 3]));
    if (password === null) throw new Error("The user's password was refused.");
    await expect(api.authenticate(password).amIAdmin()).rejects.toThrow(REFUSED);
  });

  it("refuses a bad token as a bad token, saying nothing of who is an admin", async () => {
    using api = await connect(deployment([]), CLI);
    await expect(api.authenticate(`${unique("user")}:AAAA`).amIAdmin()).rejects.toThrow(/session/i);
  });

  it("refuses a sign-in as anyone else under any other WORKSHOP_ENVIRONMENT", async () => {
    const token = await account(unique("user"));
    for (const environment of ["production", "Development", ""]) {
      using api = await connect(deployment([unique("admin")], { environment }), CLI);
      await expect(api.authenticate(token).amIAdmin()).rejects.toThrow(REFUSED);
    }
  });

  it("refuses every call that signs no one in: createAccount and the public commands", async () => {
    using api = await connect(deployment([]), CLI);
    const username = unique("newcomer");
    await expect(api.createAccount(username, username, new Uint8Array([1]))).rejects.toThrow(REFUSED);
    await expect(api.getServerConfig()).rejects.toThrow(REFUSED);
    await expect(api.ping()).rejects.toThrow(REFUSED);
    await expect(api.getBlueprint("format.document")).rejects.toThrow(REFUSED);
    await expect(api.downloadBlueprint("format.document")).rejects.toThrow(REFUSED);
    // Refused before anything was made: the name is still free.
    expect(await env.TEST_USER.getByName(username).createAccount(username, username, new Uint8Array([1])))
        .not.toBeNull();
  });

  it("signs in through Cloudflare Access as an admin only, creating no account for anyone else", async () => {
    const admin = `${unique("admin")}@example.com`;
    const other = `${unique("user")}@example.com`;
    const access = deployment([admin], { access: true });

    using adminApi = await connect(access, CLI, admin);
    using session = adminApi.authenticateFromCfAccess();
    expect(await session.amIAdmin()).toBe(true);

    using otherApi = await connect(access, CLI, other);
    await expect(otherApi.authenticateFromCfAccess().amIAdmin()).rejects.toThrow(REFUSED);
    // Refused before the account was made on first sign-in.
    expect(await env.TEST_USER.getByName(other).authenticateFromCfAccess(other, false)
        .then(() => "exists", (error: Error) => error.message)).toMatch(/sign-ups are currently disabled/);
  });
});

describe("other clients, and the CLI on a local instance", () => {
  for (const [what, userAgent, options] of [
    ["a browser on a deployment", BROWSER, {}],
    ["a client sending no User-Agent", undefined, {}],
    ["cf-os api under pnpm dev-server", CLI, { environment: "development" }],
    ["cf-os api in the integration harness", CLI, { environment: "test" }],
  ] as const) {
    it(`lets ${what} sign up, read the public API and sign in as anyone`, async () => {
      using api = await connect(deployment([unique("admin")], options), userAgent);
      expect((await api.getServerConfig()).signupsEnabled).toBe(true);
      const username = unique("user");
      const token = await api.createAccount(username, username, new Uint8Array([1, 2, 3]));
      if (token === null) throw new Error(`${username} was taken.`);
      using session = api.authenticate(token);
      expect(await session.amIAdmin()).toBe(false);
    });
  }
});
