import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { GatekeeperUser, GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type Fixture = {
  user: UserDurableObject;
  verifier: Fetcher<GatekeeperUserVerifier>;
  verifierRequests: () => number;
};

let counter = 0;

// Runs `run` inside a user object whose stored accounts are one account of `vendorId`, with id 7.
function withUserAndAccount(vendorId: string, run: (fixture: Fixture) => Promise<void>) {
  const verifier = {} as Fetcher<GatekeeperUserVerifier>;
  let verifierRequests = 0;
  const account = {
    async getVerifier() {
      verifierRequests++;
      return verifier;
    },
  } as Fetcher<GatekeeperUser>;
  return runInDurableObject(env.TEST_USER.getByName(`user-verifier-${++counter}`),
      (user: UserDurableObject) => {
    Object.assign(user, {
      storage: {
        connectedAccounts: {
          get: (accountId: number) => accountId === 7
            ? { id: accountId, account, vendorId }
            : undefined,
        },
      },
    });
    return run({ user, verifier, verifierRequests: () => verifierRequests });
  });
}

describe("UserDurableObject.getVerifier", () => {
  it("returns a verifier when the connected account belongs to the expected vendor",
      () => withUserAndAccount("notion", async ({ user, verifier, verifierRequests }) => {
    await expect(user.getVerifier(7, "notion")).resolves.toBe(verifier);
    expect(verifierRequests()).toBe(1);
  }));

  it("returns null when the account is missing",
      () => withUserAndAccount("notion", async ({ user, verifierRequests }) => {
    await expect(user.getVerifier(999, "notion")).resolves.toBeNull();
    expect(verifierRequests()).toBe(0);
  }));

  it("throws when the connected account belongs to another vendor",
      () => withUserAndAccount("linear", async ({ user, verifierRequests }) => {
    await expect(user.getVerifier(7, "notion")).rejects.toThrow(
        "Invalid account selection for this service.");
    expect(verifierRequests()).toBe(0);
  }));
});
