import { describe, expect, it, vi } from "vitest";
import { withAuthRetry } from "../src/auth-retry";

type TokenRequest = { forceRefresh: boolean; staleToken?: string };

describe("withAuthRetry", () => {
  it("uses the first token without adding a stale-token hint", async () => {
    const getToken = vi.fn(async () => "current");
    const run = vi.fn(async (token: string) => `${token}-result`);

    expect(await withAuthRetry({ getToken, isAuthError: () => false }, run))
      .toBe("current-result");
    expect(getToken).toHaveBeenCalledOnce();
    expect(getToken).toHaveBeenCalledWith({ forceRefresh: false });
    expect(run).toHaveBeenCalledOnce();
  });

  it("passes through a first non-auth failure without refreshing", async () => {
    const failure = new Error("provider unavailable");
    const getToken = vi.fn(async () => "current");
    const run = vi.fn(async () => { throw failure; });

    await expect(withAuthRetry({ getToken, isAuthError: () => false }, run))
      .rejects.toBe(failure);
    expect(getToken).toHaveBeenCalledOnce();
  });

  it("refreshes with the rejected token and returns the replayed result", async () => {
    const authError = new Error("401");
    const getToken = vi.fn(async ({ forceRefresh }: TokenRequest) =>
      forceRefresh ? "fresh" : "stale");
    const run = vi.fn(async (token: string) => {
      if (token === "stale") throw authError;
      return "accepted";
    });

    expect(await withAuthRetry({ getToken, isAuthError: error => error === authError }, run))
      .toBe("accepted");
    expect(getToken).toHaveBeenNthCalledWith(2, {
      forceRefresh: true,
      staleToken: "stale",
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("throws the failure a twice-rejected credential ends with", async () => {
    const firstError = new Error("first 401");
    const secondError = new Error("second 401");
    const getToken = vi.fn(async ({ forceRefresh }: TokenRequest) =>
      forceRefresh ? "fresh" : "stale");
    const run = vi.fn(async (token: string) => {
      throw token === "stale" ? firstError : secondError;
    });

    // Reporting it belongs to `CredentialSource.run`, which holds the identity to fence on.
    await expect(withAuthRetry({
      getToken,
      isAuthError: error => error === firstError || error === secondError,
    }, run)).rejects.toBe(secondError);
  });

  it("propagates a non-auth failure from the replay untouched", async () => {
    const authError = new Error("401");
    const providerError = new Error("provider unavailable");
    const getToken = vi.fn(async ({ forceRefresh }: TokenRequest) =>
      forceRefresh ? "fresh" : "stale");
    const run = vi.fn(async (token: string) => {
      throw token === "stale" ? authError : providerError;
    });

    await expect(withAuthRetry({
      getToken,
      isAuthError: error => error === authError,
    }, run)).rejects.toBe(providerError);
  });
});
