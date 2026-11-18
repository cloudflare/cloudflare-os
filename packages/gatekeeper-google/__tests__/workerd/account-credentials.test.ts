import {env} from "cloudflare:workers";
import {abortAllDurableObjects, runInDurableObject} from "cloudflare:test";
import {stageCredentials} from "@gadgets/gatekeeper-kit/credential-stage";
import type {GatekeeperConnectCallback} from "@gadgets/workshop-shared/gatekeeper";
import {afterEach, describe, expect, it, vi, type MockInstance} from "vitest";
import type {UserAccount} from "../../src/google";
import {connectCallbackEvents, heldConnectCallbacks, unreachableConnectCallbacks} from "./worker";

// What an account does when Google answers a token refresh: the error a caller reads, what is
// logged about a refusal, and what the Workshop is told.

const testEnv = env as unknown as {UserAccount: DurableObjectNamespace<UserAccount>};

type TestExports = {
  TestConnectCallback(options: {props: {name: string}}): Fetcher<GatekeeperConnectCallback>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  heldConnectCallbacks.clear();
});

/** A connected account whose access token has to be minted, with Google's token endpoint answered by `google.refresh`. */
async function connectedAccount() {
  const google = {
    refresh: (): Response => Response.json({access_token: "access-token", expires_in: 3600}),
    refreshes: 0,
    /** Whether Google holds back its answer about which account an access token belongs to. */
    profileHeld: false,
    /** How many of those answers are being held back. */
    profilesWaiting: 0,
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    // Asked once a token mints, to record whose grant the account holds.
    if (url.href === "https://www.googleapis.com/oauth2/v3/userinfo") {
      if (google.profileHeld) {
        google.profilesWaiting++;
        while (google.profileHeld) await new Promise(resolve => setTimeout(resolve, 1));
        google.profilesWaiting--;
      }
      return Response.json({sub: "subject"});
    }
    if (url.href !== "https://oauth2.googleapis.com/token") throw new Error(`unexpected request: ${url}`);
    google.refreshes++;
    return google.refresh();
  });
  const id = testEnv.UserAccount.newUniqueId();
  const name = id.toString();
  const account = () => testEnv.UserAccount.get(id);
  await runInDurableObject(account(), (_instance: UserAccount, state: DurableObjectState) => {
    state.storage.kv.put("refreshToken", "refresh-token");
    state.storage.kv.put("callback",
      (state.exports as unknown as TestExports).TestConnectCallback({props: {name}}));
  });
  return {
    google,
    mint: () => runInDurableObject(account(),
      async (instance: UserAccount) => (await instance.getAccessToken({forceRefresh: true})).token),
    /** Drop what the account remembers in memory, such as the refusal it won't ask Google about again for a minute. */
    restart: () => abortAllDurableObjects(),
    /** Replace the account's credentials as a confirmed reconnect does. */
    reconnect: () => runInDurableObject(account(), async (instance: UserAccount, state: DurableObjectState) => {
      await instance.commitReconnect(stageCredentials(state.storage.kv, {
        refreshToken: "new-refresh-token",
        accessToken: {token: "new-access-token", expires: new Date(Date.now() + 3_600_000)},
        grantedScopes: [], requestedResources: [],
      }, Date.now()));
    }),
    /** Whether the Workshop can be reached; while it can't, no notice arrives. */
    workshopReachable: (reachable: boolean) => {
      if (reachable) unreachableConnectCallbacks.delete(name);
      else unreachableConnectCallbacks.add(name);
    },
    /** Whether the Workshop keeps a restore notice open, as while it reads the account's description. */
    workshopHoldsRestore: (held: boolean) => {
      if (held) heldConnectCallbacks.add(name);
      else heldConnectCallbacks.delete(name);
    },
    /**
     * Waits until the Workshop has received exactly `notices`. A notice is sent without being
     * waited for, so one that is due arrives a little later; one that is not due would show in the
     * next call, which lists every notice so far, or after a `settle()`.
     */
    told: (...notices: string[]) => vi.waitFor(
      () => expect(connectCallbackEvents.get(name) ?? []).toEqual(notices), {timeout: 5000}),
    /**
     * Gives the account time to finish what it does unwaited: to record that a notice arrived once
     * the Workshop has returned from it, or to send a notice that is not due.
     */
    settle: () => new Promise(resolve => setTimeout(resolve, 50)),
  };
}

/** Waits until the account has logged that a notice did not reach the Workshop. */
const noticeFailed = (warn: MockInstance<typeof console.warn>, event: string) => vi.waitFor(
  () => expect(warn.mock.calls.some(([entry]) => entry?.event === event)).toBe(true), {timeout: 5000});

const refusal = (body: Record<string, unknown>) => () => Response.json(body, {status: 400});

