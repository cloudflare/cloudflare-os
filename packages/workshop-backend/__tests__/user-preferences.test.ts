// What the user last chose in the app is kept in their User DO (updatePreferences()), within
// MAX_PREFERENCES_SIZE, and pushed to every subscriber so another tab or device sees it.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { expect, it, vi } from "vitest";
import { MAX_PREFERENCES_SIZE, type UserPreferences, type UserPreferencesSubscriber }
  from "@gadgets/workshop-shared/api";
import { UserDurableObject } from "../src/user.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

class PreferenceUpdates extends RpcTarget implements UserPreferencesSubscriber {
  readonly received: UserPreferences[] = [];
  async updated(preferences: UserPreferences) { this.received.push(preferences); }
}

const newUser = async () => {
  const id = crypto.randomUUID();
  const user = env.TEST_USER.getByName(id);
  await runInDurableObject(user, (_instance, ctx) =>
    makeUserStorage(ctx.storage).profile.put({type: "user", id, name: "User"}));
  return user;
};

it("starts empty, sets only the keys given, and pushes each change to every subscriber", async () => {
  const user = await newUser();
  const updates = new PreferenceUpdates();
  using callback = new RpcStub(updates);
  using _subscription = await user.subscribeToPreferences(callback);
  await vi.waitFor(() => expect(updates.received).toEqual([{}]));

  await user.updatePreferences({recentCommands: '["brief"]'});
  await user.updatePreferences({asideShown: '{"w1":"gadget:7"}'});
  const expected = {recentCommands: '["brief"]', asideShown: '{"w1":"gadget:7"}'};
  await vi.waitFor(() => expect(updates.received).toEqual([{}, {recentCommands: '["brief"]'}, expected]));

  // A later subscriber starts from what is kept.
  const later = new PreferenceUpdates();
  using laterCallback = new RpcStub(later);
  using _laterSubscription = await user.subscribeToPreferences(laterCallback);
  await vi.waitFor(() => expect(later.received).toEqual([expected]));
  await user.updatePreferences({recentCommands: "[]"});
  await vi.waitFor(() => expect(later.received.at(-1)).toEqual({...expected, recentCommands: "[]"}));
  await vi.waitFor(() => expect(updates.received.at(-1)).toEqual({...expected, recentCommands: "[]"}));
});

it("refuses an update that would take the preferences past MAX_PREFERENCES_SIZE, changing nothing", async () => {
  const user = await newUser();
  // Keys count too: "a" and "b" take one unit each.
  await user.updatePreferences({a: "x".repeat(MAX_PREFERENCES_SIZE - 3)});
  await user.updatePreferences({b: "y"});
  const atBound = {a: "x".repeat(MAX_PREFERENCES_SIZE - 3), b: "y"};

  await runInDurableObject(user, instance => {
    expect(() => instance.updatePreferences({c: ""})).toThrow(/at most/);
    // Replacing a value counts what it leaves, not what it adds.
    instance.updatePreferences({b: "z"});
  });
  const updates = new PreferenceUpdates();
  using callback = new RpcStub(updates);
  using _subscription = await user.subscribeToPreferences(callback);
  await vi.waitFor(() => expect(updates.received).toEqual([{...atBound, b: "z"}]));
});
