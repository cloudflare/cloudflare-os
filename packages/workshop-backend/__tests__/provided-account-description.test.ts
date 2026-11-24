import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { AccountDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { UserDurableObject } from "../src/user.js";
import type { UserStorage } from "../src/storage-schema/user-storage.js";
import type { GatekeeperUserPickerTestHooks } from "./test-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_GATEKEEPER_USER_PICKER: DurableObjectNamespace<GatekeeperUserPickerTestHooks>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

async function fixture(description?: AccountDescription) {
  const userId = `provided${crypto.randomUUID().replaceAll("-", "")}`;
  const user = env.TEST_USER.getByName(userId);
  const hooks = env.TEST_GATEKEEPER_USER_PICKER.getByName("");
  await runInDurableObject(user, instance => {
    // Keep deployment config local to this test, rather than altering the shared KV binding.
    const internals = instance as unknown as { env: Cloudflare.Env };
    internals.env = { ...internals.env, BLUEPRINTS: { get: async () => null } as unknown as KVNamespace };
  });
  const id = await hooks.addAccount(userId, "container", userId, { providesUi: true, description });
  await runInDurableObject(user, instance => {
    const storage = (instance as unknown as { storage: UserStorage }).storage;
    const record = storage.connectedAccounts.get(id)!;
    // Simulate an account connected before its gatekeeper advertised a management UI.
    const { providesUi: _ui, ...description } = record.description;
    storage.connectedAccounts.put({ ...record, description, autoProvisioned: true });
  });
  return { user, hooks, userId, id };
}

it("discovers a newly advertised app for an existing account, persisting it without reconnecting", async () => {
  const { user, hooks, userId, id } = await fixture();
  expect(await user.listProvidedAccounts()).toEqual([]);
  expect(await user.listProvidedAccounts(true)).toMatchObject([{
    accountId: id, vendorId: "container", description: { providesUi: { title: userId } },
  }]);
  expect(await user.listProvidedAccounts()).toHaveLength(1);
  expect(await user.listProvidedAccounts(true)).toHaveLength(1);
  expect(await hooks.accountCalls(userId)).toEqual(["describe", "describe"]);
});

it("keeps cached descriptions when a gatekeeper is unavailable", async () => {
  using warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { user, hooks, userId, id } = await fixture();
  await runInDurableObject(user, async instance => {
    const localEnv = (instance as unknown as { env: typeof env }).env;
    const account = await localEnv.TEST_GATEKEEPER_USER_PICKER.getByName("").unavailableAccount(userId);
    const storage = (instance as unknown as { storage: UserStorage }).storage;
    const record = storage.connectedAccounts.get(id)!;
    storage.connectedAccounts.put({ ...record, account,
      description: { ...record.description, providesUi: { title: "Cached app" } } });
  });
  const cached = [{ accountId: id, description: { providesUi: { title: "Cached app" } } }];
  expect(await user.listProvidedAccounts(true)).toMatchObject(cached);
  expect(await user.listProvidedAccounts()).toMatchObject(cached);
  expect(await user.listProvidedAccounts(true)).toMatchObject(cached);
  expect(await hooks.accountCalls(userId)).toEqual(["describe", "describe"]);
  expect(warnings.mock.calls).toContainEqual([expect.objectContaining({
    event: "account.describe.refresh.failed", vendorId: "container", accountId: id,
  })]);
  expect(JSON.stringify(warnings.mock.calls)).not.toContain("private provider response body");
});

it("updates only app metadata, preserving cached identity, grants and the independent singleton", async () => {
  const providesUi = { title: "Container settings" };
  const { user, id } = await fixture({ avatar: undefined, providesUi });
  const cached = {
    displayName: "Cached owner", uniqueName: "owner@example.test", avatar: { url: "https://example.test/avatar" },
    singleton: { tsType: "ExistingSession" }, grantedResourceTypeIds: ["repository"],
  };
  await runInDurableObject(user, instance => {
    const storage = (instance as unknown as { storage: UserStorage }).storage;
    storage.connectedAccounts.put({ ...storage.connectedAccounts.get(id)!, description: cached });
  });
  expect(await user.listProvidedAccounts(true)).toMatchObject([{ description: { ...cached, providesUi } }]);
  await runInDurableObject(user, instance => {
    expect((instance as unknown as { storage: UserStorage }).storage.connectedAccounts.get(id)!.description)
      .toEqual({ ...cached, providesUi });
  });
});

it("removes cached app metadata when the gatekeeper no longer advertises an app", async () => {
  const { user, id } = await fixture({ avatar: undefined });
  await runInDurableObject(user, instance => {
    const storage = (instance as unknown as { storage: UserStorage }).storage;
    const rec = storage.connectedAccounts.get(id)!;
    storage.connectedAccounts.put({ ...rec, description: { ...rec.description, providesUi: { title: "Old app" } } });
  });
  expect(await user.listProvidedAccounts(true)).toEqual([]);
});

it("refreshes only the requested vendor for a direct app open", async () => {
  const { user, hooks, userId, id } = await fixture();
  const unrelated = `${userId}-unrelated`;
  await hooks.addAccount(userId, "homeassistant", unrelated, { providesUi: true });
  expect(await user.listProvidedAccounts(true, "container")).toMatchObject([{ accountId: id, vendorId: "container" }]);
  expect(await hooks.accountCalls(unrelated)).toEqual(["describe"]);
});

it("does not refresh ordinary OAuth accounts", async () => {
  const { user, hooks, userId, id } = await fixture();
  await runInDurableObject(user, instance => {
    const storage = (instance as unknown as { storage: UserStorage }).storage;
    storage.connectedAccounts.put({ ...storage.connectedAccounts.get(id)!, autoProvisioned: false });
  });
  expect(await user.listProvidedAccounts(true)).toEqual([]);
  expect(await hooks.accountCalls(userId)).toEqual(["describe"]);
});

it("bounds the wait, coalesces blocked refreshes and persists late app discovery", async () => {
  const { user, hooks, userId, id } = await fixture();
  await hooks.pauseAccountDescriptions(userId, true);
  let settled = false;
  const pending = user.listProvidedAccounts(true).then(result => { settled = true; return result; });
  try {
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2_000 });
    expect(await pending).toEqual([]);
    expect(await user.listProvidedAccounts(true)).toEqual([]);
    expect(await hooks.accountCalls(userId)).toEqual(["describe", "describe"]);
  } finally {
    await hooks.pauseAccountDescriptions(userId, false);
    await pending;
  }
  await vi.waitFor(async () => expect(await user.listProvidedAccounts()).toMatchObject([
    { accountId: id, description: { providesUi: { title: userId } } },
  ]));
  expect(await user.listProvidedAccounts(true)).toHaveLength(1);
  expect(await hooks.accountCalls(userId)).toEqual(["describe", "describe"]);
});