describe("Google token refresh refusals", () => {
  it("says a revoked or expired grant needs re-authentication, and logs Google's code alone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = await connectedAccount();
    account.google.refresh = refusal(
      {error: "invalid_grant", error_description: "Token has been expired or revoked."});

    await expect(account.mint()).rejects.toThrow(
      "Google credentials have expired or been revoked. Please re-authenticate.");

    const logged = warn.mock.calls.map(([entry]) => entry)
      .filter(entry => entry?.event === "google.token.mint.refused");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({component: "gatekeeper.google", providerError: "invalid_grant"});
    expect(logged[0]).not.toHaveProperty("providerSubtype");
    expect(JSON.stringify(logged)).not.toContain("expired or revoked");
  });

  // Google names a Cloud session that ran out with either subtype.
  it.each(["invalid_rapt", "rapt_required"])(
      "tells a Google Cloud session that ran out (%s) apart from a revoked grant", async subtype => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = await connectedAccount();
    account.google.refresh = refusal({
      error: "invalid_grant", error_description: `reauth related error (${subtype})`,
      error_subtype: subtype,
    });

    await expect(account.mint()).rejects.toThrow(/requires a new sign-in for Google Cloud access/);
    // The refusal is remembered, so a burst of callers asks Google once.
    await expect(account.mint()).rejects.toThrow(/requires a new sign-in for Google Cloud access/);
    expect(account.google.refreshes).toBe(1);

    expect(warn.mock.calls.map(([entry]) => entry)
      .filter(entry => entry?.event === "google.token.mint.refused")).toEqual([
      expect.objectContaining({providerError: "invalid_grant", providerSubtype: subtype}),
    ]);
  });

  it("logs a scope an admin blocked without Google's description of it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = await connectedAccount();
    account.google.refresh = refusal(
      {error: "admin_policy_enforced", error_description: "scope blocked by policy"});

    await expect(account.mint()).rejects.toThrow(/admin has restricted access .*scope blocked by policy/);

    const logged = warn.mock.calls.map(([entry]) => entry)
      .filter(entry => entry?.event === "google.token.mint.refused");
    expect(logged).toEqual([expect.objectContaining({providerError: "admin_policy_enforced"})]);
    expect(JSON.stringify(logged)).not.toContain("scope blocked by policy");
  });
});

