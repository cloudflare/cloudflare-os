import {env} from "cloudflare:workers";
import {runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {stageCredentials} from "@gadgets/gatekeeper-kit/credential-stage";
import type {GatekeeperConnectCallback} from "@gadgets/workshop-shared/gatekeeper";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {UserAccount} from "../../src/google";
import {GoogleGrantRegistry} from "../../src/grant-registry";
import {connectCallbackEvents, describingConnectCallbacks} from "./worker";

// Google revokes a grant for every client of a Google Cloud project at once, so an account that is
// disconnected revokes it only when no other connection of the same Google account is left.

const testEnv = env as unknown as {
  UserAccount: DurableObjectNamespace<UserAccount>;
  GoogleGrantRegistry: DurableObjectNamespace<GoogleGrantRegistry>;
};

type DescribeExports = {
  GatekeeperUserImpl(options: {props: {userObjectId: string}}): {describe(): Promise<unknown>};
};

type TestExports = {
  TestConnectCallback(options: {props: {name: string}}): Fetcher<GatekeeperConnectCallback>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** What Google says of an admin's restriction, which can name more than the restriction. */
const BLOCKED_DESCRIPTION = "Blocked for ada@example.com by policy 42";

/**
 * Google as far as an account object uses it. A refresh token `refresh-x` mints the access token
 * `access-x`, an authorization code `x` is exchanged for both, and `subjects` says which Google
 * account each access token belongs to.
 */
function fakeGoogle() {
  const google = {
    subjects: new Map<string, string>(),
    /** Each refresh token revoked. */
    revoked: [] as string[],
    /** Whether the revocation endpoint fails, as in an outage. */
    revocationFails: false,
    /** Whether Google refuses to say which account an access token belongs to. */
    profileFails: false,
    /** How many more times Google says which account an access token belongs to, before it refuses. */
    profileAnswers: Infinity,
    /** Whether Google holds back its answer about which account an access token belongs to. */
    profileHeld: false,
    /** How many of those answers are being held back. */
    profilesWaiting: 0,
    /**
     * The refresh tokens Google refuses to refresh, each with the `error_subtype` it sends. One
     * refused with none is dead: Google does not take its revocation either.
     */
    refused: new Map<string, string | null>(),
    /** The refresh tokens an admin's restriction keeps Google from refreshing. */
    blocked: new Set<string>(),
    /** Whether Google answers, about which account an access token belongs to, that it is no good. */
    profileUnauthorized: false,
    /** Whether Google's token endpoint fails refreshes, as in an outage. */
    refreshFails: false,
    /** Whether Google holds back its answers to refreshes. */
    refreshHeld: false,
    /** How many of those answers are being held back. */
    refreshesWaiting: 0,
  };
  const json = (body: unknown, status = 200) => Response.json(body, {status});
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.href === "https://oauth2.googleapis.com/token") {
      const form = init.body as URLSearchParams;
      if (google.refreshFails && form.get("refresh_token")) return json({error: "backend_error"}, 503);
      if (google.refreshHeld && form.get("refresh_token")) {
        google.refreshesWaiting++;
        while (google.refreshHeld) await new Promise(resolve => setTimeout(resolve, 1));
        google.refreshesWaiting--;
      }
      const subtype = google.refused.get(form.get("refresh_token") ?? "");
      if (subtype !== undefined) {
        return json({error: "invalid_grant", ...(subtype !== null ? {error_subtype: subtype} : {})}, 400);
      }
      if (google.blocked.has(form.get("refresh_token") ?? "")) {
        return json({error: "admin_policy_enforced", error_description: BLOCKED_DESCRIPTION}, 400);
      }
      const name = form.get("code") ?? form.get("refresh_token")!.replace(/^refresh-/, "");
      return json({
        access_token: `access-${name}`, expires_in: 3600, scope: "openid",
        ...(form.get("code") ? {refresh_token: `refresh-${name}`} : {}),
      });
    }
    if (url.href === "https://www.googleapis.com/oauth2/v3/userinfo") {
      const token = new Headers(init.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "";
      if (google.profileFails || google.profileAnswers <= 0) return json({error: "access_denied"}, 403);
      google.profileAnswers--;
      if (google.profileHeld) {
        google.profilesWaiting++;
        while (google.profileHeld) await new Promise(resolve => setTimeout(resolve, 1));
        google.profilesWaiting--;
      }
      if (google.profileUnauthorized) return json({error: "invalid_token"}, 401);
      const sub = google.subjects.get(token);
      return sub === undefined ? json({error: "invalid_token"}, 500) : json({sub});
    }
    if (url.href === "https://oauth2.googleapis.com/revoke") {
      if (google.revocationFails) return json({error: "backend_error"}, 503);
      const token = new URLSearchParams(String(init.body)).get("token") ?? "";
      if (google.refused.get(token) === null) return json({error: "invalid_token"}, 400);
      google.revoked.push(token);
      return new Response("{}");
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return google;
}

type Google = ReturnType<typeof fakeGoogle>;

/** Two Google accounts no other test has connected: a registry outlives the test that filled it. */
function googleAccounts() {
  const run = crypto.randomUUID();
  return {ada: `ada-${run}`, grace: `grace-${run}`};
}

/** The Google account whose grant an account is recorded as holding with the credentials it has now. */
function recordedGrant({storage: {kv}}: DurableObjectState) {
  return kv.get("grantCredentialsId") === kv.get("credentialsId") ? kv.get<string>("grantSubject") : undefined;
}

function accountHandle(id: DurableObjectId) {
  const stub = () => testEnv.UserAccount.get(id);
  const stored = <T>(key: string) => runInDurableObject(stub(),
    (_instance: UserAccount, state: DurableObjectState) => state.storage.kv.get<T>(key));
  const held = () => runInDurableObject(stub(),
    (_instance: UserAccount, state: DurableObjectState) => recordedGrant(state));
  return {
    id: id.toString(),
    /** Refreshes the access token, as any use of the connection eventually does. */
    refresh: () => runInDurableObject(stub(),
      async (instance: UserAccount) => (await instance.getAccessToken({forceRefresh: true})).token),
    disconnect: () => runInDurableObject(stub(), (instance: UserAccount) => instance.revoke()),
    /** Runs the account's alarm, if one is set. */
    alarm: () => runDurableObjectAlarm(stub()),
    /** Describes the account, as the Workshop does when it restores or lists it. */
    describe: () => runInDurableObject(stub(), (_instance: UserAccount, state: DurableObjectState) =>
      (state.exports as unknown as DescribeExports).GatekeeperUserImpl({props: {userObjectId: id.toString()}})
        .describe()),
    /** Waits until the account is recorded as holding the grant of the Google account `subject`. */
    holds: (subject: string) => vi.waitFor(async () => expect(await held()).toBe(subject), {timeout: 5000}),
    stored,
    isEmpty: () => runInDurableObject(stub(),
      (_instance: UserAccount, state: DurableObjectState) => [...state.storage.kv.list()].length === 0),
    run: <T>(callback: (instance: UserAccount, state: DurableObjectState) => T | Promise<T>) =>
      runInDurableObject(stub(), callback),
  };
}

/**
 * A connection `name` of the Google account `subject` whose credentials were stored before grants
 * had a registry, or by a sign-in: it holds a refresh token and nothing is recorded about it.
 */
async function storedAccount(google: Google, name: string, subject: string, signIn = false) {
  google.subjects.set(`access-${name}`, subject);
  const account = accountHandle(testEnv.UserAccount.newUniqueId());
  await account.run((_instance, state) => {
    state.storage.kv.put("refreshToken", `refresh-${name}`);
    if (signIn) state.storage.kv.put("deleteCredentialsOnAlarm", true);
  });
  return account;
}

/** A connection that has refreshed a token since, and so is recorded as holding its grant. */
async function connection(google: Google, name: string, subject: string) {
  const account = await storedAccount(google, name, subject);
  await account.refresh();
  await account.holds(subject);
  return account;
}

/**
 * Runs the OAuth flow for a new account the way the gatekeeper's `/oauth` route does. `describe`
 * has the Workshop describe the account before it completes, as it does.
 */
async function connectThroughOAuth(
    google: Google, name: string, subject: string, mode: "connect" | "auth", describe = false) {
  google.subjects.set(`access-${name}`, subject);
  if (describe) describingConnectCallbacks.add(name);
  const account = accountHandle(testEnv.UserAccount.newUniqueId());
  const recordedAtReturn = await account.run(async (instance, state) => {
    await instance.setCallback(
      (state.exports as unknown as TestExports).TestConnectCallback({props: {name}}), "initiation", [], mode);
    const begun = await instance.beginOAuthFlow("initiation", "https://gatekeeper.example/oauth");
    expect(await instance.acceptAuthCode(name, begun!.oauthNonce)).not.toBeNull();
    // Read before anything else runs: what was recorded when the flow returned.
    return recordedGrant(state);
  });
  return Object.assign(account, {recordedAtReturn});
}

/**
 * Confirms a reconnect that signed in as the Google account `subject`. `staged` is whether the
 * consent flow could read which account that was when it staged the credentials.
 */
async function reconnect(
    google: Google, account: ReturnType<typeof accountHandle>, name: string, subject: string,
    staged = true) {
  google.subjects.set(`access-${name}`, subject);
  await account.run(async (instance, state) => {
    await instance.commitReconnect(stageCredentials(state.storage.kv, {
      refreshToken: `refresh-${name}`,
      accessToken: {token: `access-${name}`, expires: new Date(Date.now() + 3_600_000)},
      grantedScopes: [], requestedResources: [],
      ...(staged ? {subject} : {}),
    }, Date.now()));
  });
}

describe("Google grants shared by several connections", () => {
  it("revokes a Google account's grant only when its last connection is disconnected", async () => {
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const first = await connection(google, "first", ada);
    const second = await connection(google, "second", ada);

    await second.disconnect();
    expect(google.revoked).toEqual([]);
    expect(await second.isEmpty()).toBe(true);
    // The first connection goes on working: nothing ended its grant.
    expect(await first.refresh()).toBe("access-first");

    await first.disconnect();
    expect(google.revoked).toEqual(["refresh-first"]);
    expect(await first.isEmpty()).toBe(true);
  });

  it("revokes one Google account's grant whatever connections another has", async () => {
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const adas = await connection(google, "adas", ada);
    await connection(google, "graces", grace);

    await adas.disconnect();
    expect(google.revoked).toEqual(["refresh-adas"]);
  });

  it("records a new connection before its connect flow returns", async () => {
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const first = await connectThroughOAuth(google, "first", ada, "connect");
    expect(first.recordedAtReturn).toBe(ada);

    // The Workshop drops a second connection of an account it already lists, straight away.
    const duplicate = await connectThroughOAuth(google, "duplicate", ada, "connect");
    await duplicate.disconnect();
    expect(google.revoked).toEqual([]);
  });

  // The Workshop's description of a new connection read which Google account it is, so a second
  // read that fails cannot leave it unrecorded.
  it("records a new connection under the account its description read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    google.profileAnswers = 1;
    const first = await connectThroughOAuth(google, "first", ada, "connect", true);
    expect(first.recordedAtReturn).toBe(ada);
    google.profileAnswers = Infinity;

    const duplicate = await connectThroughOAuth(google, "duplicate", ada, "connect");
    await duplicate.disconnect();
    expect(google.revoked).toEqual([]);
  });

  it("never records a sign-in, whose disconnection spares the Google account's connections", async () => {
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const signIn = await connectThroughOAuth(google, "sign-in", ada, "auth");
    await signIn.refresh();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await signIn.stored("grantSubject")).toBeUndefined();

    await connection(google, "connection", ada);
    await signIn.disconnect();
    expect(google.revoked).toEqual([]);

    // Nor when the Workshop describes it, though it then knows which account it is.
    const described = await connectThroughOAuth(google, "described", ada, "auth", true);
    expect(described.recordedAtReturn).toBeUndefined();
    expect(await described.stored("grantSubject")).toBeUndefined();

    // With no connection to spare, a sign-in's grant is revoked.
    const alone = await connectThroughOAuth(google, "alone", grace, "auth");
    await alone.disconnect();
    expect(google.revoked).toEqual(["refresh-alone"]);
  });

  it("spares the others when a connection it never recorded is disconnected", async () => {
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    await connection(google, "recorded", ada);
    // Stored before the registry, and its access token still says whose it is.
    const older = await storedAccount(google, "older", ada);
    await older.run((_instance, state) => {
      state.storage.kv.put("accessToken", {token: "access-older", expires: new Date(Date.now() + 3_600_000)});
    });

    await older.disconnect();
    expect(google.revoked).toEqual([]);
  });

  it("spares the others when a connection it never recorded is disconnected in its token's last minute", async () => {
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    await connection(google, "recorded", ada);
    const older = await storedAccount(google, "older", ada);
    await older.run((_instance, state) => {
      state.storage.kv.put("accessToken", {token: "access-older", expires: new Date(Date.now() + 30_000)});
    });

    await older.disconnect();
    expect(google.revoked).toEqual([]);
  });

  it("revokes when it cannot tell which Google account it holds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    await connection(google, "recorded", ada);
    // No access token to ask with, and none can be minted while disconnecting.
    const unknown = await storedAccount(google, "unknown", ada);
    await unknown.disconnect();
    expect(google.revoked).toEqual(["refresh-unknown"]);

    // An access token Google will not name the account of.
    const unnamed = await storedAccount(google, "unnamed", ada);
    google.subjects.delete("access-unnamed");
    await unnamed.run((_instance, state) => {
      state.storage.kv.put("accessToken", {token: "access-unnamed", expires: new Date(Date.now() + 3_600_000)});
    });
    await unnamed.disconnect();
    expect(google.revoked).toEqual(["refresh-unknown", "refresh-unnamed"]);
  });

  // Left connected, a connection whose revocation Google did not take would no longer count as a
  // holder, and a disconnect of another, such as a connect the Workshop dropped, would revoke under it.
  it("finishes a disconnect Google does not take, and revokes again later", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const first = await connection(google, "first", ada);
    google.revocationFails = true;
    await first.disconnect();
    expect(await first.stored("refreshToken")).toBeUndefined();
    await expect(first.refresh()).rejects.toThrow(/has been disconnected/);

    // Google is asked again, until it takes the revocation or the tries run out.
    expect(await first.alarm()).toBe(true);
    expect(google.revoked).toEqual([]);
    google.revocationFails = false;
    expect(await first.alarm()).toBe(true);
    expect(google.revoked).toEqual(["refresh-first"]);
    expect(await first.isEmpty()).toBe(true);

    const abandoned = await connection(google, "abandoned", ada);
    google.revocationFails = true;
    await abandoned.disconnect();
    for (let attempt = 0; attempt < 9; attempt++) expect(await abandoned.alarm()).toBe(true);
    expect(await abandoned.isEmpty()).toBe(true);
    expect(await abandoned.alarm()).toBe(false);
  });

  // A holder that could not be asked counts as holding at a disconnect, but proves nothing to a
  // revocation to try again, which a stale holder would otherwise drop for good.
  it("tries a revocation again when a holder of the grant cannot be asked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const first = await connection(google, "first", ada);
    google.revocationFails = true;
    await first.disconnect();
    google.revocationFails = false;

    // A connection made since, idle, whose check with Google fails.
    const later = await connection(google, "later", ada);
    await later.run((_instance, state) => {
      state.storage.kv.put("accessToken", {token: "access-later", expires: new Date(Date.now() - 1000)});
    });
    google.refreshFails = true;
    expect(await first.alarm()).toBe(true);
    expect(google.revoked).toEqual([]);
    expect(await first.isEmpty()).toBe(false);

    // Asked again, it holds nothing: Google ended its refresh token.
    google.refreshFails = false;
    google.refused.set("refresh-later", null);
    expect(await first.alarm()).toBe(true);
    expect(google.revoked).toEqual(["refresh-first"]);
  });

  // Sparing a holder that could not be asked must not lose the last token that can revoke.
  // A reconnect not yet known to be the same Google account's may hold another's grant now.
  it("puts off a disconnect's revocation while a reconnect's Google account is not known", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const moved = await connection(google, "moved", ada);
    const last = await connection(google, "last", ada);
    google.profileFails = true;
    await reconnect(google, moved, "moved-again", grace, false);
    await last.disconnect();
    expect(google.revoked).toEqual([]);

    // Asked again once Google answers, it reads which account it is, though nothing used it: another
    // account's, so it lets go of the first account's grant, which is then revoked.
    google.profileFails = false;
    expect(await last.alarm()).toBe(true);
    expect(google.revoked).toEqual(["refresh-last"]);
    await moved.holds(grace);
  });

  it("does not count an answer it gave before a reconnect left it unsure which account it is", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const first = await connection(google, "first", ada);
    const moved = await connection(google, "moved", ada);
    // Its answer, that it holds the grant, is on its way back when it reconnects, as another
    // Google account it cannot yet read.
    await moved.run((_instance, state) => { state.storage.kv.put("test:holdGrantCheck", true); });
    const disconnecting = first.disconnect();
    await vi.waitFor(async () => expect(await moved.stored("test:grantCheckHeld")).toBe(true), {timeout: 5000});
    google.profileFails = true;
    await reconnect(google, moved, "moved-again", grace, false);
    await moved.run((_instance, state) => { state.storage.kv.delete("test:holdGrantCheck"); });
    await disconnecting;
    expect(google.revoked).toEqual([]);

    // Asked again, it could not say, so the revocation waited, and is sent once it can.
    google.profileFails = false;
    expect(await first.alarm()).toBe(true);
    expect(google.revoked).toEqual(["refresh-first"]);
  });

  it("puts off a disconnect's revocation while a holder of the grant cannot be asked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const idle = await connection(google, "idle", ada);
    const first = await connection(google, "first", ada);
    await idle.run((_instance, state) => {
      state.storage.kv.put("accessToken", {token: "access-idle", expires: new Date(Date.now() - 1000)});
    });
    google.refreshFails = true;
    await first.disconnect();
    expect(google.revoked).toEqual([]);
    await expect(first.refresh()).rejects.toThrow(/has been disconnected/);

    // Asked again once Google answers, the idle one holds nothing: its refresh token was ended.
    google.refreshFails = false;
    google.refused.set("refresh-idle", null);
    expect(await first.alarm()).toBe(true);
    expect(google.revoked).toEqual(["refresh-first"]);
    expect(await first.isEmpty()).toBe(true);
  });

  it("keeps a revocation Google did not take through a second disconnect", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const first = await connection(google, "first", ada);
    google.revocationFails = true;
    await first.disconnect();
    google.revocationFails = false;
    // The Workshop can disconnect it twice, each having read the account before.
    await first.disconnect();
    expect(await first.alarm()).toBe(true);
    expect(google.revoked).toEqual(["refresh-first"]);
  });

  it("asks the Google account's registry again before revoking, though the disconnect could not", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const first = await connection(google, "first", ada);
    vi.spyOn(GoogleGrantRegistry.prototype, "remove").mockImplementationOnce(async () => {
      throw new Error("registry unavailable");
    });
    google.revocationFails = true;
    await first.disconnect();
    google.revocationFails = false;

    // A registry that cannot say whether a connection made since holds the grant is asked later.
    const remove = vi.spyOn(GoogleGrantRegistry.prototype, "remove").mockImplementationOnce(async () => {
      throw new Error("registry unavailable");
    });
    expect(await first.alarm()).toBe(true);
    expect(google.revoked).toEqual([]);
    remove.mockRestore();

    const later = await connection(google, "later", ada);
    expect(await first.alarm()).toBe(true);
    expect(google.revoked).toEqual([]);
    expect(await first.isEmpty()).toBe(true);
    expect(await later.refresh()).toBe("access-later");
  });

  it("keeps with a revocation to try again the account its disconnect read, though the registry then failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    await connection(google, "other", ada);
    // Never recorded, but its access token says whose it is.
    const older = await storedAccount(google, "older", ada);
    await older.run((_instance, state) => {
      state.storage.kv.put("accessToken", {token: "access-older", expires: new Date(Date.now() + 3_600_000)});
    });
    vi.spyOn(GoogleGrantRegistry.prototype, "remove").mockImplementationOnce(async () => {
      throw new Error("registry unavailable");
    });
    google.revocationFails = true;
    await older.disconnect();
    google.revocationFails = false;
    // A Google Cloud session that ran out keeps the token from minting, which the account is not
    // read with again: the registry is asked, and the other connection spared.
    google.refused.set("refresh-older", "invalid_rapt");
    expect(await older.alarm()).toBe(true);
    expect(google.revoked).toEqual([]);
    expect(await older.isEmpty()).toBe(true);
  });

  it("reads the Google account of a revocation to try again that none was known for", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    // Made before the registry, with no access token to say whose it is.
    const older = await storedAccount(google, "older", ada);
    google.revocationFails = true;
    await older.disconnect();
    google.revocationFails = false;

    const later = await connection(google, "later", ada);
    expect(await older.alarm()).toBe(true);
    expect(google.revoked).toEqual([]);
    expect(await older.isEmpty()).toBe(true);
    expect(await later.refresh()).toBe("access-later");

    // One Google refuses for good holds no grant, and is not revoked.
    const dead = await storedAccount(google, "dead", ada);
    google.revocationFails = true;
    await dead.disconnect();
    google.revocationFails = false;
    google.refused.set("refresh-dead", null);
    expect(await dead.alarm()).toBe(true);
    expect(google.revoked).toEqual([]);
    expect(await dead.isEmpty()).toBe(true);
  });

  // An answer Google gave about the credentials a reconnect replaced says nothing of the new ones.
  it("answers for the credentials a reconnect installed while an idle holder's check was out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const renewed = await connection(google, "renewed", ada);
    const leaving = await connection(google, "leaving", ada);
    await renewed.run((_instance, state) => {
      state.storage.kv.put("accessToken", {token: "access-renewed", expires: new Date(Date.now() - 1000)});
    });
    google.refused.set("refresh-renewed", null);
    google.refreshHeld = true;
    const disconnecting = leaving.disconnect();
    await vi.waitFor(() => expect(google.refreshesWaiting).toBe(1), {timeout: 5000});
    await reconnect(google, renewed, "renewed-again", ada);
    google.refreshHeld = false;

    await disconnecting;
    expect(google.revoked).toEqual([]);
    expect(await renewed.stored("refreshTokenDead")).toBeUndefined();
  });

  it("drops a revocation Google did not take once a later connection holds the grant", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    // The Workshop drops a connect that was never redeemed.
    const abandoned = await connectThroughOAuth(google, "abandoned", ada, "connect");
    google.revocationFails = true;
    await abandoned.disconnect();
    google.revocationFails = false;

    const later = await connection(google, "later", ada);
    expect(await abandoned.alarm()).toBe(true);
    expect(google.revoked).toEqual([]);
    expect(await abandoned.isEmpty()).toBe(true);
    expect(await later.refresh()).toBe("access-later");

    await later.disconnect();
    expect(google.revoked).toEqual(["refresh-later"]);
  });

  it("stops counting a connection whose refresh token Google no longer honours", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const dead = await connection(google, "dead", ada);
    const working = await connection(google, "working", ada);
    google.refused.set("refresh-dead", null);
    await expect(dead.refresh()).rejects.toThrow(/expired or been revoked/);

    // Revoking the dead token would revoke nothing, so the last working connection revokes.
    await working.disconnect();
    expect(google.revoked).toEqual(["refresh-working"]);
    await dead.disconnect();
    expect(google.revoked).toEqual(["refresh-working"]);
    expect(await dead.isEmpty()).toBe(true);

    // A Google Cloud session that ran out leaves a refresh token that can still be revoked.
    const signedOut = await connection(google, "signed-out", grace);
    const other = await connection(google, "other", grace);
    google.refused.set("refresh-signed-out", "invalid_rapt");
    await expect(signedOut.refresh()).rejects.toThrow(/sign in again/);
    await other.disconnect();
    expect(google.revoked).toEqual(["refresh-working"]);
  });

  it("holds the grant again once a connection Google refused is reconnected", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const expired = await connection(google, "expired", ada);
    google.refused.set("refresh-expired", null);
    await expect(expired.refresh()).rejects.toThrow(/expired or been revoked/);
    expect(await expired.stored("grantSubject")).toBeUndefined();

    await reconnect(google, expired, "renewed", ada);
    await expired.holds(ada);
    const other = await connection(google, "other", ada);
    await other.disconnect();
    expect(google.revoked).toEqual([]);
  });

  it("holds the other Google account's grant after a reconnect signs in as it", async () => {
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const moved = await connection(google, "moved", ada);
    await reconnect(google, moved, "moved-again", grace);
    expect(await moved.stored("grantSubject")).toBe(grace);

    // It no longer holds the first account's grant, and holds the second's.
    const adas = await connection(google, "adas", ada);
    await adas.disconnect();
    expect(google.revoked).toEqual(["refresh-adas"]);
    const graces = await connection(google, "graces", grace);
    await graces.disconnect();
    expect(google.revoked).toEqual(["refresh-adas"]);
  });

  it("holds the grant of the Google account its reconnect staged, without asking Google again", async () => {
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const moved = await connection(google, "moved", ada);
    google.profileFails = true;
    await reconnect(google, moved, "moved-again", grace);
    expect(await moved.stored("grantSubject")).toBe(grace);
    expect(await moved.stored("grantCredentialsId")).toBe(await moved.stored("credentialsId"));

    // Recorded at once, so disconnecting another connection of the second account spares it.
    google.profileFails = false;
    const graces = await connection(google, "graces", grace);
    await graces.disconnect();
    expect(google.revoked).toEqual([]);
  });

  it("records a reconnect as another Google account at its next refresh when it could not at once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const moved = await connection(google, "moved", ada);
    const graces = await connection(google, "graces", grace);
    // Neither the stage nor Google can say which account signed in.
    google.profileFails = true;
    await reconnect(google, moved, "moved-again", grace, false);
    // Recorded for no credentials, and still listed by the first account's registry.
    expect(await moved.stored("grantCredentialsId")).toBeUndefined();
    expect(await moved.stored("grantSubject")).toBe(ada);

    google.profileFails = false;
    await moved.refresh();
    await moved.holds(grace);
    // It holds the second account's grant, and no longer the first's.
    await graces.disconnect();
    expect(google.revoked).toEqual([]);
    const adas = await connection(google, "adas", ada);
    await adas.disconnect();
    expect(google.revoked).toEqual(["refresh-adas"]);
  });

  // The Workshop describes a reconnected account before it lists it as working again.
  it("moves to the Google account a reconnect signed in as once describing it reads which", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const moved = await connection(google, "moved", ada);
    const last = await connection(google, "last", ada);
    google.profileFails = true;
    await reconnect(google, moved, "moved-again", grace, false);
    google.profileFails = false;
    // Taking it out of the first account's registry fails, which drops it when it next asks.
    vi.spyOn(GoogleGrantRegistry.prototype, "drop").mockImplementationOnce(async () => {
      throw new Error("registry unavailable");
    });
    await moved.describe();
    await moved.holds(grace);

    const graces = await connection(google, "graces", grace);
    await graces.disconnect();
    expect(google.revoked).toEqual([]);
    await last.disconnect();
    expect(google.revoked).toEqual(["refresh-last"]);
  });

  it("asks the registry of the account it reconnected as, though the one it was listed in before fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const moved = await connection(google, "moved", ada);
    await connection(google, "graces", grace);
    // Still listed under the first account, as its reconnect could not read which it signed in as.
    google.profileFails = true;
    await reconnect(google, moved, "moved-again", grace, false);
    google.profileFails = false;
    const formerId = testEnv.GoogleGrantRegistry.idFromName(ada).toString();
    const failFormer = <M extends "drop" | "remove">(method: M) => {
      const real = GoogleGrantRegistry.prototype[method] as (this: GoogleGrantRegistry, id: string) => Promise<never>;
      vi.spyOn(GoogleGrantRegistry.prototype, method).mockImplementation(function (this: GoogleGrantRegistry, id: string) {
        if ((this as unknown as {ctx: DurableObjectState}).ctx.id.toString() === formerId) {
          throw new Error("registry unavailable");
        }
        return real.call(this, id);
      } as never);
    };
    failFormer("drop");
    failFormer("remove");

    await moved.disconnect();
    expect(google.revoked).toEqual([]);
  });

  it("records a reconnect it never listed once describing it reads the account", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const other = await connection(google, "other", ada);
    // Stored before the registry, and its reconnect could not read which account it is.
    const older = await storedAccount(google, "older", ada);
    google.profileFails = true;
    await reconnect(google, older, "older-again", ada, false);
    google.profileFails = false;
    await older.describe();
    await older.holds(ada);

    await other.disconnect();
    expect(google.revoked).toEqual([]);
  });

  it("stops counting for the first Google account as soon as a reconnect is known to sign in as another", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const moved = await connection(google, "moved", ada);
    const other = await connection(google, "other", ada);
    await reconnect(google, moved, "moved-again", grace);

    // The reconnect took it out of the first account's registry, whose last connection revokes.
    await other.disconnect();
    expect(google.revoked).toEqual(["refresh-other"]);
  });

  // Revoking under a connection in use is the worse mistake, so a reconnect that may be of the
  // same Google account goes on holding its grant until it is known not to be.
  it("goes on holding through a reconnect whose Google account cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const renewed = await connection(google, "renewed", ada);
    const other = await connection(google, "other", ada);
    google.profileFails = true;
    await reconnect(google, renewed, "renewed-again", ada, false);
    expect(await renewed.stored("grantSubject")).toBe(ada);
    await other.disconnect();
    expect(google.revoked).toEqual([]);

    // One that turns out to be another account's lets go once that is read.
    google.profileFails = false;
    const moved = await connection(google, "moved", ada);
    const last = await connection(google, "last", ada);
    google.profileFails = true;
    await reconnect(google, moved, "moved-again", grace, false);
    google.profileFails = false;
    await moved.refresh();
    await moved.holds(grace);
    await renewed.refresh();
    await renewed.holds(ada);
    await renewed.disconnect();
    expect(google.revoked).toEqual([]);
    await last.disconnect();
    expect(google.revoked).toEqual(["refresh-last"]);
  });

  it("no longer counts, once it reconnects as another Google account, on an answer it gave before", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const first = await connection(google, "first", ada);
    const moved = await connection(google, "moved", ada);
    // The first connection's disconnect asks the other, whose answer, that it holds the grant, is
    // on its way back when it reconnects as another Google account.
    await moved.run((_instance, state) => { state.storage.kv.put("test:holdGrantCheck", true); });
    const disconnecting = first.disconnect();
    await vi.waitFor(async () => expect(await moved.stored("test:grantCheckHeld")).toBe(true), {timeout: 5000});
    await reconnect(google, moved, "moved-again", grace);
    await moved.run((_instance, state) => { state.storage.kv.delete("test:holdGrantCheck"); });

    // Nothing holds the first account's grant any more, so its last connection revokes it.
    await disconnecting;
    expect(google.revoked).toEqual(["refresh-first"]);
  });

  it("goes on holding through a reconnect as the same Google account", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const renewed = await connection(google, "renewed", ada);
    const other = await connection(google, "other", ada);
    // The consent flow read which account signed in, so nothing has to be read again.
    google.profileFails = true;
    await reconnect(google, renewed, "renewed-again", ada);
    expect(await renewed.stored("grantSubject")).toBe(ada);

    await other.disconnect();
    expect(google.revoked).toEqual([]);
  });

  it("finishes a recording the registry never received when it reconnects as the same Google account", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const other = await connection(google, "other", ada);
    // Its first recording names the account and then fails to reach the registry.
    const renewed = await storedAccount(google, "renewed", ada);
    vi.spyOn(GoogleGrantRegistry.prototype, "add").mockImplementationOnce(async () => {
      throw new Error("registry unavailable");
    });
    await renewed.refresh();
    await vi.waitFor(async () => expect(await renewed.stored("grantSubject")).toBe(ada), {timeout: 5000});
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await renewed.stored("grantCredentialsId")).toBeUndefined();

    await reconnect(google, renewed, "renewed-again", ada);
    await renewed.holds(ada);
    await other.disconnect();
    expect(google.revoked).toEqual([]);
  });

  it("reads which Google account signed in when it stages a reconnect", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const renewed = await connectThroughOAuth(google, "renewed", ada, "connect");
    const other = await connection(google, "other", ada);
    google.subjects.set("access-renewed-again", ada);
    const stageId = await renewed.run(async instance => {
      await instance.prepareReconnect("again", []);
      const begun = await instance.beginOAuthFlow("again", "https://gatekeeper.example/oauth");
      expect(await instance.acceptAuthCode("renewed-again", begun!.oauthNonce)).not.toBeNull();
      return connectCallbackEvents.get("renewed")!.at(-1)!.replace("reconnectComplete:", "");
    });

    // Nothing has to be read when the Workshop confirms the reconnect.
    google.profileFails = true;
    await renewed.run(instance => instance.commitReconnect(stageId));
    expect(await renewed.stored("grantSubject")).toBe(ada);
    await other.disconnect();
    expect(google.revoked).toEqual([]);
  });

  it("asks the Google account it signed in as when disconnected before a reconnect is recorded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    // A reconnect as the second account that could not be recorded leaves the connection recorded
    // under neither. The second account has another connection to spare.
    const spared = await connection(google, "spared", ada);
    const graces = await connection(google, "graces", grace);
    google.profileFails = true;
    await reconnect(google, spared, "spared-again", grace, false);
    expect(await spared.stored("grantCredentialsId")).toBeUndefined();
    google.profileFails = false;
    await spared.disconnect();
    expect(google.revoked).toEqual([]);

    // As the second account's last connection it revokes, whatever connections the first has.
    const revoking = await connection(google, "revoking", ada);
    await connection(google, "adas", ada);
    await graces.disconnect();
    google.profileFails = true;
    await reconnect(google, revoking, "revoking-again", grace, false);
    expect(await revoking.stored("grantCredentialsId")).toBeUndefined();
    google.profileFails = false;
    await revoking.disconnect();
    expect(google.revoked).toEqual(["refresh-graces", "refresh-revoking-again"]);
  });

  it("does not let a holder whose removal failed keep the grant from being revoked later", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const first = await connection(google, "first", ada);
    vi.spyOn(GoogleGrantRegistry.prototype, "remove").mockImplementationOnce(async () => {
      throw new Error("registry unavailable");
    });
    // The registry could not be asked, so the grant is revoked, and the registry still lists the
    // account, whose storage is gone.
    await first.disconnect();
    expect(google.revoked).toEqual(["refresh-first"]);
    expect(await first.isEmpty()).toBe(true);

    // A later connection of the same Google account is its only holder, and revokes when it goes.
    const second = await connection(google, "second", ada);
    await second.disconnect();
    expect(google.revoked).toEqual(["refresh-first", "refresh-second"]);
  });

  it("is dropped by the first Google account's registry, which a reconnect's removal did not reach, when it next asks", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const moved = await connection(google, "moved", ada);
    const other = await connection(google, "other", ada);
    const drop = vi.spyOn(GoogleGrantRegistry.prototype, "drop").mockImplementationOnce(async () => {
      throw new Error("registry unavailable");
    });
    await reconnect(google, moved, "moved-again", grace);
    expect(drop).toHaveBeenCalledOnce();
    expect(await moved.stored("grantSubject")).toBe(grace);

    // Still listed by the first account's registry, it is asked, and holds that grant no longer.
    await other.disconnect();
    expect(google.revoked).toEqual(["refresh-other"]);
  });

  it("does not record a connection Google refused while it was being recorded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const working = await connection(google, "working", ada);
    // Its first refresh starts the recording, which waits on Google for the account's profile.
    const dead = await storedAccount(google, "dead", ada);
    google.profileHeld = true;
    await dead.refresh();
    await vi.waitFor(() => expect(google.profilesWaiting).toBe(1), {timeout: 5000});

    // Refused for good meanwhile: the profile, when it arrives, describes a grant it no longer holds.
    google.refused.set("refresh-dead", null);
    await expect(dead.refresh()).rejects.toThrow(/expired or been revoked/);
    google.profileHeld = false;
    await vi.waitFor(() => expect(google.profilesWaiting).toBe(0), {timeout: 5000});
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await dead.stored("grantSubject")).toBeUndefined();

    await working.disconnect();
    expect(google.revoked).toEqual(["refresh-working"]);
  });

  it("does not log Google's description of a restriction that refused the refresh a recording needed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const blocked = await storedAccount(google, "blocked", ada);
    google.profileHeld = true;
    await blocked.refresh();
    await vi.waitFor(() => expect(google.profilesWaiting).toBe(1), {timeout: 5000});

    // The profile says the token is no good, and the refresh it asks for is refused.
    google.profileUnauthorized = true;
    google.blocked.add("refresh-blocked");
    google.profileHeld = false;
    await vi.waitFor(() => expect(warn.mock.calls.map(([entry]) => entry)).toContainEqual(
      expect.objectContaining({event: "google.grant.hold.failed", outcome: "refreshRefused"}),
    ), {timeout: 5000});
    expect(JSON.stringify(warn.mock.calls)).not.toContain(BLOCKED_DESCRIPTION);
  });

  // Only a disconnect needs to know whether another connection holds the grant: a holder that
  // lets go otherwise must not wait while the registry asks the others.
  it("lets go of a grant without waiting on the other holders, unless it is disconnected", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const slow = await connection(google, "slow", ada);
    const dead = await connection(google, "dead", ada);
    const moved = await connection(google, "moved", ada);
    // Asked whether it still holds the grant, the first connection keeps its answer back.
    await slow.run((_instance, state) => { state.storage.kv.put("test:holdGrantCheck", true); });
    const asked = () => slow.stored<boolean>("test:grantCheckHeld");
    try {
      google.refused.set("refresh-dead", null);
      await expect(dead.refresh()).rejects.toThrow(/expired or been revoked/);
      await reconnect(google, moved, "moved-again", grace);
      expect(await asked()).toBeUndefined();
    } finally {
      await slow.run((_instance, state) => { state.storage.kv.delete("test:holdGrantCheck"); });
    }
    // Neither is listed any more: the first connection is the Google account's last.
    await slow.disconnect();
    expect(google.revoked).toEqual(["refresh-slow"]);
  });

  // Which Google account the credentials are is known apart from whether the registry listed
  // the account, so its answer counts though listing failed and Google cannot be asked again.
  it("goes by the registry of the Google account it is known to be, though listing it there failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    await connection(google, "other", ada);
    const renewed = await storedAccount(google, "renewed", ada);
    const add = vi.spyOn(GoogleGrantRegistry.prototype, "add").mockImplementation(async () => {
      throw new Error("registry unavailable");
    });
    await reconnect(google, renewed, "renewed-again", ada);
    add.mockRestore();
    expect(await renewed.stored("grantCredentialsId")).toBeUndefined();

    google.profileFails = true;
    await renewed.disconnect();
    expect(google.revoked).toEqual([]);
  });

  // A connection left unused has no live access token to say Google still honours its refresh
  // token, which Google may have ended meanwhile: one it no longer honours holds no grant.
  it("asks Google whether an idle holder's refresh token still works before counting it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const lapse = (account: ReturnType<typeof accountHandle>, name: string) => account.run((_instance, state) => {
      state.storage.kv.put("accessToken", {token: `access-${name}`, expires: new Date(Date.now() - 1000)});
    });
    const ended = await connection(google, "ended", ada);
    const working = await connection(google, "working", ada);
    await lapse(ended, "ended");
    google.refused.set("refresh-ended", null);
    await working.disconnect();
    expect(google.revoked).toEqual(["refresh-working"]);
    expect(await ended.stored("refreshTokenDead")).toBe(true);

    // Reconnected, it is the Google account's holder again, so its next disconnect spares another.
    await reconnect(google, ended, "ended-again", ada);
    const another = await connection(google, "another", ada);
    await another.disconnect();
    expect(google.revoked).toEqual(["refresh-working"]);

    // One Google still honours goes on counting.
    const idle = await connection(google, "idle", grace);
    const leaving = await connection(google, "leaving", grace);
    await lapse(idle, "idle");
    await leaving.disconnect();
    expect(google.revoked).toEqual(["refresh-working"]);
  });

  it("stops counting a refused connection whose removal the registry never received", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const dead = await connection(google, "dead", ada);
    const working = await connection(google, "working", ada);
    google.refused.set("refresh-dead", null);
    vi.spyOn(GoogleGrantRegistry.prototype, "drop").mockImplementationOnce(async () => {
      throw new Error("registry unavailable");
    });
    await expect(dead.refresh()).rejects.toThrow(/expired or been revoked/);
    expect(await dead.stored("refreshToken")).toBe("refresh-dead");

    // Never used again, the refused connection stays listed. Asked, it no longer holds the grant.
    await working.disconnect();
    expect(google.revoked).toEqual(["refresh-working"]);
  });
});

