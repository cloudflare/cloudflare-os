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

describe("gatekeeper user picker delivery", () => {
  it("delivers the picked person's own vendor identity and live profile to the viewer's app account", async () => {
    const viewer = uniqueUser("view");
    const picked = uniqueUser("picked");
    const testHooks = hooks();
    await Promise.all([
      testHooks.createUser(viewer, "Viewer"),
      testHooks.createUser(picked, "Before Rename"),
    ]);
    const [appAccount] = await Promise.all([
      testHooks.addAccount(viewer, "context", `${viewer}-context`, { providesUi: true }),
      testHooks.addAccount(picked, "context", `${picked}-context`),
    ]);
    await testHooks.renameUser(picked, "After Rename");

    await expect(testHooks.pick(viewer, appAccount, "collection-1", picked)).resolves.toBe(true);
    // The verifier came from the picked user's account (not the viewer's) and the profile reads the
    // name as it is now, not as it was when the account was linked.
    await expect(testHooks.accountCalls(`${viewer}-context`)).resolves.toContain(
      `receiveSelectedUser(collection-1, ${picked}-context, After Rename)`);
    await expect(testHooks.accountCalls(`${picked}-context`)).resolves.not.toContainEqual(
      expect.stringContaining("receiveSelectedUser"));
  });

  it("delivers nothing for people without a single active same-vendor account, or for the viewer", async () => {
    const viewer = uniqueUser("view");
    const wrongVendor = uniqueUser("wrongvendor");
    const expired = uniqueUser("expired");
    const missing = uniqueUser("missing");
    const ambiguous = uniqueUser("ambiguous");
    const testHooks = hooks();

    await Promise.all([
      testHooks.createUser(viewer, "Viewer"),
      testHooks.createUser(wrongVendor, "Wrong Vendor"),
      testHooks.createUser(expired, "Expired Account"),
      testHooks.createUser(missing, "Missing Account"),
      testHooks.createUser(ambiguous, "Ambiguous User"),
    ]);
    const [appAccount] = await Promise.all([
      testHooks.addAccount(viewer, "context", `${viewer}-context`, { providesUi: true }),
      testHooks.addAccount(wrongVendor, "github", "wrong-github"),
      testHooks.addAccount(expired, "context", "expired-context", { expired: true }),
      testHooks.addAccount(ambiguous, "context", "context-one"),
    ]);
    await testHooks.addAccount(ambiguous, "context", "context-two");

    const pick = (userId: string) => testHooks.pick(viewer, appAccount, "collection-1", userId);
    await expect(Promise.all([
      pick(wrongVendor), pick(expired), pick(missing), pick(ambiguous), pick(viewer),
    ])).resolves.toEqual([false, false, false, false, false]);
    await expect(testHooks.accountCalls(`${viewer}-context`)).resolves.not.toContainEqual(
      expect.stringContaining("receiveSelectedUser"));
  });

  it("propagates the gatekeeper's error and refuses accounts without a UI", async () => {
    const viewer = uniqueUser("view");
    const picked = uniqueUser("picked");
    const testHooks = hooks();
    await Promise.all([
      testHooks.createUser(viewer, "Viewer"),
      testHooks.createUser(picked, "Picked"),
    ]);
    const [appAccount, plainAccount] = await Promise.all([
      testHooks.addAccount(viewer, "context", `${viewer}-context`, { providesUi: true }),
      testHooks.addAccount(viewer, "github", "viewer-github"),
      testHooks.addAccount(picked, "context", `${picked}-context`),
    ]);

    await expect(testHooks.pick(viewer, appAccount, "reject", picked))
      .resolves.toEqual({ error: "Collection not found." });
    await expect(testHooks.pick(viewer, plainAccount, "collection-1", picked))
      .resolves.toEqual({ error: "No such app." });
  });
});