describe("Google credential expiry notices", () => {
  const revoked = refusal({error: "invalid_grant"});
  const blocked = refusal({error: "admin_policy_enforced", error_description: "blocked"});

  it("tells the Workshop once of credentials Google keeps refusing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = await connectedAccount();
    account.google.refresh = revoked;

    // The first notice has arrived, and the account has recorded that, before it restarts.
    await expect(account.mint()).rejects.toThrow(/expired or been revoked/);
    await account.told("credentialsExpired");
    await account.settle();
    await account.restart();
    await expect(account.mint()).rejects.toThrow(/expired or been revoked/);

    expect(account.google.refreshes).toBe(2);
    await account.settle();
    await account.told("credentialsExpired");
  });

  it("sends an expiry notice that did not arrive again at the next refusal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = await connectedAccount();
    account.google.refresh = revoked;
    account.workshopReachable(false);

    await expect(account.mint()).rejects.toThrow(/expired or been revoked/);
    await noticeFailed(warn, "credentials.expiry.notify.failed");
    await account.told();

    account.workshopReachable(true);
    await account.restart();
    await expect(account.mint()).rejects.toThrow(/expired or been revoked/);
    await account.told("credentialsExpired");
  });

  it("tells the Workshop when refused credentials mint again, and of a later refusal", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = await connectedAccount();
    account.google.refresh = blocked;
    await expect(account.mint()).rejects.toThrow(/admin has restricted access/);
    await account.told("credentialsExpired");

    // The admin lifts the restriction: nothing says so until Google is asked again.
    account.google.refresh = () => Response.json({access_token: "restored", expires_in: 3600});
    await account.restart();
    expect(await account.mint()).toBe("restored");
    await account.told("credentialsExpired", "credentialsRestored");

    // Told once: a mint that follows no refusal says nothing.
    expect(await account.mint()).toBe("restored");
    await account.told("credentialsExpired", "credentialsRestored");

    account.google.refresh = blocked;
    await expect(account.mint()).rejects.toThrow(/admin has restricted access/);
    await account.told("credentialsExpired", "credentialsRestored", "credentialsExpired");
  });

  it("sends a restore notice that did not arrive again at the next mint", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = await connectedAccount();
    account.google.refresh = blocked;
    await expect(account.mint()).rejects.toThrow(/admin has restricted access/);
    await account.told("credentialsExpired");

    account.google.refresh = () => Response.json({access_token: "restored", expires_in: 3600});
    account.workshopReachable(false);
    await account.restart();
    expect(await account.mint()).toBe("restored");
    await noticeFailed(warn, "credentials.restore.notify.failed");
    await account.told("credentialsExpired");

    account.workshopReachable(true);
    expect(await account.mint()).toBe("restored");
    await account.told("credentialsExpired", "credentialsRestored");
  });

  it("tells the Workshop of a refusal only once a restore notice before it has returned", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = await connectedAccount();
    account.google.refresh = blocked;
    await expect(account.mint()).rejects.toThrow(/admin has restricted access/);
    await account.told("credentialsExpired");

    account.google.refresh = () => Response.json({access_token: "restored", expires_in: 3600});
    account.workshopHoldsRestore(true);
    await account.restart();
    expect(await account.mint()).toBe("restored");
    await account.told("credentialsExpired", "credentialsRestored");

    // Google refuses again while the Workshop is still handling the restore notice, which ends with
    // the Workshop recording the connection as working: an expiry told to it now would be lost.
    account.google.refresh = blocked;
    await expect(account.mint()).rejects.toThrow(/admin has restricted access/);
    await account.settle();
    await account.told("credentialsExpired", "credentialsRestored");

    account.workshopHoldsRestore(false);
    await account.told("credentialsExpired", "credentialsRestored", "credentialsExpired");
  });

  it("drops an expiry notice whose credentials were replaced while it waited", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = await connectedAccount();
    account.google.refresh = blocked;
    await expect(account.mint()).rejects.toThrow(/admin has restricted access/);
    await account.told("credentialsExpired");

    account.google.refresh = () => Response.json({access_token: "restored", expires_in: 3600});
    account.workshopHoldsRestore(true);
    await account.restart();
    expect(await account.mint()).toBe("restored");
    await account.told("credentialsExpired", "credentialsRestored");

    // Refused again: its notice waits behind the restore notice the Workshop still holds.
    account.google.refresh = blocked;
    await expect(account.mint()).rejects.toThrow(/admin has restricted access/);
    await account.settle();

    // Told now, the notice would mark the new credentials expired, and nothing would clear that:
    // no refusal is recorded against them, so no mint sends a restore notice.
    await account.reconnect();
    account.workshopHoldsRestore(false);
    await account.settle();
    await account.told("credentialsExpired", "credentialsRestored");
  });

  it("drops a restore notice whose credentials were replaced while it waited", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = await connectedAccount();
    account.google.refresh = blocked;
    await expect(account.mint()).rejects.toThrow(/admin has restricted access/);
    await account.told("credentialsExpired");

    account.google.refresh = () => Response.json({access_token: "restored", expires_in: 3600});
    account.workshopHoldsRestore(true);
    await account.restart();
    expect(await account.mint()).toBe("restored");
    await account.told("credentialsExpired", "credentialsRestored");

    // The refusal is still on record while the Workshop holds its restore notice, so a second mint
    // queues a second one behind it.
    expect(await account.mint()).toBe("restored");
    await account.settle();

    await account.reconnect();
    account.workshopHoldsRestore(false);
    await account.settle();
    await account.told("credentialsExpired", "credentialsRestored");
  });

  it("tells again of new credentials refused before their reconnect returned, which the Workshop records as working", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = await connectedAccount();
    // The reconnect waits on Google to say whose grant it holds, and its new credentials are
    // refused meanwhile.
    account.google.profileHeld = true;
    const reconnecting = account.reconnect();
    await vi.waitFor(() => expect(account.google.profilesWaiting).toBe(1), {timeout: 5000});
    account.google.refresh = revoked;
    await expect(account.mint()).rejects.toThrow(/expired or been revoked/);
    await account.told("credentialsExpired");
    account.google.profileHeld = false;
    await reconnecting;

    // The Workshop marks the returned reconnect restored, so the next refusal is told again.
    await expect(account.mint()).rejects.toThrow(/expired or been revoked/);
    await account.told("credentialsExpired", "credentialsExpired");
  });

  it("starts afresh after a reconnect: no restore notice, and the next refusal is told", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = await connectedAccount();
    account.google.refresh = revoked;
    await expect(account.mint()).rejects.toThrow(/expired or been revoked/);
    await account.told("credentialsExpired");

    // The Workshop marks a confirmed reconnect restored itself.
    await account.reconnect();
    account.google.refresh = () => Response.json({access_token: "fresh", expires_in: 3600});
    expect(await account.mint()).toBe("fresh");
    await account.told("credentialsExpired");

    account.google.refresh = revoked;
    await expect(account.mint()).rejects.toThrow(/expired or been revoked/);
    await account.told("credentialsExpired", "credentialsExpired");
  });
});
