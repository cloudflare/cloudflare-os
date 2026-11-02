// The account Durable Object against a fake Entra ID and Graph: the connect link's authorize request,
// a first connect pinned to the (tenant, user) that signed in, every way a callback is refused,
// reconnects staged until the Workshop commits them, refresh serialized and its death recognized,
// and disconnecting with nothing left behind.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import worker from "../../src/microsoft";
import type { PublicGrant } from "../../src/microsoft-credentials";
import { SHAREPOINT_RESOURCE, getRedirectUri, scopesFor, type Env } from "../../src/microsoft-env";
import {
  CLIENT_ID, FakeGraph, LOGIN, MALLORY, OTHER_TENANT, PHILLIP, SARAH, TENANT, accountStub, failure, hooks,
  json, reconnectAs, seedAccount, storedGrant, unwrap,
} from "./fake-graph";

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE = "http://localhost:8787/gatekeeper/microsoft";
const RECONNECT = "The Microsoft 365 connection has expired or was revoked. Reconnect the Microsoft 365 account.";

type Credentials = { creds: PublicGrant; identity: string; generation: string };

function ctx() {
  return { exports: { UserAccount: env.USER_ACCOUNT } } as unknown as ExecutionContext;
}

async function fetchWorker(url: string): Promise<Response> {
  return await worker.fetch(new Request(url), env as Env, ctx());
}

async function storageKeys(userObjectId: string): Promise<string[]> {
  return await runInDurableObject(accountStub(userObjectId), async (_instance, state) =>
    [...state.storage.kv.list()].map(([key]) => key));
}

/**
 * Runs a first connect inside a new account up to the callback, Entra authorizing `user` with any
 * ID token claims overridden. Returns the account id and what the callback answered or threw.
 */
async function firstConnect(graph: FakeGraph, user = PHILLIP, claims?: Record<string, unknown>) {
  const accountId = env.USER_ACCOUNT.newUniqueId();
  const initiation = generateNonce();
  await hooks().installCallback(accountId.toString(), initiation, scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]));
  const result = await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (instance, state) => {
    // This pool cannot mint the decorated account entrypoint (see `TestUser`); its twin stands in.
    Object.defineProperty(state.exports, "GatekeeperUserImpl", { value: Reflect.get(state.exports, "TestUser") });
    const flow = await instance.beginOAuthFlow(initiation, getRedirectUri(env as Env));
    if (!flow) throw new Error("the connect did not start");
    graph.codes.set("code-first", { user, ...(claims ? { claims } : {}) });
    try {
      return { ok: await instance.acceptAuthCode("code-first", flow.oauthNonce) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  });
  return { id: accountId.toString(), result };
}

/** Starts a connect through the link, as the browser does, and returns the `state` Entra will echo. */
async function startFlow(): Promise<{ id: string; state: string }> {
  const id = env.USER_ACCOUNT.newUniqueId().toString();
  const initiation = generateNonce();
  await hooks().installCallback(id, initiation, scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]));
  const response = await fetchWorker(`${BASE}/${id}/${initiation}`);
  return { id, state: new URL(response.headers.get("location")!).searchParams.get("state")! };
}

