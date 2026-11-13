import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import { DIRECTORY_ACTIVITY_INTERVAL_MS, type UserDirectoryDurableObject } from "../src/user-directory.js";
import type { UserDurableObject } from "../src/user.js";
// Load the whole backend (the pool's `main`) up front, as user-directory.test.ts does.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

// The deployment-wide directory the user DO feeds (it always addresses getByName("")).
const deploymentDirectory = () => env.TEST_USER_DIRECTORY.getByName("");

async function listed(id: string) {
  const { users } = await deploymentDirectory().listUsers({ query: id, limit: 10 });
  return users.find(listedUser => listedUser.id === id);
}

function directoryLoginAt(user: DurableObjectStub<UserDurableObject>): Promise<number> {
  return runInDurableObject(user, (_instance, state) =>
      makeUserStorage(state.storage).directoryLoginAt.get());
}

async function newAccount() {
  const username = `feed${crypto.randomUUID().replaceAll("-", "")}`;
  const user = env.TEST_USER.getByName(username);
  const token = await user.createAccount(username, "Feed User", new Uint8Array([1, 2, 3]));
  if (token === null) throw new Error(`Failed to create ${username}.`);
  return { username, user, token };
}

describe("the user DO's directory feed", () => {
  it("reports creation and session starts at most hourly, and renames without a login", async () => {
    const { username, user, token } = await newAccount();
    await user.authenticate(token);
    await expect.poll(() => listed(username)).toMatchObject({
      name: "Feed User", created: expect.any(Date), lastLogin: expect.any(Date),
    });
    const first = (await listed(username))!;
    const loginAt = await directoryLoginAt(user);
    expect(loginAt).toBe(first.lastLogin!.getTime());

    // Within the interval, a session start is not reported again.
    await user.authenticate(token);
    expect(await directoryLoginAt(user)).toBe(loginAt);
    expect(await listed(username)).toEqual(first);

    // Past it, the next one is.
    await runInDurableObject(user, (_instance, state) => {
      makeUserStorage(state.storage).directoryLoginAt.put(loginAt - DIRECTORY_ACTIVITY_INTERVAL_MS);
    });
    await user.authenticate(token);
    await expect.poll(async () => (await listed(username))?.lastLogin?.getTime())
        .toBeGreaterThan(first.lastLogin!.getTime());
    const second = (await listed(username))!;

    // A rename syncs the name and leaves the last login alone.
    await user.setOwnDisplayName("Renamed Feed User");
    await expect.poll(() => listed(username)).toEqual({ ...second, name: "Renamed Feed User" });
  });

  it("reports the creation of an account created by Cloudflare Access", async () => {
    const email = `feed-${crypto.randomUUID()}@example.com`;
    const user = env.TEST_USER.getByName(email);
    await expect(user.authenticateFromCfAccess(email, true)).resolves.toBe(true);
    await expect.poll(() => listed(email)).toMatchObject({
      name: email.split("@")[0], created: expect.any(Date), lastLogin: expect.any(Date),
    });
  });

  it("returns a workspace's stored record, its creation time included", async () => {
    const { user } = await newAccount();
    const before = Date.now();
    await user.newWorkspace("w1", "Workspace");
    const record = await user.getWorkspace("w1");
    expect(record).toMatchObject({ id: "w1", title: "Workspace" });
    expect(record!.created.getTime()).toBeGreaterThanOrEqual(before);
  });
});
