import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { PendingLogin } from "../src/auth/login-flow.js";
import { hashSecret, newSecretToken, PENDING_HANDOFF_LIFETIME_MS } from "../src/connect-handoff.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_PENDING_LOGIN: DurableObjectNamespace<PendingLogin>;
  }
}

let counter = 0;
const fresh = () => env.TEST_PENDING_LOGIN.getByName(`pending-login-${++counter}`);

// Claims over the stub the way the browser does, reporting the outcome as a value (a native RPC
// promise left to `.rejects` is also flagged as an unhandled rejection by the pool).
async function claim(stub: DurableObjectStub<PendingLogin>, ticket: string): Promise<string> {
  try {
    return `token:${await stub.claim(ticket)}`;
  } catch (err) {
    return `error:${(err as Error).message}`;
  }
}

describe("PendingLogin", () => {
  it("releases the token once, and only to the matching ticket", async () => {
    const stub = fresh();
    const { secret, hash } = await newSecretToken();
    await stub.deliver("alice@example.com:session", hash);
    await runInDurableObject(stub, async (instance: PendingLogin) => {
      expect(await instance.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
      expect(await instance.ctx.storage.getAlarm()).toBeLessThanOrEqual(
        Date.now() + PENDING_HANDOFF_LIFETIME_MS);
    });

    // Holding the attempt is not enough: the attacker's own tab never sees the ticket.
    const other = fresh();
    await other.deliver("victim@example.com:session", hash);
    expect(await claim(other, (await newSecretToken()).secret.toHex()))
      .toBe("error:This sign-in attempt could not be verified. Please try again.");
    expect(await claim(other, "not-a-ticket"))
      .toBe("error:This sign-in attempt has expired. Please try again.");

    expect(await claim(stub, secret.toHex())).toBe("token:alice@example.com:session");
    expect(await claim(stub, secret.toHex()))
      .toBe("error:This sign-in attempt has expired. Please try again.");
    await runInDurableObject(stub, async (instance: PendingLogin) => {
      expect(await instance.ctx.storage.getAlarm()).toBeNull();
      expect([...instance.ctx.storage.kv.list()]).toEqual([]);
    });
  });

  it("reports the gatekeeper's failure to whoever claims", async () => {
    const stub = fresh();
    await stub.fail("This account has no verified email, so it can't be used to sign in.");

    expect(await claim(stub, "f".repeat(64)))
      .toBe("error:This account has no verified email, so it can't be used to sign in.");
    expect(await claim(stub, "f".repeat(64)))
      .toBe("error:This sign-in attempt has expired. Please try again.");
  });

  it("wipes an unclaimed token from the alarm", async () => {
    const stub = fresh();
    const { secret, hash } = await newSecretToken();
    await stub.deliver("alice@example.com:session", hash);

    await runInDurableObject(stub, (instance: PendingLogin) => instance.alarm());
    expect(await claim(stub, secret.toHex()))
      .toBe("error:This sign-in attempt has expired. Please try again.");
  });

  it("stores only the ticket's hash", async () => {
    const stub = fresh();
    const { secret, hash } = await newSecretToken();
    await stub.deliver("alice@example.com:session", hash);

    await runInDurableObject(stub, async (instance: PendingLogin) => {
      const stored = JSON.stringify([...instance.ctx.storage.kv.list()]);
      expect(stored).not.toContain(secret.toHex());
      expect(stored).toContain(await hashSecret(secret));
    });
  });
});