describe("first connect", () => {
  it("pins the account that signed in, with its tenant's SharePoint host", async () => {
    const graph = new FakeGraph().install();
    const { id, result } = await firstConnect(graph);
    expect(result).toEqual({ ok: { handoff: { targetOrigin: "http://localhost:8787", ticket: "first-connect" } } });

    const [exchange] = graph.tokenRequests();
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("redirect_uri")).toBe(`${BASE}/oauth`);
    expect(exchange.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(graph.requests[0].url.pathname).toBe(`/${TENANT}/oauth2/v2.0/token`);

    const grant = await storedGrant(id);
    expect(grant).toMatchObject({ accessToken: expect.stringMatching(/^access-Phillip-/), refreshToken: expect.stringMatching(/^refresh-/) });
    // What was asked for is kept for every refresh, since Entra's v2 refresh wants the scopes named.
    expect(grant?.requestedScopes).toEqual(scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]));
    expect(unwrap(await hooks().account(id, "getIdentity"))).toMatchObject({
      tenantId: TENANT, objectId: PHILLIP.oid, name: "Phillip", username: PHILLIP.upn, sharePointTenant: "contoso",
    });
    expect(unwrap(await hooks().user(id, "describe"))).toMatchObject({
      displayName: "Phillip", uniqueName: PHILLIP.upn, grantedResourceUrlPatterns: ["https://*.sharepoint.com/*"],
    });
  });

  it("connects a user with no SharePoint license, without a host", async () => {
    const graph = new FakeGraph().install();
    graph.on("GET", /^\/v1\.0\/sites\/root/, () => json({ error: { code: "accessDenied", message: "No license." } }, { status: 403 }));
    const { id, result } = await firstConnect(graph);
    expect(result).toHaveProperty("ok.handoff");
    const identity = unwrap<Record<string, unknown>>(await hooks().account(id, "getIdentity"));
    expect(identity.sharePointTenant).toBeUndefined();
    expect(failure(await hooks().user(id, "getGatekeeperClassFor", "https://contoso.sharepoint.com/sites/Engineering")))
      .toMatch(/no SharePoint or OneDrive/);
  });

  it("refuses an account from a tenant the deployment doesn't accept, storing nothing", async () => {
    const graph = new FakeGraph().install();
    const { id, result } = await firstConnect(graph, MALLORY);
    expect(result).toEqual({ ok: { refused: { title: "That organization can't connect here", detail: expect.any(String) } } });
    expect(await storedGrant(id)).toBeUndefined();
    expect(await storageKeys(id)).not.toContain("identity");
    // Refused on the token's own claims: Graph was never asked who signed in.
    expect(graph.requests.filter(request => request.url.origin !== LOGIN)).toEqual([]);
  });

  it("refuses an ID token issued to another app", async () => {
    const graph = new FakeGraph().install();
    const { id, result } = await firstConnect(graph, PHILLIP, { aud: "99999999-0000-0000-0000-000000000000" });
    expect(result).toEqual({ error: "Microsoft sent a sign-in token for another app." });
    expect(await storedGrant(id)).toBeUndefined();
  });

  it("refuses when Graph describes someone other than the ID token's user", async () => {
    const graph = new FakeGraph().install();
    const { id, result } = await firstConnect(graph, PHILLIP, { oid: SARAH.oid });
    expect(result).toEqual({ error: expect.stringMatching(/different account than the one that signed in/) });
    expect(await storedGrant(id)).toBeUndefined();
    expect(await storageKeys(id)).not.toContain("identity");
  });

  it("refuses a token response with no ID token", async () => {
    const graph = new FakeGraph().install();
    graph.on("POST", /oauth2\/v2\.0\/token/, request => {
      const pair = graph.grant(PHILLIP);
      expect(new URLSearchParams(request.body).get("grant_type")).toBe("authorization_code");
      return json({ ...pair, token_type: "Bearer", expires_in: 3600, scope: graph.grantedScopes.join(" ") });
    });
    const { result } = await firstConnect(graph);
    expect(result).toEqual({ error: "Microsoft did not say which account signed in." });
  });
});

