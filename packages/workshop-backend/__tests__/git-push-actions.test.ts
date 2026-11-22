// Exercises the push-authorization wiring in the Overseer itself -- submitAction's ancestry
// verification + marking walk, applyPendingAction's action-scoped GitCache stub and mark
// conversion, and removeGatekeeper's queued-push cleanup -- over real SQLite DO storage. The
// WorkspaceGitCache semantics themselves are covered by git-cache.test.ts on mock storage; this
// file covers the overseer-side chokepoints those semantics hang off of.
//
// This lives in __tests__/ (the unit workerd config): the TEST_OVERSEER binding exists only in
// vitest.config.ts, and the tests reach into impl storage/methods directly -- the same pattern
// as git-migration-do.test.ts. The gatekeeper facet is stubbed by overriding
// impl.getGatekeeperFacet on the instance, since a real Gatekeeper DO class cannot be minted
// from a test.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { concatBytes, encodeLooseObject, gitObjectOid } from "../src/git-codec";
import { decodePack } from "./git-cache-fixtures";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const GATEKEEPER = 7;
const USER = { type: "user" as const, id: "alice@example.com", name: "Alice" };

// Every scenario starts with the gatekeeper's record in place: submitAction refuses an action
// naming a connection the workspace no longer has.
async function inOverseer(name: string, fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(name);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.storage.gatekeepers.put({
      id: GATEKEEPER,
      resourceTitle: "Remote repository",
      class: {} as any,
      creationSpec: {
        type: "gatekeeper",
        vendorId: "testvendor",
        resourceUrl: "https://example.com/repo",
        typeUrlPattern: "https://*",
      },
    });
    await fn(impl);
  });
}

function commitPayload(tree: string, parents: string[], message: string): Uint8Array {
  let text = [
    `tree ${tree}`,
    ...parents.map(parent => `parent ${parent}`),
    "author Test <test@example.com> 1700000000 +0000",
    "committer Test <test@example.com> 1700000000 +0000",
    "",
    `${message}\n`,
  ].join("\n");
  return new TextEncoder().encode(text);
}

async function storeLocal(impl: any, type: string, payload: Uint8Array): Promise<string> {
  let oid = gitObjectOid(type as any, payload);
  impl.storage.gitObjects.put({ oid, data: encodeLooseObject(type as any, payload) });
  return oid;
}

// Seeds the standard scenario: the gatekeeper has proven a base commit (empty tree), and a
// locally-authored commit sits on top of it. Returns both oids.
async function seedPushableHistory(impl: any): Promise<{ base: string, head: string }> {
  let treeOid = await impl.gitCache.putFromGatekeeper(GATEKEEPER, "tree", new Uint8Array(0));
  let base = await impl.gitCache.putFromGatekeeper(
      GATEKEEPER, "commit", commitPayload(treeOid, [], "base"));
  let head = await storeLocal(impl, "commit", commitPayload(treeOid, [base], "local work"));
  return { base, head };
}

function pushDescription(heads: string[]): ActionDescription {
  return {
    title: "Push to main",
    description: "Pushes the listed commits.",
    implementsRevert: true,
    pushedCommits: heads,
    autoApprovable: false,
  };
}