describe("GoogleGrantRegistry", () => {
  const registryOf = (subject: string) =>
    testEnv.GoogleGrantRegistry.get(testEnv.GoogleGrantRegistry.idFromName(subject));

  it("says a holder is the last only once no other account holds the grant", async () => {
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const first = await connection(google, "first", ada);
    const second = await connection(google, "second", ada);
    const registry = registryOf(ada);

    // One that was never recorded is the last only if nothing else holds the grant.
    expect(await registry.remove(testEnv.UserAccount.newUniqueId().toString())).toEqual({last: false});
    expect(await registry.remove(first.id)).toEqual({last: false});
    expect(await registry.remove(second.id)).toEqual({last: true});
    expect(await registry.remove(second.id)).toEqual({last: true});
  });

  it("drops a recorded holder whose account no longer holds the grant", async () => {
    const google = fakeGoogle();
    const {ada, grace} = googleAccounts();
    const registry = registryOf(ada);
    // Recorded here, but the account holds nothing, or holds another Google account's grant.
    const emptied = testEnv.UserAccount.newUniqueId().toString();
    const elsewhere = await connection(google, "elsewhere", grace);
    await registry.add(emptied);
    await registry.add(elsewhere.id);

    const last = await connection(google, "last", ada);
    expect(await registry.remove(last.id)).toEqual({last: true});
    // Both were dropped as they were asked, so neither is asked again.
    await registry.add(last.id);
    expect(await registry.remove(last.id)).toEqual({last: true});
  });

  it("counts a holder recorded while it was asking another", async () => {
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const registry = registryOf(ada);
    // The holder that connects meanwhile is listed before the one being asked, where a list read
    // once, before asking, has already passed.
    const [earlier, later] = [testEnv.UserAccount.newUniqueId(), testEnv.UserAccount.newUniqueId()]
      .toSorted((a, b) => a.toString() < b.toString() ? -1 : 1);
    const emptied = accountHandle(later);
    await emptied.run((_instance, state) => { state.storage.kv.put("test:holdGrantCheck", true); });
    await registry.add(emptied.id);

    const removing = registry.remove(testEnv.UserAccount.newUniqueId().toString());
    await vi.waitFor(async () => expect(await emptied.stored("test:grantCheckHeld")).toBe(true), {timeout: 5000});

    google.subjects.set("access-live", ada);
    const live = accountHandle(earlier);
    await live.run((_instance, state) => { state.storage.kv.put("refreshToken", "refresh-live"); });
    await live.refresh();
    await live.holds(ada);

    await emptied.run((_instance, state) => { state.storage.kv.delete("test:holdGrantCheck"); });
    expect(await removing).toEqual({last: false});
  });

  it("keeps a holder recorded again while it was being asked", async () => {
    fakeGoogle();
    const {ada} = googleAccounts();
    const registry = registryOf(ada);
    // Listed from an earlier connection whose removal never arrived, and holding nothing now.
    const account = accountHandle(testEnv.UserAccount.newUniqueId());
    await account.run((_instance, state) => { state.storage.kv.put("test:holdGrantCheck", true); });
    await registry.add(account.id);

    const removing = registry.remove(testEnv.UserAccount.newUniqueId().toString());
    await vi.waitFor(async () => expect(await account.stored("test:grantCheckHeld")).toBe(true), {timeout: 5000});

    // Its answer, that it holds nothing, is on its way back when it connects and is recorded
    // afresh: the registry must not drop the new record on the strength of that answer.
    await account.run((_instance, state) => {
      state.storage.kv.put("refreshToken", "refresh-again");
      state.storage.kv.put("credentialsId", "credentials-again");
      state.storage.kv.put("grantSubject", ada);
      state.storage.kv.put("grantCredentialsId", "credentials-again");
    });
    await registry.add(account.id);
    await account.run((_instance, state) => { state.storage.kv.delete("test:holdGrantCheck"); });
    expect(await removing).toEqual({last: false});
  });

  it("does not count a holder that let go while it was being asked", async () => {
    const google = fakeGoogle();
    const {ada} = googleAccounts();
    const registry = registryOf(ada);
    // Its answer, that it holds the grant, is on its way back when it lets go.
    const leaving = await connection(google, "leaving", ada);
    await leaving.run((_instance, state) => { state.storage.kv.put("test:holdGrantCheck", true); });

    const removing = registry.remove(testEnv.UserAccount.newUniqueId().toString());
    await vi.waitFor(async () => expect(await leaving.stored("test:grantCheckHeld")).toBe(true), {timeout: 5000});
    expect(await registry.remove(leaving.id)).toEqual({last: true});

    await leaving.run((_instance, state) => { state.storage.kv.delete("test:holdGrantCheck"); });
    expect(await removing).toEqual({last: true});
  });

  it("counts a holder it cannot ask as still holding the grant, and says it was unsure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const {ada} = googleAccounts();
    const registry = registryOf(ada);
    await registry.add("not an account id");

    expect(await registry.remove(testEnv.UserAccount.newUniqueId().toString()))
      .toEqual({last: false, unsure: true});
    expect(warn.mock.calls.some(([entry]) => entry?.event === "google.grant.holder.check.failed")).toBe(true);
  });
});
