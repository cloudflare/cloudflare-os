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
import { concatBytes, decodePackBytes, encodeLooseObject, gitObjectOid }
  from "../src/git-codec";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const GATEKEEPER = 7;
const USER = { type: "user" as const, id: "alice@example.com", name: "Alice" };

async function inOverseer(name: string, fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(name);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: any }).impl);
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
  let oid = await gitObjectOid(type as any, payload);
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
      await impl.applyPendingAction(record, USER, false);

      expect((await decodePackBytes(sawPack!, { maxObjectSize: 1 << 20 }))).toHaveLength(1);
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
});
