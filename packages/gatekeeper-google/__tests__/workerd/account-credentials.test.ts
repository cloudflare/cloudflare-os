import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {UserAccount} from "../../src/google";

// What an account does when Google answers a token refresh: the error a caller reads, and what is
// logged about the refusal.

const testEnv = env as unknown as {UserAccount: DurableObjectNamespace<UserAccount>};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A connected account whose access token has to be minted, with Google's token endpoint answered by `google.refresh`. */
async function connectedAccount() {
  const google = {
    refresh: (): Response => Response.json({access_token: "access-token", expires_in: 3600}),
    refreshes: 0,
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.href !== "https://oauth2.googleapis.com/token") throw new Error(`unexpected request: ${url}`);
    google.refreshes++;
    return google.refresh();
  });
  const stub = testEnv.UserAccount.get(testEnv.UserAccount.newUniqueId());
  await runInDurableObject(stub, (_instance: UserAccount, state: DurableObjectState) => {
    state.storage.kv.put("refreshToken", "refresh-token");
  });
  return {
    google,
    mint: () => runInDurableObject(stub, async (instance: UserAccount) => (await instance.getAccessToken()).token),
  };
}

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