it("refreshes again after the throttle interval", async () => {
  const { user, hooks, userId } = await fixture();
  await user.listProvidedAccounts(true);
  using _clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000);
  await user.listProvidedAccounts(true);
  expect(await hooks.accountCalls(userId)).toEqual(["describe", "describe", "describe"]);
});

it.each(["disconnect", "new description"])("preserves a concurrent %s during metadata discovery", async change => {
  const { user, hooks, userId, id } = await fixture();
  await hooks.pauseAccountDescriptions(userId, true);
  const pending = user.listProvidedAccounts(true);
  await vi.waitFor(async () => expect(await hooks.accountCalls(userId)).toHaveLength(2));
  await runInDurableObject(user, instance => {
    const storage = (instance as unknown as { storage: UserStorage }).storage;
    if (change === "disconnect") storage.connectedAccounts.delete(id);
    else {
      const record = storage.connectedAccounts.get(id)!;
      storage.connectedAccounts.put({ ...record, description: { ...record.description, displayName: "Newer connection" } });
    }
  });
  await hooks.pauseAccountDescriptions(userId, false);
  expect(await pending).toEqual([]);
  await runInDurableObject(user, instance => {
    const record = (instance as unknown as { storage: UserStorage }).storage.connectedAccounts.get(id);
    expect(record?.description.displayName).toBe(change === "disconnect" ? undefined : "Newer connection");
  });
});
