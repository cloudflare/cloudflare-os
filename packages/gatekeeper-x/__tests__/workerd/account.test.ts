// The account Durable Object: one redemption of a single-use refresh token however many reads race
// it, a dead grant recognized in either of X's spellings, a connection pinned to the X user it was
// made as, revocation local-first, and the connect link's authorize request. X is faked at `fetch`.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import worker from "../../src/x";
import { RESOURCES, getRedirectUri, scopesFor, type Env } from "../../src/x-env";
import type { PublicGrant } from "../../src/x-credentials";
import {
  ALICE, BOB, FakeX, accountStub, failure, hooks, identityOf, json, reconnectAs, seedAccount, unwrap,
} from "./fake-x";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Credentials = { creds: PublicGrant; identity: string; generation: string };

async function storedGrant(userObjectId: string): Promise<{ accessToken: string; refreshToken?: string } | undefined> {
  return await runInDurableObject(accountStub(userObjectId), async (_instance, state) =>
    state.storage.kv.get<{ accessToken: string; refreshToken?: string }>("credentials"));
}

function ctx() {
  return { exports: { UserAccount: env.USER_ACCOUNT } } as unknown as ExecutionContext;
}

describe("credentials", () => {
  it("redeems an expired grant's refresh token once, however many reads race it", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x, ALICE, { expiresInMs: 0 });
    const reads = await Promise.all(Array.from({ length: 8 }, () => hooks().account(id, "getCredentials")));
    const tokens = new Set(reads.map(read => (unwrap(read) as Credentials).creds.accessToken));
    expect(tokens.size).toBe(1);
    expect(x.count("POST", /^\/2\/oauth2\/token/)).toBe(1);
    expect(new URLSearchParams(x.requests[0].body).get("grant_type")).toBe("refresh_token");
    // The rotated pair was kept: the next refresh redeems the new refresh token.
    expect((await storedGrant(id))?.accessToken).toBe([...tokens][0]);
  });

  it("never sends the refresh token outside the account", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x);
    const read = unwrap(await hooks().account(id, "getCredentials")) as Credentials;
    expect(Object.keys(read.creds).toSorted()).toEqual(["accessToken", "expiresAt", "scopes"]);
  });

  it.each([
    ["invalid_request", { error: "invalid_request", error_description: "Value passed for the token was invalid." }],
    ["invalid_grant", { error: "invalid_grant", error_description: "Token was revoked." }],
  ])("treats a refresh refused with %s as the grant's death, and says so once", async (_label, refusal) => {
    const x = new FakeX().install();
    const id = await seedAccount(x, ALICE, { expiresInMs: 0 });
    await hooks().installCallback(id, generateNonce(), scopesFor());
    x.on("POST", /^\/2\/oauth2\/token/, () => json(refusal, { status: 400 }));
    const reconnect = "The X connection has expired or was revoked. Reconnect the X account.";
    expect(failure(await hooks().account(id, "getCredentials"))).toBe(reconnect);
    expect(failure(await hooks().account(id, "getCredentials"))).toBe(reconnect);
    expect(x.count("POST", /^\/2\/oauth2\/token/)).toBe(1);
    expect(await hooks().expiredNotices(id)).toBe(1);
  });

  it("treats any other refresh failure as passing", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x, ALICE, { expiresInMs: 0 });
    x.on("POST", /^\/2\/oauth2\/token/, () => json({ error: "temporarily_unavailable" }, { status: 503 }));
    expect(failure(await hooks().account(id, "getCredentials"))).not.toMatch(/Reconnect/);
    expect(await hooks().expiredNotices(id)).toBe(0);
  });
});

describe("reconnecting", () => {
  it("refuses a reconnect as another X user, and revokes what X granted it", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x);
    await hooks().installCallback(id, generateNonce(), scopesFor());
    const before = await storedGrant(id);
    const result = await reconnectAs(x, id, BOB);
    expect(result).toEqual({
      refused: { title: "That's a different X account", detail: expect.stringContaining("This connection is for @alice") },
    });
    // Bob's new pair, refresh token first; Alice's live grant is untouched.
    expect(x.revoked).toHaveLength(2);
    expect(x.revoked[0]).toMatch(/^refresh-/);
    expect(x.revoked[1]).toMatch(/^access-/);
    expect(await storedGrant(id)).toEqual(before);
  });

  it("stages a same-user reconnect until the Workshop commits it, revoking nothing", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x);
    await hooks().installCallback(id, generateNonce(), scopesFor());
    const before = await storedGrant(id);
    const result = await reconnectAs(x, id, ALICE) as { handoff: { ticket: string } };
    expect(await storedGrant(id)).toEqual(before);
    unwrap(await hooks().account(id, "commitReconnect", result.handoff.ticket));
    expect((await storedGrant(id))?.accessToken).not.toBe(before?.accessToken);
    expect(x.revoked).toEqual([]);
    expect(failure(await hooks().account(id, "commitReconnect", result.handoff.ticket))).toMatch(/No reconnect is awaiting/);
  });

  it("revokes the grant a first connect leaves when the Workshop never takes it", async () => {
    const x = new FakeX().install();
    const accountId = env.USER_ACCOUNT.newUniqueId();
    const initiation = generateNonce();
    await hooks().installCallback(accountId.toString(), initiation, scopesFor());
    await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (instance, state) => {
      // This pool cannot mint the decorated account entrypoint (see `TestUser`); its twin stands in.
      Object.defineProperty(state.exports, "GatekeeperUserImpl", { value: Reflect.get(state.exports, "TestUser") });
      const flow = await instance.beginOAuthFlow(initiation, getRedirectUri(env as Env));
      x.codes.set("code-first", ALICE.id);
      await expect(instance.acceptAuthCode("code-first", flow!.oauthNonce)).rejects.toThrow(/Workshop unreachable/);
      expect(state.storage.kv.get("credentials")).toBeUndefined();
      expect(state.storage.kv.get("identity")).toBeUndefined();
    });
    expect(x.revoked.map(token => token.split("-")[0])).toEqual(["refresh", "access"]);
  });
});