describe("the connect link", () => {
  it("sends the browser to the tenant's authorize page with PKCE, the account picker and the requested scopes", async () => {
    const graph = new FakeGraph().install();
    const id = env.USER_ACCOUNT.newUniqueId().toString();
    const initiation = generateNonce();
    await hooks().installCallback(id, initiation, scopesFor({ MICROSOFT_SHAREPOINT_ACCESS: "read" } as Env, [SHAREPOINT_RESOURCE.urlPattern]));
    const response = await fetchWorker(`${BASE}/${id}/${initiation}`);
    expect(response.status).toBe(302);
    const authorize = new URL(response.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe(`${LOGIN}/${TENANT}/oauth2/v2.0/authorize`);
    const params = authorize.searchParams;
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("redirect_uri")).toBe(`${BASE}/oauth`);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("prompt")).toBe("select_account");
    expect(params.has("login_hint")).toBe(false);
    expect(params.get("scope")!.split(" ").toSorted()).toEqual(scopesFor({ MICROSOFT_SHAREPOINT_ACCESS: "read" } as Env, [SHAREPOINT_RESOURCE.urlPattern]).toSorted());
    expect(graph.requests).toEqual([]);

    // The link is single-use.
    expect(await (await fetchWorker(`${BASE}/${id}/${initiation}`)).text()).toMatch(/invalid|expired/i);
  });

  it("pre-fills the account picker on a reconnect with the pinned user", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const initiation = generateNonce();
    unwrap(await hooks().account(id, "prepareReconnect", initiation, scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern])));
    const response = await fetchWorker(`${BASE}/${id}/${initiation}`);
    const params = new URL(response.headers.get("location")!).searchParams;
    expect(params.get("login_hint")).toBe(PHILLIP.upn);
    expect(params.get("prompt")).toBe("select_account");
  });

  it("answers a link to an account that doesn't exist with the invalid-link page", async () => {
    new FakeGraph().install();
    const response = await fetchWorker(`${BASE}/${"0".repeat(64)}/${generateNonce()}`);
    expect(await response.text()).toMatch(/invalid|expired/i);
  });
});

describe("the OAuth callback", () => {
  it.each([
    ["consent_required", "AADSTS65001: The user or administrator has not consented to use the application."],
    ["access_denied", "AADSTS65001: The user or administrator has not consented to use the application."],
    ["access_denied", "AADSTS90094: Admin consent is required for the permissions requested by this application."],
  ])("explains a refusal for want of admin consent (%s, %s), with a link for an administrator", async (error, description) => {
    new FakeGraph().install();
    const { state } = await startFlow();
    const page = await fetchWorker(`${BASE}/oauth?error=${error}&error_description=${encodeURIComponent(description)}&state=${state}`);
    expect(page.status).toBe(400);
    const html = await page.text();
    expect(html).toContain("An administrator needs to approve this app");
    expect(html).toContain(`${LOGIN}/${TENANT}/adminconsent?client_id=${CLIENT_ID}&amp;redirect_uri=${encodeURIComponent(`${BASE}/oauth`)}`);
    expect(html).toContain(CLIENT_ID);
  });

  it("says when an admin consent request was sent rather than granted", async () => {
    new FakeGraph().install();
    const { state } = await startFlow();
    const page = await fetchWorker(`${BASE}/oauth?error=access_denied&error_description=AADSTS90095%3A+sent&state=${state}`);
    expect(await page.text()).toContain("was sent to your organization&#39;s administrators");
  });

  it("explains an account from outside the organization, and Conditional Access", async () => {
    new FakeGraph().install();
    const wrongAccount = await startFlow();
    const html = await (await fetchWorker(`${BASE}/oauth?error=invalid_request&error_description=` +
      `${encodeURIComponent("AADSTS50020: User account from identity provider does not exist in tenant.")}&state=${wrongAccount.state}`)).text();
    expect(html).toContain("That account can&#39;t connect here");

    const blocked = await startFlow();
    const ca = await (await fetchWorker(`${BASE}/oauth?error=access_denied&error_description=` +
      `${encodeURIComponent("AADSTS53003: Access has been blocked by Conditional Access policies.")}&state=${blocked.state}`)).text();
    expect(ca).toContain("Your organization blocked this sign-in");
  });

  it("ends the attempt on a refusal, so a replayed callback finds nothing to resume", async () => {
    const graph = new FakeGraph().install();
    const { state } = await startFlow();
    const refused = await fetchWorker(`${BASE}/oauth?error=access_denied&state=${state}`);
    expect(await refused.text()).toContain("Microsoft 365 authorization was not granted");
    graph.codes.set("late", { user: PHILLIP });
    const replayed = await fetchWorker(`${BASE}/oauth?code=late&state=${state}`);
    expect(await replayed.text()).toMatch(/invalid|expired/i);
    expect(graph.tokenRequests()).toEqual([]);
  });

  it("thanks an administrator who granted consent from the link", async () => {
    new FakeGraph().install();
    const granted = await fetchWorker(`${BASE}/oauth?admin_consent=True&tenant=${TENANT}`);
    expect(await granted.text()).toContain("Consent granted");
    const declined = await fetchWorker(`${BASE}/oauth?admin_consent=False&tenant=${TENANT}`);
    expect(await declined.text()).toContain("Consent was not granted");
  });

  it("shows the refusal page when a reconnect signs in as someone else", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    await hooks().installCallback(id, generateNonce(), scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]));
    const initiation = generateNonce();
    unwrap(await hooks().account(id, "prepareReconnect", initiation, scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern])));
    const start = await fetchWorker(`${BASE}/${id}/${initiation}`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    graph.codes.set("code-sarah", { user: SARAH });
    const callback = await fetchWorker(`${BASE}/oauth?code=code-sarah&state=${state}`);
    expect(callback.status).toBe(409);
    expect(await callback.text()).toContain("That&#39;s a different Microsoft 365 account");
  });
});

