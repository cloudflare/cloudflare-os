import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {
  WORKSPACE_FILE_QUOTA_BYTES, WORKSPACE_STORAGE_WARNING_BYTES, WORKSPACE_TURN_QUOTA_BYTES,
} from "@gadgets/workshop-shared/api";
import type {OverseerDurableObject} from "../src/overseer";
import type {UserDurableObject} from "../src/user";

declare module "cloudflare:workers" { interface ProvidedEnv {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
}}
type Impl = OverseerDurableObject["impl"];
const USER = {type: "user" as const, id: "test-user", name: "Test"};
const MODEL = {type: "agent" as const, id: "claude", name: "Claude"};
async function inKernel<T>(test: (impl: Impl) => Promise<T>): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()),
      instance => test(instance.impl));
}

describe("workspace storage quotas", () => {
  it("refuses new files over 1 MiB at the file quota, saying why, but stores small ones", () => inKernel(async impl => {
    vi.spyOn(impl, "sampleStorageBytes").mockReturnValue(WORKSPACE_FILE_QUOTA_BYTES - 1000);
    expect(() => impl.gitCache.writeBlob(new Uint8Array(2 * 1024 * 1024)))
      .toThrow("This workspace's storage is nearly full (8.0 of 10 GB used), so it can't store " +
        "new files over 1 MB.");
    expect(impl.gitCache.writeBlob(Uint8Array.of(1)).byteLength).toBe(1);
    // As the composer uploads: streamed, with its length.
    const small = new Blob([new Uint8Array(1000)]);
    expect((await impl.gitCache.writeBlobStream(small.stream(), small.size)).byteLength).toBe(1000);
  }));

  it("ends a turn at the turn quota with a storage_full error, leaving the chat idle", () => inKernel(async impl => {
    const chatId = await impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()),
      {profile: USER}, "Hello");
    vi.spyOn(impl, "sampleStorageBytes").mockReturnValue(WORKSPACE_TURN_QUOTA_BYTES);
    impl.startAgent(chatId,
      {profile: MODEL, config: {provider: "anthropic", model: "claude", apiToken: "unused"}},
      USER, USER.id);
    await impl.waitForAllAgentsToComplete();
    const last = [...impl.storage.chats.list()].filter(message => message.chatId === chatId).at(-1);
    expect(last).toMatchObject({type: "error", code: "storage_full",
      message: "This workspace's storage is full (9.5 of 10 GB used), so the agent can't run."});
    expect(impl.storage.chatMeta.get(chatId)?.activeAgent).toBeUndefined();
  }));

  it("reports storage use from the warning threshold, as it changes by a tenth of a GB", () => inKernel(async impl => {
    let stored = 0;
    Object.defineProperty(impl.ctx.storage.sql, "databaseSize", {get: () => stored, configurable: true});
    const heard: (number | undefined)[] = [];
    impl.storageBytesSubscribers.add(bytes => heard.push(bytes));
    for (const bytes of [WORKSPACE_STORAGE_WARNING_BYTES - 1, WORKSPACE_STORAGE_WARNING_BYTES,
      WORKSPACE_STORAGE_WARNING_BYTES + 50_000_000, WORKSPACE_STORAGE_WARNING_BYTES + 100_000_000, 1000]) {
      stored = bytes;
      impl.sampleStorageBytes();
    }
    expect(heard).toEqual([WORKSPACE_STORAGE_WARNING_BYTES,
      WORKSPACE_STORAGE_WARNING_BYTES + 100_000_000, undefined]);
    expect(impl.reportedStorageBytes()).toBeUndefined();
  }));
});
