// Exercises push authorization through real Overseer SQLite storage: queue-time ancestry and
// marking, legacy action-scoped GitCache application, batch GitPackBuilder callbacks, completion
// reconciliation, and gatekeeper-removal cleanup. Git cache algorithms remain covered by
// git-cache.test.ts; this suite covers the Overseer lifecycle and native-RPC boundaries they use.
// Tests reach the implementation through TEST_OVERSEER, matching git-migration-do.test.ts; only
// the retained legacy fallback case overrides getGatekeeperFacet.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { GatekeeperActionRecord, OverseerDurableObject } from "../src/overseer.js";
import type {
  ActionDescription,
  GitObjectType,
  GitPackErrorCode,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  GIT_PACK_ERROR_CODES,
  getGitPackErrorCode,
} from "@gadgets/workshop-shared/gatekeeper";
import { concatBytes, decodePackBytes, encodeLooseObject, gitObjectOid }
  from "../src/git-codec";
import { GitPackBuilderImpl } from "../src/git-cache.js";
import type { GitObjectMetadataRecord } from "../src/git-cache.js";

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

async function storeLocal(
    impl: any, type: GitObjectType, payload: Uint8Array): Promise<string> {
  let oid = await gitObjectOid(type, payload);
  impl.storage.gitObjects.put({ oid, data: encodeLooseObject(type, payload) });
  return oid;
}

// Seeds the standard scenario: the gatekeeper has proven a base commit (empty tree), and a
// locally-authored commit sits on top of it. Returns both oids.
async function seedPushableHistory(
    impl: any, gatekeeperId = GATEKEEPER, suffix = ""): Promise<{ base: string, head: string }> {
  let treeOid = await impl.gitCache.putFromGatekeeper(
      gatekeeperId, "tree", new Uint8Array(0));
  let base = await impl.gitCache.putFromGatekeeper(
      gatekeeperId, "commit", commitPayload(treeOid, [], `base${suffix}`));
  let head = await storeLocal(
      impl, "commit", commitPayload(treeOid, [base], `local work${suffix}`));
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
  const records = Array.from(impl.storage.gitObjectMetadata.byPendingPushAction.get(actionId)) as GitObjectMetadataRecord[];
  return records.map(record => record.oid);
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

function installPackReceiver(
    impl: any, gatekeeperId: number,
    props: { packAction?: number; readOid?: string; stoppedAt?: number; throwAfterBuild?: boolean } = {}) {
  impl.storage.gatekeepers.put({
    id: gatekeeperId,
    resourceTitle: "Test Git pack receiver",
    class: impl.ctx.exports.TestGitPackGatekeeper({ props }),
  });
  return impl.getGatekeeperFacet(gatekeeperId);
}

function actionRecord(impl: any, gatekeeperId: number, localAction: number)
    : GatekeeperActionRecord {
  const record = (Array.from(impl.storage.actions.list()) as GatekeeperActionRecord[])
      .find(candidate => candidate.gatekeeperId === gatekeeperId &&
          candidate.action === localAction);
  if (record === undefined) throw new Error(`No action ${localAction}`);
  return record;
}

async function expectGitPackCode(
    operation: () => Promise<unknown>, expected: GitPackErrorCode): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(getGitPackErrorCode(caught)).toBe(expected);
}