describe("reconnecting", () => {
  it("stages a same-user reconnect until the Workshop commits it", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    await hooks().installCallback(id, generateNonce(), scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]));
    const before = await storedGrant(id);
    const result = await reconnectAs(graph, id, PHILLIP) as { handoff: { ticket: string } };
    expect(await storedGrant(id)).toEqual(before);
    unwrap(await hooks().account(id, "commitReconnect", result.handoff.ticket));
    expect((await storedGrant(id))?.accessToken).not.toBe(before?.accessToken);
    expect(failure(await hooks().account(id, "commitReconnect", result.handoff.ticket))).toMatch(/No reconnect is awaiting/);
  });

  it("refuses a reconnect as another user of the same tenant, leaving the live grant alone", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    await hooks().installCallback(id, generateNonce(), scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]));
    const before = await storedGrant(id);
    expect(await reconnectAs(graph, id, SARAH)).toEqual({
      refused: {
        title: "That's a different Microsoft 365 account",
        detail: `This connection is for ${PHILLIP.upn}, but you signed in as ${SARAH.upn}. Sign in as ${PHILLIP.upn} ` +
          `and reconnect, or connect ${SARAH.upn} as a separate account.`,
      },
    });
    expect(await storedGrant(id)).toEqual(before);
    expect(unwrap(await hooks().account(id, "getIdentity"))).toMatchObject({ objectId: PHILLIP.oid });
  });

  it("refuses a reconnect from another tenant, even with the same object ID", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    await hooks().installCallback(id, generateNonce(), scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]));
    const before = await storedGrant(id);
    const result = await reconnectAs(graph, id, { ...PHILLIP, tid: OTHER_TENANT });
    expect(result).toMatchObject({ refused: { title: "That organization can't connect here" } });
    expect(await storedGrant(id)).toEqual(before);
  });
});

describe("credentials", () => {
  it("refreshes an expired grant once, however many reads race it, repeating the scopes asked for", async () => {
    const graph = new FakeGraph().install();
    const requested = scopesFor({ MICROSOFT_SHAREPOINT_ACCESS: "read" } as Env, [SHAREPOINT_RESOURCE.urlPattern]);
    const id = await seedAccount(graph, PHILLIP, { expiresInMs: 0, requestedScopes: requested });
    const reads = await Promise.all(Array.from({ length: 8 }, () => hooks().account(id, "getCredentials")));
    const tokens = new Set(reads.map(read => unwrap<Credentials>(read).creds.accessToken));
    expect(tokens.size).toBe(1);
    const refreshes = graph.tokenRequests();
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].get("grant_type")).toBe("refresh_token");
    expect(refreshes[0].get("scope")).toBe(requested.join(" "));
    const grant = await storedGrant(id);
    expect(grant?.accessToken).toBe([...tokens][0]);
    expect(grant?.requestedScopes).toEqual(requested);
  });

  it("never sends the refresh token outside the account", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const read = unwrap<Credentials>(await hooks().account(id, "getCredentials"));
    expect(Object.keys(read.creds).toSorted()).toEqual(["accessToken", "expiresAt", "scopes"]);
    expect(JSON.stringify(read)).not.toContain("refresh-");
  });

  it.each([
    ["invalid_grant", "AADSTS700082: The refresh token has expired due to inactivity."],
    ["interaction_required", "AADSTS50076: Due to a configuration change made by your administrator, you must use multi-factor authentication."],
  ])("treats a refresh refused with %s as the grant's death, and says so once", async (error, description) => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph, PHILLIP, { expiresInMs: 0 });
    await hooks().installCallback(id, generateNonce(), scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]));
    graph.on("POST", /oauth2\/v2\.0\/token/, () => json({ error, error_description: description }, { status: 400 }));
    expect(failure(await hooks().account(id, "getCredentials"))).toBe(RECONNECT);
    expect(failure(await hooks().account(id, "getCredentials"))).toBe(RECONNECT);
    expect(graph.tokenRequests()).toHaveLength(1);
    expect(await hooks().expiredNotices(id)).toBe(1);
  });

  it("treats any other refresh failure as passing", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph, PHILLIP, { expiresInMs: 0 });
    await hooks().installCallback(id, generateNonce(), scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]));
    graph.on("POST", /oauth2\/v2\.0\/token/, () => json({ error: "temporarily_unavailable" }, { status: 503 }));
    expect(failure(await hooks().account(id, "getCredentials"))).not.toBe(RECONNECT);
    expect(await hooks().expiredNotices(id)).toBe(0);
    // The grant survives, so the next read tries again.
    expect((await storedGrant(id))?.refreshToken).toMatch(/^refresh-/);
  });
});

