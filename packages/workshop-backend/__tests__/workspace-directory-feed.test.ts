// The Overseer's feed into the deployment directory (OverseerImpl.syncDirectory(),
// markDirectoryDirty() and removeFromDirectory()): every title write converges the directory on
// the newest title, a workspace's creation time is backfilled once from its owner's record, and a
// deleted workspace leaves the directory once any sync in flight has settled.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) feeding the real directory
// it reaches through ctx.exports, read back through the TEST_USER_DIRECTORY binding.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { MAX_DIRECTORY_TEXT_LENGTH, type AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

const OWNER_USER_ID = "owner-user-do";
const CREATED = new Date(1700000000_000);

type Feed = {
  impl: any;
  instance: OverseerDurableObject;
  state: DurableObjectState;
  id: string;
  owner: AiChatAuthorInfo;
  // How often the owner's record was read for the workspace's creation time.
  gadgetReads: { count: number };
};

// A fake owner user DO: their profile, their record of the workspace, and what open() and
// deleteSelf() call on it.
function fakeUsers(feed: Pick<Feed, "id" | "owner" | "gadgetReads">) {
  let user = {
    id: { toString: () => OWNER_USER_ID },
    whoami: async () => feed.owner,
    getWorkspace: async () => {
      feed.gadgetReads.count++;
      return { id: feed.id, title: "Untitled Workspace", created: CREATED, lastActive: CREATED };
    },
    workspaceRemoved: async () => {},
    syncWorkspaceOutputs: async () => {},
    setWorkspaceLastActive: async () => {},
  };
  return { idFromString: (id: string) => id, get: () => user };
}

async function withFeed(fn: (feed: Feed) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`directory-feed-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject, state) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let unique = crypto.randomUUID();
    let feed: Feed = {
      impl, instance, state, id: state.id.toString(),
      owner: { type: "user", id: `owner-${unique}@example.test`, name: "Owner" },
      gadgetReads: { count: 0 },
    };
    impl.users = fakeUsers(feed);
    impl.scheduleAccessRestart = async () => {};
    await fn(feed);
  });
}

// Makes the workspace an initialised one owned by feed.owner, as far as the feed is concerned.
function initialise(feed: Feed): void {
  feed.impl.ownerId = OWNER_USER_ID;
  feed.impl.ownerProfileId = feed.owner.id;
  feed.impl.storage.ownerId.put(OWNER_USER_ID);
}

async function listed(feed: Feed, directory = env.TEST_USER_DIRECTORY.getByName("")) {
  let { workspaces } = await directory.listWorkspaces({ owner: feed.owner.id, limit: 10 });
  return workspaces;
}

describe("the workspace's directory feed", () => {
  it("converges the directory on the newest title, clamped", () => withFeed(async feed => {
    initialise(feed);
    feed.impl.storage.title.put("First");
    feed.impl.storage.title.put("Second");
    await expect.poll(() => listed(feed)).toMatchObject([{
      id: feed.id, title: "Second", owner: { id: feed.owner.id }, created: CREATED,
    }]);

    let long = "x".repeat(5000);
    feed.impl.storage.title.put(long);
    await expect.poll(async () => (await listed(feed))[0]?.title)
        .toBe(long.slice(0, MAX_DIRECTORY_TEXT_LENGTH));
  }));

  it("records what the directory acknowledged and skips a sync that would change nothing",
      () => withFeed(async feed => {
    initialise(feed);
    feed.impl.storage.title.put("Plans");
    await expect.poll(() => feed.impl.storage.directoryRev.get())
        .toBe(feed.impl.storage.titleRev.get());

    let real = feed.impl.directories;
    let sends = 0;
    feed.impl.directories = {
      getByName: (name: string) => {
        sends++;
        return real.getByName(name);
      },
    };
    feed.impl.syncDirectory();
    feed.impl.markDirectoryDirty();
    await scheduler.wait(100);
    expect(sends).toBe(0);
  }));

  it("backfills the creation time once from the owner's record", () => withFeed(async feed => {
    initialise(feed);
    feed.impl.storage.title.put("Plans");
    await expect.poll(() => feed.impl.storage.createdAt.get()).toStrictEqual(CREATED);
    expect(feed.gadgetReads.count).toBe(1);

    feed.impl.storage.title.put("Plans, revised");
    await expect.poll(async () => (await listed(feed))[0]?.title).toBe("Plans, revised");
    expect(feed.gadgetReads.count).toBe(1);
    expect((await listed(feed))[0].created).toStrictEqual(CREATED);
  }));

  it("reports activity when given it", () => withFeed(async feed => {
    initialise(feed);
    feed.impl.storage.title.put("Plans");
    await expect.poll(() => listed(feed)).toHaveLength(1);
    let lastActive = new Date(Date.now() - 1000);
    feed.impl.syncDirectory(lastActive);
    await expect.poll(async () => (await listed(feed))[0]?.lastActive).toStrictEqual(lastActive);
  }));

  it("takes the workspace out, and adds it back only once re-armed", () => withFeed(async feed => {
    initialise(feed);
    feed.impl.storage.title.put("Plans");
    await expect.poll(() => listed(feed)).toHaveLength(1);

    await feed.impl.removeFromDirectory();
    expect(await listed(feed)).toStrictEqual([]);
    expect(feed.impl.storage.directoryRev.get()).toBe(-1);

    feed.impl.storage.title.put("Plans, after removal");
    feed.impl.markDirectoryDirty();
    feed.impl.syncDirectory();
    await scheduler.wait(200);
    expect(await listed(feed)).toStrictEqual([]);

    feed.impl.directoryRemoved = false;
    feed.impl.syncDirectory();
    await expect.poll(async () => (await listed(feed))[0]?.title).toBe("Plans, after removal");
  }));

  it("lets a deletion complete while a directory sync is in flight", () => withFeed(async feed => {
    // A fresh directory instance is held busy, and the workspace's sync to it parks.
    let heldName = crypto.randomUUID();
    let held = () => env.TEST_USER_DIRECTORY.getByName(heldName);
    void runInDurableObject(held(), (_directory, state) =>
        state.blockConcurrencyWhile(() => scheduler.wait(2000)));
    await scheduler.wait(100);

    let impl = feed.impl;
    impl.directories = { getByName: () => held() };
    impl.ensureAmbientCapsules = async () => {};

    // The session's close notification, as a plain function.
    let notifyClosed: any = Object.assign(async () => {}, {
      dup: () => notifyClosed,
      [Symbol.dispose]: () => {},
    });

    // The owner's first open initialises the workspace and starts a sync, parked on the hold.
    let client = await feed.instance.open(OWNER_USER_ID, feed.owner.id, notifyClosed);
    expect(impl.storage.directoryRev.get()).toBe(-1);

    let started = Date.now();
    await client.deleteSelf();
    expect(Date.now() - started).toBeLessThan(2000 + 5000);
    expect([...feed.state.storage.kv.list()]).toStrictEqual([]);
    expect(await listed(feed, held())).toStrictEqual([]);
  }), 30_000);
});
