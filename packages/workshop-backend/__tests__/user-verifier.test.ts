import { describe, expect, it } from "vite-plus/test";
import type { GatekeeperUser, GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";

function makeUserWithAccount(vendorId: string) {
  const verifier = {} as Fetcher<GatekeeperUserVerifier>;
  let verifierRequests = 0;
  const account = {
    async getVerifier() {
      verifierRequests++;
      return verifier;
    },
  } as Fetcher<GatekeeperUser>;
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    storage: {
      connectedAccounts: {
        get: (accountId: number) => accountId === 7
          ? { id: accountId, account, vendorId }
          : undefined,
      },
    },
  });
  return { user, verifier, verifierRequests: () => verifierRequests };
}

describe("UserDurableObject.getVerifier", () => {
  it("returns a verifier when the connected account belongs to the expected vendor", async () => {
    const { user, verifier, verifierRequests } = makeUserWithAccount("notion");

    await expect(user.getVerifier(7, "notion")).resolves.toBe(verifier);
    expect(verifierRequests()).toBe(1);
  });

  it("returns null when the account is missing", async () => {
    const { user, verifierRequests } = makeUserWithAccount("notion");

    await expect(user.getVerifier(999, "notion")).resolves.toBeNull();
    expect(verifierRequests()).toBe(0);
  });

  it("throws when the connected account belongs to another vendor", async () => {
    const { user, verifierRequests } = makeUserWithAccount("linear");

    await expect(user.getVerifier(7, "notion")).rejects.toThrow(
        "Invalid account selection for this service.");
    expect(verifierRequests()).toBe(0);
  });
});
