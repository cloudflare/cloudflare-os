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
  expect(await hooks.accountCalls(userId)).toEqual(["describe", "describe", "describe"]);
});

it("keeps cached descriptions when a gatekeeper is unavailable", async () => {
  using warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { user, hooks, userId, id } = await fixture();
  await runInDurableObject(user, instance => {
    const account = instance["ctx"].exports.FakeGatekeeperAccount({ props: { name: userId, failDescribe: true } });
    const storage = (instance as unknown as { storage: UserStorage }).storage;
    const record = storage.connectedAccounts.get(id)!;
    storage.connectedAccounts.put({ ...record, account,
      description: { ...record.description, providesUi: { title: "Cached app" } } });
  });
  const cached = [{ accountId: id, description: { providesUi: { title: "Cached app" } } }];
  expect(await user.listProvidedAccounts(true)).toMatchObject(cached);
  expect(await user.listProvidedAccounts()).toMatchObject(cached);
  expect(await user.listProvidedAccounts(true)).toMatchObject(cached);
  expect(await hooks.accountCalls(userId)).toEqual(["describe", "describe", "describe"]);
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
  const otherId = await hooks.addAccount(userId, "homeassistant", unrelated, { providesUi: true });
  await runInDurableObject(user, instance => {
    const storage = (instance as unknown as { storage: UserStorage }).storage;
    storage.connectedAccounts.put({ ...storage.connectedAccounts.get(otherId)!, autoProvisioned: true });
  });
  expect(await user.listProvidedAccounts(true, "container")).toContainEqual(expect.objectContaining({ accountId: id, vendorId: "container" }));
  expect(await hooks.accountCalls(unrelated)).toEqual(["describe"]);
});

it("shares discovery between the app list and a simultaneous direct app open", async () => {
  const { user, hooks, userId, id } = await fixture();
  await hooks.pauseAccountDescriptions(userId, true);
  let listSettled = false;
  let directSettled = false;
  const listing = user.listProvidedAccounts(true).then(result => { listSettled = true; return result; });
  await vi.waitFor(async () => expect(await hooks.accountCalls(userId)).toHaveLength(2));
  const direct = user.listProvidedAccounts(true, "container").then(result => { directSettled = true; return result; });
  try {
    // A later DO invocation lets the direct open reach the already-pending refresh.
    await runInDurableObject(user, () => {});
    expect(await hooks.accountCalls(userId)).toHaveLength(2);
    // Both callers must wait past the former one-second deadline instead of returning unavailable.
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(listSettled).toBe(false);
    expect(directSettled).toBe(false);
  } finally {
    await hooks.pauseAccountDescriptions(userId, false);
  }
  expect(await listing).toContainEqual(expect.objectContaining({ accountId: id }));
  expect(await direct).toContainEqual(expect.objectContaining({ accountId: id }));
  const frame = await user.startAccountAppUi(id, { isAdmin: false });
  expect(frame).not.toBeNull();
  frame!.ui[Symbol.dispose]();
});

it.each([
  { disabledGatekeepers: ["container"] },
  { ambientGatekeeperModes: { container: "disabled" } },
])("checks current availability before listing or opening an app: %j", async config => {
  const { user, hooks, userId, id } = await fixture();
  await hooks.pauseAccountDescriptions(userId, true);
  const listing = user.listProvidedAccounts(true);
  await vi.waitFor(async () => expect(await hooks.accountCalls(userId)).toHaveLength(2));
  await runInDurableObject(user, instance => {
    const internals = instance as unknown as { env: Cloudflare.Env };
    internals.env = { ...internals.env, BLUEPRINTS: { get: async () => JSON.stringify(config) } as unknown as KVNamespace };
  });
  await hooks.pauseAccountDescriptions(userId, false);
  expect(await listing).toEqual([]);
  expect(await user.listProvidedAccounts(true)).toEqual([]);
  expect(await hooks.openAppUi(userId, id, userId, "")).toBeNull();
  expect(await hooks.accountCalls(userId)).toEqual(["describe", "describe"]);
});

it("preserves the cached singleton when its management app is disabled", async () => {
  const singleton = { tsType: "ExistingSession" };
  const { user, hooks, userId, id } = await fixture({ singleton, providesUi: { title: "Container settings" } });
  await user.listProvidedAccounts(true);
  await runInDurableObject(user, instance => {
    const internals = instance as unknown as { env: Cloudflare.Env };
    internals.env = { ...internals.env, BLUEPRINTS: {
      get: async () => JSON.stringify({ disabledGatekeepers: ["container"] }),
    } as unknown as KVNamespace };
  });
  // Workspace reconciliation must still see the account, or it deletes its saved binding edges.
  expect(await user.listProvidedAccounts()).toMatchObject([{ accountId: id, description: { singleton } }]);
  expect(await user.listProvidedAccounts(true)).toEqual([]);
  expect(await hooks.openAppUi(userId, id, userId, "")).toBeNull();
  expect(await hooks.accountCalls(userId)).toEqual(["describe", "describe"]);
});

it("loads the account after the app availability check yields", async () => {
  const { user, hooks, userId, id } = await fixture();
  await user.listProvidedAccounts(true);
  const release = Promise.withResolvers<string | null>();
  let readingConfig = false;
  await runInDurableObject(user, instance => {
    const internals = instance as unknown as { env: Cloudflare.Env };
    internals.env = { ...internals.env, BLUEPRINTS: {
      get: () => { readingConfig = true; return release.promise; },
    } as unknown as KVNamespace };
  });
  const opening = hooks.openAppUi(userId, id, userId, "");
  try {
    await vi.waitFor(() => expect(readingConfig).toBe(true));
    await runInDurableObject(user, instance => {
      (instance as unknown as { storage: UserStorage }).storage.connectedAccounts.delete(id);
    });
  } finally { release.resolve(null); }
  expect(await opening).toBeNull();
  expect(await hooks.accountCalls(userId)).toEqual(["describe", "describe"]);
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
  expect(await pending).toHaveLength(change === "disconnect" ? 0 : 1);
  await runInDurableObject(user, instance => {
    const record = (instance as unknown as { storage: UserStorage }).storage.connectedAccounts.get(id);
    expect(record?.description.displayName).toBe(change === "disconnect" ? undefined : "Newer connection");
  });
});