describe("the connect link", () => {
  it("sends the browser to X's authorize page with a PKCE challenge and the requested scopes", async () => {
    const x = new FakeX().install();
    const doId = env.USER_ACCOUNT.newUniqueId().toString();
    const initiation = generateNonce();
    const scopes = scopesFor([RESOURCES.list.urlPattern]);
    await hooks().installCallback(doId, initiation, scopes);
    const response = await worker.fetch(new Request(`http://localhost:8787/gatekeeper/x/${doId}/${initiation}`), env as Env, ctx());
    expect(response.status).toBe(302);
    const authorize = new URL(response.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("test-client-id");
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://localhost:8787/gatekeeper/x/oauth");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get("scope")!.split(" ").toSorted()).toEqual(scopes.toSorted());
    expect(x.requests).toHaveLength(0);

    // X's refusal ends the attempt, so replaying its callback finds nothing to resume.
    const state = authorize.searchParams.get("state")!;
    const refused = await worker.fetch(new Request(`http://localhost:8787/gatekeeper/x/oauth?error=access_denied&state=${state}`),
      env as Env, ctx());
    expect(refused.status).toBe(400);
    const replayed = await worker.fetch(new Request(`http://localhost:8787/gatekeeper/x/oauth?code=late&state=${state}`),
      env as Env, ctx());
    expect(await replayed.text()).toMatch(/invalid|expired/i);
  });

  it("shows the refusal page when X authorized a different account", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x);
    const initiation = generateNonce();
    await hooks().installCallback(id, generateNonce(), scopesFor());
    unwrap(await hooks().account(id, "prepareReconnect", initiation, scopesFor()));
    const start = await worker.fetch(new Request(`http://localhost:8787/gatekeeper/x/${id}/${initiation}`), env as Env, ctx());
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    x.codes.set("code-bob", BOB.id);
    const callback = await worker.fetch(new Request(`http://localhost:8787/gatekeeper/x/oauth?code=code-bob&state=${state}`),
      env as Env, ctx());
    expect(callback.status).toBe(409);
    expect(await callback.text()).toContain("That&#39;s a different X account");
  });
});

describe("identity", () => {
  it("serves the pinned identity for a day with no call to X", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x);
    const description = unwrap(await hooks().user(id, "describe")) as { displayName: string; uniqueName: string };
    expect(description).toMatchObject({ displayName: "Alice", uniqueName: "@alice" });
    expect(x.requests).toHaveLength(0);
  });

  it("reads it again once a day old, never letting the pin move", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x, ALICE, { identity: { fetchedAt: Date.now() - 25 * 60 * 60 * 1000 } });
    x.users.set(ALICE.id, { ...ALICE, name: "Alice Renamed" });
    expect(unwrap(await hooks().user(id, "describe"))).toMatchObject({ displayName: "Alice Renamed" });
    expect(x.count("GET", /^\/2\/users\/me/)).toBe(1);

    const stale = await seedAccount(x, ALICE, { identity: { fetchedAt: 0 } });
    x.on("GET", /^\/2\/users\/me/, () => json({ data: { ...BOB } }));
    expect(unwrap(await hooks().user(stale, "describe"))).toMatchObject({ uniqueName: "@alice" });
  });

  it("takes an account X didn't say was public for a protected one", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x, ALICE, { identity: { fetchedAt: 0 } });
    x.on("GET", /^\/2\/users\/me/, () => json({ data: { id: ALICE.id, username: "alice", name: "Alice" } }));
    expect(unwrap(await hooks().account(id, "getIdentity"))).toMatchObject({ id: ALICE.id, protected: true });
  });

  it("reports only the resource types the grant covers", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x, ALICE, { scopes: scopesFor([RESOURCES.profile.urlPattern]) });
    expect(unwrap(await hooks().user(id, "describe"))).toMatchObject({
      grantedResourceUrlPatterns: [RESOURCES.profile.urlPattern],
    });
  });
});

describe("disconnecting", () => {
  it("clears the account before telling X, and survives X failing to answer", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x);
    const grant = await storedGrant(id);
    x.on("POST", /^\/2\/oauth2\/revoke/, () => json({ error: "server_error" }, { status: 500 }));
    unwrap(await hooks().user(id, "revoke"));
    const keys = await runInDurableObject(accountStub(id), async (_instance, state) => [...state.storage.kv.list()]);
    expect(keys).toEqual([]);
    expect(x.requests.filter(r => r.url.pathname === "/2/oauth2/revoke")
      .map(r => new URLSearchParams(r.body).get("token"))).toEqual([grant?.refreshToken, grant?.accessToken]);
  });

  it("has nothing to revoke with an identity for nobody", async () => {
    const x = new FakeX().install();
    const id = await seedAccount(x);
    unwrap(await hooks().user(id, "revoke"));
    expect(failure(await hooks().user(id, "describe"))).toMatch(/Reconnect the X account/);
    expect(identityOf(ALICE).id).toBe(ALICE.id);
  });
});