describe("identity", () => {
  it("is served for a day without asking Graph, then read again, never letting the pin move", async () => {
    const graph = new FakeGraph().install();
    const fresh = await seedAccount(graph);
    expect(unwrap(await hooks().account(fresh, "getIdentity"))).toMatchObject({ objectId: PHILLIP.oid });
    expect(graph.requests).toEqual([]);

    const stale = await seedAccount(graph, PHILLIP, { identity: { fetchedAt: 0, name: "Old name" } });
    expect(unwrap(await hooks().account(stale, "getIdentity"))).toMatchObject({ name: "Phillip" });
    expect(graph.count("GET", /^\/v1\.0\/me/)).toBe(1);

    const moved = await seedAccount(graph, PHILLIP, { identity: { fetchedAt: 0 } });
    graph.on("GET", /^\/v1\.0\/me/, () => json({ id: SARAH.oid, displayName: "Sarah", userPrincipalName: SARAH.upn }));
    expect(unwrap(await hooks().account(moved, "getIdentity"))).toMatchObject({ objectId: PHILLIP.oid, name: "Phillip" });
  });

  it("keeps the SharePoint host when a re-read no longer finds one", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph, PHILLIP, { identity: { fetchedAt: 0 } });
    graph.on("GET", /^\/v1\.0\/sites\/root/, () => json({ error: { code: "accessDenied", message: "No license." } }, { status: 403 }));
    expect(unwrap(await hooks().account(id, "getIdentity"))).toMatchObject({ sharePointTenant: "contoso" });
  });

  it("reports no resources for a grant without SharePoint", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph, PHILLIP, { scopes: ["https://graph.microsoft.com/User.Read", "openid"] });
    expect(unwrap(await hooks().user(id, "describe"))).toMatchObject({ grantedResourceUrlPatterns: [] });
    expect(unwrap(await hooks().verifier(id, "getIdentity"))).toBeNull();
  });
});

describe("disconnecting", () => {
  it("forgets everything locally, with no request to Microsoft", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    await hooks().installCallback(id, generateNonce(), scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]));
    unwrap(await hooks().user(id, "revoke"));
    expect(await storageKeys(id)).toEqual([]);
    expect(graph.requests).toEqual([]);
    expect(failure(await hooks().user(id, "describe"))).toBe(RECONNECT);
  });

  it("drops a staged reconnect with the rest", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    await hooks().installCallback(id, generateNonce(), scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]));
    const staged = await reconnectAs(graph, id, PHILLIP) as { handoff: { ticket: string } };
    unwrap(await hooks().user(id, "revoke"));
    expect(failure(await hooks().account(id, "commitReconnect", staged.handoff.ticket))).toMatch(/No reconnect is awaiting/);
    expect(await storedGrant(id)).toBeUndefined();
  });
});
