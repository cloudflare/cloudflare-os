// A connection: which user, account and region PagerDuty's ID token names, the scopes it must
// grant, the user a reconnect must come back as, and which links the connection can bind.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { getRedirectUri, RESOURCES, type Env } from "../../src/pagerduty-env";
import { ACME, ALICE, BOB, DAVE, EURO, FakePagerDuty, accountStub, failure, hooks, seedAccount, unwrap, type FakeUser } from "./fake-pagerduty";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Runs a first connect up to PagerDuty's callback, PagerDuty authorizing `who`. Only refusals are
 * reached here: a grant that goes live mints the account entrypoint, which the test pool can't.
 */
async function connect(pd: FakePagerDuty, who: FakeUser) {
  const userObjectId = env.USER_ACCOUNT.newUniqueId().toString();
  const initiation = generateNonce();
  await hooks().installCallback(userObjectId, initiation);
  return { userObjectId, result: await authorize(pd, userObjectId, who, initiation) };
}

/** Reconnects `who`'s account as PagerDuty authorizing `as`, committing the grant it stages. */
async function reconnect(pd: FakePagerDuty, who: FakeUser, as = who) {
  const userObjectId = await seedAccount(pd, who);
  await hooks().installCallback(userObjectId, generateNonce());
  const { url } = unwrap(await hooks().user(userObjectId, "reconnect")) as { url: string };
  const result = await authorize(pd, userObjectId, as, url.split("/").at(-1)!);
  if ("handoff" in result!) unwrap(await hooks().user(userObjectId, "commitReconnect", result.handoff.ticket));
  return { userObjectId, result };
}

/** Takes the account through PagerDuty's authorization of `who`, from an armed initiation nonce. */
async function authorize(pd: FakePagerDuty, userObjectId: string, who: FakeUser, initiation: string) {
  return await runInDurableObject(accountStub(userObjectId), async instance => {
    const flow = await instance.beginOAuthFlow(initiation, getRedirectUri(env as Env));
    if (!flow) throw new Error("the connect flow did not start");
    const code = `code-${crypto.randomUUID()}`;
    pd.codes.set(code, who.id);
    try {
      return await instance.acceptAuthCode(code, flow.oauthNonce);
    } catch (error) {
      return { error: (error as Error).message };
    }
  });
}

describe("connecting", () => {
  it("takes the user, account and US region from the ID token, and the user's details from PagerDuty", async () => {
    const pd = new FakePagerDuty().install();
    pd.users.get(ALICE.id)!.name = "Alice Liddell";
    const { userObjectId } = await reconnect(pd, ALICE);
    expect(await accountStub(userObjectId).getIdentity()).toMatchObject({
      userId: ALICE.id, accountId: ACME.id, subdomain: "acme", region: "us", email: ALICE.email, name: "Alice Liddell", role: "user",
    });
    expect(pd.matching("GET", /^\/users\/me$/)[0].url.origin).toBe("https://api.pagerduty.com");
    expect(unwrap(await hooks().user(userObjectId, "describe"))).toMatchObject({
      displayName: "Alice Liddell", uniqueName: "alice@acme.test · acme.pagerduty.com",
    });
  });

  it("reads an EU account's region from the audience and asks PagerDuty's EU host", async () => {
    const pd = new FakePagerDuty().install();
    const { userObjectId } = await reconnect(pd, DAVE);
    expect(await accountStub(userObjectId).getIdentity()).toMatchObject({ accountId: EURO.id, subdomain: "euro", region: "eu" });
    expect(pd.matching("GET", /^\/users\/me$/)[0].url.origin).toBe("https://api.eu.pagerduty.com");
  });

  it("falls back to the region claim when the audience names no REST host", async () => {
    const pd = new FakePagerDuty().install();
    pd.claims = (_user, claims) => ({ ...claims, aud: ["test-client-id"] });
    const { userObjectId } = await reconnect(pd, DAVE);
    expect(await accountStub(userObjectId).getIdentity()).toMatchObject({ region: "eu" });
    expect(pd.matching("GET", /^\/users\/me$/)[0].url.origin).toBe("https://api.eu.pagerduty.com");
  });

  it("refuses an ID token that doesn't name the account", async () => {
    const pd = new FakePagerDuty().install();
    pd.claims = ({ id }) => ({ user_id: id, subdomain: "acme", region: "UnitedStates" });
    const { result } = await connect(pd, ALICE);
    expect(result).toEqual({ error: expect.stringMatching(/Could not read which PagerDuty user/) });
  });

  it("refuses a grant PagerDuty silently narrowed, naming what it dropped", async () => {
    const pd = new FakePagerDuty().install();
    pd.grantedScopes = "openid incidents.read";
    const { userObjectId, result } = await connect(pd, ALICE);
    expect(result).toMatchObject({
      refused: { title: "The PagerDuty app is missing permissions", detail: expect.stringMatching(/incidents\.write, services\.read/) },
    });
    expect(failure(await hooks().user(userObjectId, "describe"))).toMatch(/Reconnect the PagerDuty account/);
  });

  it("refuses a reconnect that comes back as another user", async () => {
    const pd = new FakePagerDuty().install();
    const { userObjectId, result } = await reconnect(pd, ALICE, BOB);
    expect(result).toMatchObject({ refused: { title: "That's a different PagerDuty user" } });
    expect(await accountStub(userObjectId).getIdentity()).toMatchObject({ userId: ALICE.id });
  });
});

describe("binding", () => {
  it.each([
    ["https://acme.pagerduty.com", "account"],
    ["https://acme.pagerduty.com/teams/PTEAM01", "team"],
    ["https://acme.pagerduty.com/service-directory/PSVC001/activity", "service"],
    ["https://acme.pagerduty.com/incidents/PINC001", "incident"],
    ["https://acme.pagerduty.com/schedules/PSCH001", "schedule"],
  ] as const)("binds %s as the %s", async (url, kind) => {
    const pd = new FakePagerDuty().install();
    const userObjectId = await seedAccount(pd, ALICE);
    expect(unwrap(await hooks().user(userObjectId, "getGatekeeperClassFor", url))).toMatchObject({ resource: RESOURCES[kind] });
  });

  it("binds an EU account's links to an EU connection", async () => {
    const pd = new FakePagerDuty().install();
    const userObjectId = await seedAccount(pd, DAVE);
    const bound = unwrap(await hooks().user(userObjectId, "getGatekeeperClassFor", "https://euro.eu.pagerduty.com/teams/PTEAM09"));
    expect(bound).toMatchObject({ resource: RESOURCES.team });
  });

  it.each([
    ["https://other.pagerduty.com/teams/PTEAM01", /other\.pagerduty\.com, but this connection is to acme\.pagerduty\.com/],
    ["https://acme.eu.pagerduty.com/teams/PTEAM01", /acme\.eu\.pagerduty\.com, but this connection is to acme\.pagerduty\.com/],
    ["https://example.com/teams/PTEAM01", /Not a PagerDuty link/],
    ["https://acme.pagerduty.com/users/PALICE1", /Not a PagerDuty link/],
  ])("refuses %s", async (url, message) => {
    const pd = new FakePagerDuty().install();
    const userObjectId = await seedAccount(pd, ALICE);
    expect(failure(await hooks().user(userObjectId, "getGatekeeperClassFor", url))).toMatch(message);
  });
});
