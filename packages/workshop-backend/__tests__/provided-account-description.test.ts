import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { UserDurableObject } from "../src/user.js";
import type { UserStorage } from "../src/storage-schema/user-storage.js";
import type { GatekeeperUserPickerTestHooks } from "./test-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_GATEKEEPER_USER_PICKER: DurableObjectNamespace<GatekeeperUserPickerTestHooks>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

async function fixture() {
  const userId = `provided${crypto.randomUUID().replaceAll("-", "")}`;
  const user = env.TEST_USER.getByName(userId);
  const hooks = env.TEST_GATEKEEPER_USER_PICKER.getByName("");
  await runInDurableObject(user, instance => {
    // Keep deployment config local to this test, rather than altering the shared KV binding.
    const internals = instance as unknown as { env: Cloudflare.Env };
    internals.env = { ...internals.env, BLUEPRINTS: { get: async () => null } as unknown as KVNamespace };
  });
  const id = await hooks.addAccount(userId, "container", userId, { providesUi: true });
  await runInDurableObject(user, instance => {
    const storage = (instance as unknown as { storage: UserStorage }).storage;
    const record = storage.connectedAccounts.get(id)!;
    // Simulate an account connected before its gatekeeper advertised a management UI.
    const { providesUi: _ui, ...description } = record.description;
    storage.connectedAccounts.put({ ...record, description });
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
  expect(await hooks.accountCalls(userId)).toEqual(["describe", "describe"]);
});

it("keeps cached descriptions when a gatekeeper is unavailable", async () => {
  const { user, hooks, userId, id } = await fixture();
  await runInDurableObject(user, async instance => {
    const localEnv = (instance as unknown as { env: typeof env }).env;
    const account = await localEnv.TEST_GATEKEEPER_USER_PICKER.getByName("").unavailableAccount(userId);
    const storage = (instance as unknown as { storage: UserStorage }).storage;
    const record = storage.connectedAccounts.get(id)!;
    storage.connectedAccounts.put({ ...record, account });
  });
  expect(await user.listProvidedAccounts(true)).toEqual([]);
  expect(await hooks.accountCalls(userId)).toEqual(["describe", "describe"]);
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