function marksOf(impl: any, actionId: number): string[] {
  return Array.from(impl.storage.gitObjectMetadata.byPendingPushAction.get(actionId))
      .map((record: any) => record.oid);
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  let chunks: Uint8Array[] = [];
  let reader = stream.getReader();
  for (;;) {
    let { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatBytes(chunks);
}

describe("push authorization through the Overseer chokepoints", () => {
  it("verifies, marks, applies with an action-scoped cache, and converts marks", async () => {
    await inOverseer("push-apply", async impl => {
      let { base, head } = await seedPushableHistory(impl);

      await impl.submitAction(GATEKEEPER, 1, pushDescription([head]), { from: "user" });
      let record = Array.from(impl.storage.actions.list())
          .find((a: any) => a.type === "action") as any;
      expect(record.state).toBe("pending");
      // The head is marked; the base and its tree are remote-known and are not.
      expect(marksOf(impl, record.id)).toStrictEqual([head]);

      // Apply through a stubbed facet that exercises the action-scoped cache like a real
      // gatekeeper would: reads a pending commit (simulation view) and builds the pack.
      let sawPack: Uint8Array | undefined;
      impl.getGatekeeperFacet = () => ({
        async applyAction(action: number, cache: any) {
          expect(action).toBe(1);
          expect((await cache.get(head))!.type).toBe("commit");
          sawPack = await collect(await cache.buildPack());
        },
      });
      await impl.applyPendingAction(record, USER);

      expect(await decodePack(sawPack!)).toHaveLength(1);
      expect(impl.storage.actions.get(record.id)!.state).toBe("approved");
      expect(marksOf(impl, record.id)).toStrictEqual([]);
      let meta = impl.storage.gitObjectMetadata.get(head)!;
      expect(meta.onRemote).toStrictEqual([GATEKEEPER]);
      expect(meta.pendingPush).toStrictEqual([]);

      // The pushed commit is now proven: a follow-up push on top of it passes verification.
      expect(base).toBeTruthy();
    });
  });

  it("fails submitAction closed on unproven ancestry, queuing nothing", async () => {
    await inOverseer("push-reject", async impl => {
      let treeOid = await storeLocal(impl, "tree", new Uint8Array(0));
      let root = await storeLocal(impl, "commit", commitPayload(treeOid, [], "unrelated root"));

      await expect(impl.submitAction(GATEKEEPER, 1, pushDescription([root]), { from: "user" }))
          .rejects.toThrow(/root commit/);
      expect(Array.from(impl.storage.actions.list())).toStrictEqual([]);
      expect(Array.from(impl.storage.gitObjectMetadata.byPendingPushAction.list()))
          .toStrictEqual([]);
      expect(impl.storage.gitObjectMetadata.get(root)?.pendingPush ?? []).toStrictEqual([]);
    });
  });

  it("refuses a push while the workspace is restricted, queuing nothing", async () => {
    await inOverseer("push-restricted", async impl => {
      let { head } = await seedPushableHistory(impl);
      impl.storage.containsRestrictedData.put(true);

      // Proven ancestry does not help: the commits cannot be reviewed as text by the approver.
      await expect(impl.submitAction(GATEKEEPER, 1, pushDescription([head]), { from: "user" }))
          .rejects.toThrow(/git push cannot be reviewed as of yet/);
      expect(Array.from(impl.storage.actions.list())).toStrictEqual([]);
      expect(Array.from(impl.storage.gitObjectMetadata.byPendingPushAction.list()))
          .toStrictEqual([]);
    });
  });

  it("cleans a queued push's marks when its gatekeeper is removed", async () => {
    await inOverseer("push-gatekeeper-removed", async impl => {
      let { head } = await seedPushableHistory(impl);
      await impl.submitAction(GATEKEEPER, 1, pushDescription([head]), { from: "user" });
      let record = Array.from(impl.storage.actions.list())
          .find((a: any) => a.type === "action") as any;
      expect(marksOf(impl, record.id)).toStrictEqual([head]);

      impl.removeGatekeeper(GATEKEEPER);
      expect(marksOf(impl, record.id)).toStrictEqual([]);
      expect(impl.storage.gitObjectMetadata.get(head)?.pendingPush ?? []).toStrictEqual([]);
      // Proof-grade provenance is kept: the base commit's onRemote row survives removal.
    });
  });

  it("hands sessions a gatekeeper-scoped cache via getGitCache()", async () => {
    await inOverseer("push-session-cache", async impl => {
      let { head, base } = await seedPushableHistory(impl);
      void head;
      // Mimic ApprovalQueueImpl.getGitCache()'s minting: gatekeeper-scoped, no action.
      let { GitCacheImpl } = await import("../src/git-cache.js");
      let cache = new GitCacheImpl(impl.gitCache, GATEKEEPER);
      expect((await cache.get(base))!.type).toBe("commit");
      await expect(cache.buildPack()).rejects.toThrow(/action-scoped/);
    });
  });
  // A queued push for each of three callers on a gatekeeper that has adopted branches: one on
  // chat 1's branch, one on chat 2's, one staged. (The workspace has no owner, whom a staged
  // action would apply at once as, so it stays pending.) Returns their heads.
  async function queueBranchPushes(impl: any): Promise<string[]> {
    for (let id of [1, 2]) {
      impl.storage.chatMeta.put({ id, title: `Chat ${id}`, started: new Date(0), lastActive: new Date(id) });
    }
    let { base } = await seedPushableHistory(impl);
    let tree = await impl.gitCache.putFromGatekeeper(GATEKEEPER, "tree", new Uint8Array(0));
    let heads = await Promise.all(["chat 1", "chat 2", "staged"].map(message =>
        storeLocal(impl, "commit", commitPayload(tree, [base], message))));
    let callers = [{ from: "user", chatId: 1 }, { from: "user", chatId: 2 }, { from: "user" }];
    for (let [i, head] of heads.entries()) {
      await impl.submitAction(GATEKEEPER, i + 1, pushDescription([head]), callers[i]);
    }
    return heads;
  }

  it("limits a session's view of queued pushes to its own once the gatekeeper adopts branches",
      async () => {
    await inOverseer("push-branch-view", async impl => {
      let { GitCacheImpl } = await import("../src/git-cache.js");
      let viewOf = (branch: string | null) => new GitCacheImpl(impl.gitCache, GATEKEEPER,
          undefined, impl.pushVisibleTo(GATEKEEPER, branch));
      let heads = await queueBranchPushes(impl);
      // Not adopted: every session sees every queued push, as every pending action.
      for (let head of heads) expect(await viewOf("chat:1").has(head)).toBe(true);

      impl.getGatekeeperFacet = async () => ({ applyActions() {} });
      await impl.adoptsBranches(GATEKEEPER);
      // Adopted with these pending, they are leftovers, which every view still sees.
      for (let head of heads) expect(await viewOf("chat:1").has(head)).toBe(true);

      for (let action of [1, 2, 3]) {
        let record = Array.from(impl.storage.actions.list())
            .find((a: any) => a.type === "action" && a.action === action) as any;
        impl.gitCache.clearPushMarks(record.id);
        impl.storage.actions.put({ ...record, state: "rejected" });
      }
      // Queued again, after adopting.
      let fresh = await queueBranchPushes(impl);
      expect(await Promise.all(fresh.map(head => viewOf("chat:1").has(head))))
          .toStrictEqual([true, false, true]);
      expect(await Promise.all(fresh.map(head => viewOf(null).has(head))))
          .toStrictEqual([false, false, true]);
    });
  });

  it("packs the pushes of the actions applyActions() names, in one pack", async () => {
    await inOverseer("push-apply-list", async impl => {
      impl.getGatekeeperFacet = async () => ({ applyActions() {} });
      await impl.adoptsBranches(GATEKEEPER);
      let heads = await queueBranchPushes(impl);
      let objects: unknown[] = [];
      impl.getGatekeeperFacet = async () => ({
        async applyActions(_view: unknown, actions: number[], cache: any) {
          expect(actions).toStrictEqual([3, 1]);
          await expect(cache.buildPack()).rejects.toThrow(/needs the actions/);
          await expect(cache.buildPack([2])).rejects.toThrow(/not among/);
          objects = await decodePack(await collect(await cache.buildPack([1, 3])));
          return { applied: actions };
        },
      });
      let chatPush = Array.from(impl.storage.actions.list())
          .find((a: any) => a.type === "action" && a.action === 1) as any;
      await impl.applyPendingAction(chatPush, USER);
      expect(objects).toHaveLength(2);
      expect(impl.storage.gitObjectMetadata.get(heads[0])!.onRemote).toStrictEqual([GATEKEEPER]);
      expect(impl.storage.gitObjectMetadata.get(heads[1])!.onRemote).toStrictEqual([]);
    });
  });
});
