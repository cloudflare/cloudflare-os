import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { GatekeeperUserPickerTestHooks } from "./test-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_GATEKEEPER_USER_PICKER: DurableObjectNamespace<GatekeeperUserPickerTestHooks>;
  }
}

function hooks(): DurableObjectStub<GatekeeperUserPickerTestHooks> {
  return env.TEST_GATEKEEPER_USER_PICKER.getByName("");
}

function uniqueUser(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
}

describe("gatekeeper user picker", () => {
  it("resolves only users with a single active same-vendor account", async () => {
    const eligible = uniqueUser("eligible");
    const wrongVendor = uniqueUser("wrongvendor");
    const expired = uniqueUser("expired");
    const missing = uniqueUser("missing");
    const ambiguous = uniqueUser("ambiguous");
    const testHooks = hooks();

    await Promise.all([
      testHooks.createUser(eligible, "Eligible User"),
      testHooks.createUser(wrongVendor, "Wrong Vendor"),
      testHooks.createUser(expired, "Expired Account"),
      testHooks.createUser(missing, "Missing Account"),
      testHooks.createUser(ambiguous, "Ambiguous User"),
    ]);
    await Promise.all([
      testHooks.addAccount(eligible, "context", "eligible-context"),
      testHooks.addAccount(wrongVendor, "github", "wrong-github"),
      testHooks.addAccount(expired, "context", "expired-context", true),
      testHooks.addAccount(ambiguous, "context", "context-one"),
    ]);
    await testHooks.addAccount(ambiguous, "context", "context-two");

    const select = (userId: string) => testHooks.selectUser("context", userId);
    await expect(select(eligible)).resolves.toBe("Eligible User");
    await expect(Promise.all([
      select(wrongVendor), select(expired), select(missing), select(ambiguous),
    ])).resolves.toEqual([null, null, null, null]);
  });

  it("mints a profile that reads the current display name rather than a snapshot", async () => {
    const target = uniqueUser("profile");
    const testHooks = hooks();
    await testHooks.createUser(target, "Before Rename");
    await testHooks.addAccount(target, "context", "profile-context");
    await testHooks.renameUser(target, "After Rename");

    await expect(testHooks.selectUser("context", target)).resolves.toBe("After Rename");
  });
});