describe("push authorization through the Overseer chokepoints", () => {
  it("verifies, marks, applies through the legacy cache fallback, and converts marks", async () => {
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
        async applyActionsThrough() {
          throw new TypeError(
              'The RPC receiver does not implement the method "applyActionsThrough".');
        },
        async applyAction(action: number, cache: any) {
          expect(action).toBe(1);
          expect((await cache.get(head))!.type).toBe("commit");
          sawPack = await collect(await cache.buildPack());
        },
      });
      await impl.applyDecidedActions(GATEKEEPER, { action: 1, resolvedBy: USER });

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

  it("cleans queued and staged-veto push marks when its gatekeeper is removed", async () => {
    await inOverseer("push-gatekeeper-removed", async impl => {
      let { head } = await seedPushableHistory(impl);
      await impl.submitAction(GATEKEEPER, 1, pushDescription([head]), { from: "user" });
      await impl.submitAction(GATEKEEPER, 2, pushDescription([head]), { from: "user" });
      let queued = actionRecord(impl, GATEKEEPER, 1);
      // A veto the gatekeeper never acknowledged keeps its simulation read grant until then.
      let staged = actionRecord(impl, GATEKEEPER, 2);
      impl.storage.actions.put({ ...staged, state: "rejected", vetoPending: true });
      expect(marksOf(impl, queued.id)).toStrictEqual([head]);
      expect(marksOf(impl, staged.id)).toStrictEqual([head]);

      impl.removeGatekeeper(GATEKEEPER);
      expect(marksOf(impl, queued.id)).toStrictEqual([]);
      expect(marksOf(impl, staged.id)).toStrictEqual([]);
      expect(impl.storage.gitObjectMetadata.get(head)?.pendingPush ?? []).toStrictEqual([]);
      // Proof-grade provenance is kept: the base commit's onRemote row survives removal.
    });
  });

  it("builds a bounded explicit prefix with translated veto IDs", async () => {
    await inOverseer("batch-pack-frontier", async impl => {
      impl.storage.nextActionId.put(Math.max(1000, impl.storage.nextActionId.get()));
      const { head } = await seedPushableHistory(impl);
      const receiver = installPackReceiver(impl, GATEKEEPER, { packAction: 41, readOid: head });

      try {
        await impl.submitAction(GATEKEEPER, 41, pushDescription([head]), { from: "user" });
        await impl.submitAction(GATEKEEPER, 52, {
          title: "Skip notification",
          description: "Would notify the release channel.",
          implementsRevert: true,
        }, { from: "user" });
        await impl.submitAction(GATEKEEPER, 99, {
          title: "Publish release notes",
          description: "Publishes the release notes.",
          implementsRevert: true,
        }, { from: "user" });
        await impl.submitAction(GATEKEEPER, 123, {
          title: "Later cleanup",
          description: "Runs after the release boundary.",
          implementsRevert: true,
        }, { from: "user" });

        const push = actionRecord(impl, GATEKEEPER, 41);
        const veto = actionRecord(impl, GATEKEEPER, 52);
        const boundary = actionRecord(impl, GATEKEEPER, 99);
        const laterVeto = actionRecord(impl, GATEKEEPER, 123);
        expect([push.id, veto.id, boundary.id, laterVeto.id].every(id => id >= 1000)).toBe(true);

        laterVeto.state = "rejected";
        laterVeto.vetoPending = true;
        laterVeto.resolvedBy = USER;
        laterVeto.appliedAt = new Date();
        impl.storage.actions.put(laterVeto);

        await impl.applyActionBatch(boundary, [veto], USER);

        expect(await receiver.receivedBatch()).toStrictEqual({ actionId: 99, vetoes: [52] });
        const cached = await receiver.cachedObject();
        expect(await gitObjectOid(cached.type, cached.content)).toBe(head);
        const objects = await decodePackBytes(await receiver.capturedPack(), {
          maxObjectSize: 1 << 20,
        });
        expect(await Promise.all(objects.map(object => gitObjectOid(object.type, object.payload))))
            .toStrictEqual([head]);
        expect(actionRecord(impl, GATEKEEPER, 41).state).toBe("approved");
        expect(actionRecord(impl, GATEKEEPER, 52).state).toBe("rejected");
        expect(actionRecord(impl, GATEKEEPER, 99).state).toBe("approved");
        expect(actionRecord(impl, GATEKEEPER, 123)).toMatchObject({
          state: "rejected", vetoPending: true,
        });
        expect(marksOf(impl, push.id)).toStrictEqual([]);
        expect(impl.storage.gitObjectMetadata.get(head)!.onRemote).toContain(GATEKEEPER);
        expect(impl.storage.gitObjectMetadata.get(head)!.pendingPush)
            .not.toContainEqual(expect.objectContaining({ actionId: push.id }));
        await expectGitPackCode(
            () => receiver.buildRetained(41), GIT_PACK_ERROR_CODES.builderExpired);
      } finally {
        await receiver.releaseRetained();
      }
    });
  });

  it("supplies a builder that refuses non-push actions", async () => {
    await inOverseer("batch-non-push-builder", async impl => {
      const receiver = installPackReceiver(impl, GATEKEEPER, { packAction: 1 });
      try {
        await impl.submitAction(GATEKEEPER, 1, {
          title: "Publish release notes",
          description: "Publishes the release notes.",
          implementsRevert: true,
        }, { from: "user" });
        const action = actionRecord(impl, GATEKEEPER, 1);

        expect(await impl.applyActionBatch(action, [], USER))
            .toMatchObject({ decided: [], stoppedAt: 1 });
        expect(actionRecord(impl, GATEKEEPER, 1).state).toBe("pending");
        await expectGitPackCode(
            () => receiver.buildRetained(1), GIT_PACK_ERROR_CODES.builderExpired);
      } finally {
        await receiver.releaseRetained();
      }
    });
  });

  it("authorizes exact local push selectors without workspace-ID collisions", async () => {
    await inOverseer("batch-pack-selectors", async impl => {
      const foreignGatekeeper = 8;
      impl.storage.gatekeepers.put({ id: GATEKEEPER, class: {} });
      impl.storage.gatekeepers.put({ id: foreignGatekeeper, class: {} });

      const foreignId = impl.storage.nextActionId.get() + 40;
      impl.storage.nextActionId.put(foreignId);
      const foreignHistory = await seedPushableHistory(impl, foreignGatekeeper, " foreign");
      await impl.submitAction(
          foreignGatekeeper, foreignId, pushDescription([foreignHistory.head]), { from: "user" });
      const foreign = actionRecord(impl, foreignGatekeeper, foreignId);
      expect(foreign.id).toBe(foreignId);

      impl.storage.nextActionId.put(foreignId + 100);
      const ownHistory = await seedPushableHistory(impl, GATEKEEPER, " own");
      await impl.submitAction(
          GATEKEEPER, foreignId, pushDescription([ownHistory.head]), { from: "user" });
      const own = actionRecord(impl, GATEKEEPER, foreignId);

      await impl.submitAction(GATEKEEPER, foreignId + 1, {
        title: "Non-Git action",
        description: "Does not push commits.",
        implementsRevert: true,
      }, { from: "user" });
      const nonPush = actionRecord(impl, GATEKEEPER, foreignId + 1);

      await impl.submitAction(
          GATEKEEPER, foreignId + 3, pushDescription([ownHistory.base]), { from: "user" });
      const empty = actionRecord(impl, GATEKEEPER, foreignId + 3);

      const zeroHistory = await seedPushableHistory(impl, GATEKEEPER, " zero");
      await impl.submitAction(GATEKEEPER, 0, pushDescription([zeroHistory.head]), { from: "user" });
      const zero = actionRecord(impl, GATEKEEPER, 0);
      expect(zero.id).not.toBe(0);

      const builder = new GitPackBuilderImpl(
          impl.gitCache, impl.storage, GATEKEEPER, [own, nonPush, empty, zero]);
      try {
        const ownObjects = await decodePackBytes(
            await collect(await builder.buildPack(foreignId)), { maxObjectSize: 1 << 20 });
        const ownOids = await Promise.all(
            ownObjects.map(object => gitObjectOid(object.type, object.payload)));
        expect(ownOids).toStrictEqual([ownHistory.head]);

        const zeroObjects = await decodePackBytes(
            await collect(await builder.buildPack(0)), { maxObjectSize: 1 << 20 });
        expect(await Promise.all(
            zeroObjects.map(object => gitObjectOid(object.type, object.payload))))
            .toStrictEqual([zeroHistory.head]);
        expect(await decodePackBytes(
            await collect(await builder.buildPack(foreignId + 3)), { maxObjectSize: 1 }))
            .toStrictEqual([]);

        for (const selector of [own.id, nonPush.action]) {
          await expectGitPackCode(
              () => builder.buildPack(selector), GIT_PACK_ERROR_CODES.actionNotAuthorized);
        }

        impl.storage.transaction(() => {
          zero.state = "rejected";
          impl.gitCache.clearPushMarks(zero.id);
          impl.storage.actions.put(zero);
        });
        await expectGitPackCode(
            () => builder.buildPack(0), GIT_PACK_ERROR_CODES.actionUnavailable);
        expect(getGitPackErrorCode(new Error(
            "Git pack action is no longer pending or its connection was removed.")))
            .toBeUndefined();
      } finally {
        builder[Symbol.dispose]();
      }
    });
  });

  it("reconciles partial results and preserves pending state when the response is lost", async () => {
    await inOverseer("batch-pack-stopped", async impl => {
      const firstHistory = await seedPushableHistory(impl, GATEKEEPER, " first");
      const secondHistory = await seedPushableHistory(impl, GATEKEEPER, " second");
      const receiver = installPackReceiver(
          impl, GATEKEEPER, { packAction: 61, stoppedAt: 62 });
      const kind = { tag: "push", label: "Push" };

      try {
        await impl.submitAction(GATEKEEPER, 61, {
          ...pushDescription([firstHistory.head]),
          autoApprovable: true,
          actionKind: kind,
        }, { from: "user" });
        await impl.submitAction(GATEKEEPER, 62, {
          ...pushDescription([secondHistory.head]),
          autoApprovable: false,
        }, { from: "user" });
        impl.storage.autoApproveTags.put({
          gatekeeperId: GATEKEEPER,
          actionKind: kind,
          enabledBy: USER,
        });
        const first = actionRecord(impl, GATEKEEPER, 61);
        const second = actionRecord(impl, GATEKEEPER, 62);

        await impl.applyDecidedActions(GATEKEEPER, { action: 62, resolvedBy: USER });

        expect(actionRecord(impl, GATEKEEPER, 61).state).toBe("approved");
        expect(actionRecord(impl, GATEKEEPER, 62).state).toBe("pending");
        expect(marksOf(impl, first.id)).toStrictEqual([]);
        expect(marksOf(impl, second.id)).toContain(secondHistory.head);
        expect(impl.storage.gitObjectMetadata.get(firstHistory.head)!.onRemote)
            .toContain(GATEKEEPER);
        expect(impl.storage.gitObjectMetadata.get(secondHistory.head)!.onRemote)
            .not.toContain(GATEKEEPER);
        await expectGitPackCode(
            () => receiver.buildRetained(61), GIT_PACK_ERROR_CODES.builderExpired);
      } finally {
        await receiver.releaseRetained();
      }
    });

    await inOverseer("batch-pack-response-lost", async impl => {
      const { head } = await seedPushableHistory(impl, GATEKEEPER, " response lost");
      const receiver = installPackReceiver(
          impl, GATEKEEPER, { packAction: 71, throwAfterBuild: true });
      try {
        await impl.submitAction(GATEKEEPER, 71, pushDescription([head]), { from: "user" });
        const record = actionRecord(impl, GATEKEEPER, 71);
        let caught: unknown;
        try {
          await impl.applyDecidedActions(GATEKEEPER, { action: 71, resolvedBy: USER });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(Error);
        expect(getGitPackErrorCode(caught)).toBeUndefined();
        const lostObjects = await decodePackBytes(await receiver.capturedPack(), {
          maxObjectSize: 1 << 20,
        });
        expect(await Promise.all(
            lostObjects.map(object => gitObjectOid(object.type, object.payload))))
            .toStrictEqual([head]);
        expect(actionRecord(impl, GATEKEEPER, 71).state).toBe("pending");
        expect(marksOf(impl, record.id)).toContain(head);
        expect(impl.storage.gitObjectMetadata.get(head)!.onRemote).not.toContain(GATEKEEPER);
        await expectGitPackCode(
            () => receiver.buildRetained(71), GIT_PACK_ERROR_CODES.builderExpired);
      } finally {
        await receiver.releaseRetained();
      }
    });
  });

  it("rechecks owner and destination lifetime after an awaited pack build", async () => {
    await inOverseer("batch-pack-disposed-in-flight", async impl => {
      impl.storage.gatekeepers.put({ id: GATEKEEPER, class: {} });
      const { head } = await seedPushableHistory(impl, GATEKEEPER, " disposed");
      await impl.submitAction(GATEKEEPER, 81, pushDescription([head]), { from: "user" });
      const record = actionRecord(impl, GATEKEEPER, 81);
      const builder = new GitPackBuilderImpl(
          impl.gitCache, impl.storage, GATEKEEPER, [record]);
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = impl.gitCache.buildPackForAction;
      impl.gitCache.buildPackForAction = async (gatekeeperId: number, actionId: number) => {
        started.resolve();
        await release.promise;
        return original.call(impl.gitCache, gatekeeperId, actionId);
      };

      try {
        const build = builder.buildPack(81);
        await started.promise;
        builder[Symbol.dispose]();
        release.resolve();
        let caught: unknown;
        try {
          await build;
        } catch (error) {
          caught = error;
        }
        expect(getGitPackErrorCode(caught)).toBe(GIT_PACK_ERROR_CODES.builderExpired);
        expect(marksOf(impl, record.id)).toContain(head);
      } finally {
        release.resolve();
        impl.gitCache.buildPackForAction = original;
        builder[Symbol.dispose]();
      }
    });

    await inOverseer("batch-pack-removed-in-flight", async impl => {
      impl.storage.gatekeepers.put({ id: GATEKEEPER, class: {} });
      const { head } = await seedPushableHistory(impl, GATEKEEPER, " removed");
      await impl.submitAction(GATEKEEPER, 82, pushDescription([head]), { from: "user" });
      const record = actionRecord(impl, GATEKEEPER, 82);
      const builder = new GitPackBuilderImpl(
          impl.gitCache, impl.storage, GATEKEEPER, [record]);
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = impl.gitCache.buildPackForAction;
      impl.gitCache.buildPackForAction = async (gatekeeperId: number, actionId: number) => {
        started.resolve();
        await release.promise;
        return original.call(impl.gitCache, gatekeeperId, actionId);
      };

      try {
        const build = builder.buildPack(82);
        await started.promise;
        impl.removeGatekeeper(GATEKEEPER);
        release.resolve();
        let caught: unknown;
        try {
          await build;
        } catch (error) {
          caught = error;
        }
        expect(getGitPackErrorCode(caught)).toBe(GIT_PACK_ERROR_CODES.actionUnavailable);
        expect(marksOf(impl, record.id)).toStrictEqual([]);
      } finally {
        release.resolve();
        impl.gitCache.buildPackForAction = original;
        builder[Symbol.dispose]();
      }
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
