import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Exercise verifier-stub persistence, which the cloning Node fake cannot represent.
function host(name: string) {
  return env.TRACKER_HOST.getByName(name);
}

describe("tracked observers over real Durable Object storage", () => {
  it("persists a verifier stub and calls it back out of storage", async () => {
    const tracker = host("persists");

    await tracker.admit("alice", { allowed: ["repo-a"] });

    expect(await tracker.observerIds()).toEqual(["alice"]);
    // Read back from storage rather than reusing the admission argument: this is what a later
    // activation's read does, and the only thing that proves the write took a live capability.
    expect(await tracker.askStored("alice", ["repo-a", "repo-b"])).toEqual([true, false]);
  });

  it("hides a revealed set from the stored observer that cannot see it", async () => {
    const tracker = host("excludes");

    await tracker.admit("alice", { allowed: ["repo-a"] });
    await tracker.admit("bob", { allowed: [] });

    expect(await tracker.reveal(["repo-a"])).toEqual(["bob"]);
  });

  it("excludes an observer whose verifier answers short instead of trusting position", async () => {
    const tracker = host("short-answer");

    await tracker.admit("alice", { allowed: ["repo-a"] });
    await tracker.admit("bob", { allowed: ["repo-a"], dropVerdicts: 1 });

    // Over real RPC, where a verdict array crosses a serialization boundary: a length the oracle
    // disagrees about excludes that observer rather than being read positionally.
    expect(await tracker.reveal(["repo-a"])).toEqual(["bob"]);
  });

  it("fences admission through a second tracker while a withheld read is open", async () => {
    const tracker = host("withheld-fence");

    // The fence is in memory, keyed by the storage object, so it only reaches a second tracker if
    // `ctx.storage.kv` answers with one identity per Durable Object. Nothing in the Workers types
    // promises that; a fresh wrapper per access would admit an observer the open read excludes.
    expect(await tracker.admitDuringWithheldRead("mallory", { allowed: [] }))
      .toMatch(/can no longer be observed/);
  });
});
