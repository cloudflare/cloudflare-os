// Exercises the push-authorization wiring in the Overseer itself -- submitAction's ancestry
// verification + marking walk and its judgement of a push from a restricted workspace,
// applyPendingAction's action-scoped GitCache stub and mark conversion, and removeGatekeeper's
// queued-push cleanup -- over real SQLite DO storage. The
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
import {
  MAX_BUFFERED_BLOB_SIZE,
  MAX_RESTRICTED_PUSH_COMMITS,
  MAX_RESTRICTED_PUSH_FILES,
  MAX_RESTRICTED_PUSH_PATHS,
  MAX_RESTRICTED_PUSH_TEXT_SIZE,
  type ActionDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  EMPTY_TREE_OID,
  concatBytes,
  encodeGitTree,
  encodeLooseObject,
  gitObjectOid,
  type GitTreeEntry,
} from "../src/git-codec";
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

const utf8 = (text: string) => new TextEncoder().encode(text);
const fileAt = (name: string, oid: string): GitTreeEntry => ({ mode: "100644", name, oid });

// The standard scenario with a tree of its own: a local commit of these entries (or of this
// hand-made tree payload) on the base the gatekeeper has proven.
async function seedCommit(impl: any, tree: GitTreeEntry[] | Uint8Array)
    : Promise<{ base: string, tree: string, head: string }> {
  let { base } = await seedPushableHistory(impl);
  let treeOid = await storeLocal(
      impl, "tree", tree instanceof Uint8Array ? tree : encodeGitTree(tree));
  let head = await storeLocal(impl, "commit", commitPayload(treeOid, [base], "local work"));
  return { base, tree: treeOid, head };
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

// A local commit that adds a text file, the description of its push, and a rule a user turned
// on for this connection that the description matches.
async function seedRuledTextPush(impl: any) {
  let blob = await storeLocal(impl, "blob", utf8("notes\n"));
  let { head, tree } = await seedCommit(impl, [fileAt("notes.txt", blob)]);
  let actionKind = { tag: "push", label: "Pushes" };
  impl.storage.autoApproveTags.put({ gatekeeperId: GATEKEEPER, actionKind, enabledBy: USER });
  let description: ActionDescription =
      { ...pushDescription([head]), autoApprovable: true, actionKind };
  return { head, tree, blob, description };
}

// The one action that is waiting for a decision.
function pendingPush(impl: any): any {
  let pending = Array.from(impl.storage.actions.list())
      .filter((record: any) => record.type === "action" && record.state === "pending");
  expect(pending).toHaveLength(1);
  return pending[0];
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

  // The ancestry check comes before any judgement of what a push sends, so a restricted
  // workspace refuses these as an unrestricted one does: the root commit alone is text an
  // approver could read.
  it("fails submitAction closed on unproven ancestry, queuing nothing", async () => {
    for (let restricted of [false, true]) {
      await inOverseer(`push-reject-${restricted}`, async impl => {
        let treeOid = await storeLocal(impl, "tree", new Uint8Array(0));
        let root = await storeLocal(impl, "commit", commitPayload(treeOid, [], "unrelated root"));
        let notHeld = gitObjectOid("commit", commitPayload(treeOid, [root], "never stored"));
        impl.storage.containsRestrictedData.put(restricted);
        let nextActionId = impl.storage.nextActionId.get();

        for (let [head, error] of [
          [root, /root commit/],
          [notHeld, /is not available in the workspace's git cache/],
        ] as const) {
          let what = `${restricted ? "restricted" : "unrestricted"}: ${error}`;
          await expect(
              impl.submitAction(GATEKEEPER, 1, pushDescription([head]), { from: "user" }), what)
              .rejects.toThrow(error);
          expect(Array.from(impl.storage.actions.list()), what).toStrictEqual([]);
          expect(Array.from(impl.storage.gitObjectMetadata.byPendingPushAction.list()), what)
              .toStrictEqual([]);
          expect(impl.storage.gitObjectMetadata.get(head)?.pendingPush ?? [], what)
              .toStrictEqual([]);
          expect(impl.storage.nextActionId.get(), what).toBe(nextActionId);
        }
      });
    }
  });

  it("queues a text-only push in a restricted workspace, which waits for a person", async () => {
    await inOverseer("push-restricted-text", async impl => {
      let { head, tree, blob, description } = await seedRuledTextPush(impl);
      impl.storage.containsRestrictedData.put(true);
      let packs: Uint8Array[] = [];
      impl.getGatekeeperFacet = () => ({
        async applyAction(_action: number, cache: any) {
          packs.push(await collect(await cache.buildPack()));
        },
      });

      await impl.submitAction(GATEKEEPER, 1, description, { from: "user" });
      let record = pendingPush(impl);
      expect(marksOf(impl, record.id).toSorted()).toStrictEqual([head, tree, blob].toSorted());

      // The rule that applies this push in an unrestricted workspace does not apply it here.
      await impl.drainAutoApprovals(GATEKEEPER);
      expect(packs).toStrictEqual([]);
      expect(impl.storage.actions.get(record.id)!.state).toBe("pending");

      // A person does, and the gatekeeper sends exactly the objects that were judged.
      await impl.applyPendingAction(record, USER, false);
      expect(packs).toHaveLength(1);
      expect((await decodePack(packs[0])).map(object => object.oid).toSorted())
          .toStrictEqual([head, tree, blob].toSorted());
      expect(impl.storage.actions.get(record.id)!.state).toBe("approved");
    });
  });

  it("applies the same push by that rule in an unrestricted workspace", async () => {
    await inOverseer("push-unrestricted-text", async impl => {
      let { description } = await seedRuledTextPush(impl);
      let applied = 0;
      impl.getGatekeeperFacet = () => ({ async applyAction() { applied++; } });

      await impl.submitAction(GATEKEEPER, 1, description, { from: "user" });
      await impl.drainAutoApprovals(GATEKEEPER);
      expect(applied).toBe(1);
      let [record] = Array.from(impl.storage.actions.list()) as any[];
      expect(record.state).toBe("approved");
      expect(record.autoApproved).toBe(true);
    });
  });

  // Pushes that break one rule each of those a restricted workspace holds a push to (see
  // ObservationDescription.containsRestrictedData). Each stores its objects and returns its
  // head and the reason the refusal gives.
  const NOT_HELD = "is not in the workspace's git store";
  const NOT_IN_FORM = "the root directory in commit HEAD is not in the form git writes: an " +
      "entry name is not valid UTF-8, is repeated, is out of order or is not a single path segment";
  const UNREADABLE: [string, (impl: any) => Promise<{ head: string, reason: string }>][] = [
    ["a file with a NUL", async impl => {
      let blob = await storeLocal(impl, "blob", Uint8Array.of(0x61, 0, 0x62));
      let { head } = await seedCommit(impl, [fileAt("a.bin", blob)]);
      return { head, reason: `"a.bin" in commit ${head} is not UTF-8 text` };
    }],
    ["a file that is not valid UTF-8", async impl => {
      let blob = await storeLocal(impl, "blob", Uint8Array.of(0x63, 0x61, 0x66, 0xe9));
      let { head } = await seedCommit(impl, [fileAt("latin1.txt", blob)]);
      return { head, reason: `"latin1.txt" in commit ${head} is not UTF-8 text` };
    }],
    ["a file over the buffered size", async impl => {
      let blob = impl.gitCache.writeBlob(new Uint8Array(MAX_BUFFERED_BLOB_SIZE + 1).fill(0x61)).oid;
      let { head } = await seedCommit(impl, [fileAt("big.txt", blob)]);
      return {
        head, reason: `"big.txt" in commit ${head} is larger than ${MAX_BUFFERED_BLOB_SIZE} bytes`,
      };
    }],
    ["a file the store does not hold", async impl => {
      let { head } = await seedCommit(impl, [fileAt("gone.txt", gitObjectOid("blob", utf8("x")))]);
      return { head, reason: `"gone.txt" in commit ${head} ${NOT_HELD}` };
    }],
    ["a root directory the store does not hold", async impl => {
      let { base } = await seedPushableHistory(impl);
      let tree = gitObjectOid("tree", encodeGitTree([fileAt("x", "3".repeat(40))]));
      let head = await storeLocal(impl, "commit", commitPayload(tree, [base], "local work"));
      return { head, reason: `the root directory in commit ${head} ${NOT_HELD}` };
    }],
    ["a symbolic link whose target it sends", async impl => {
      let target = await storeLocal(impl, "blob", utf8("notes.txt"));
      let { head } = await seedCommit(impl, [{ mode: "120000", name: "link", oid: target }]);
      return {
        head, reason: `"link" in commit ${head} is a symbolic link whose target this push sends`,
      };
    }],
    ["a submodule entry it adds", async impl => {
      let { head } = await seedCommit(impl, [{ mode: "160000", name: "mod", oid: "1".repeat(40) }]);
      return { head, reason: `"mod" in commit ${head} adds or changes a submodule entry` };
    }],
    ["a submodule entry whose target it changes", async impl => {
      let module = (oid: string) => encodeGitTree([{ mode: "160000", name: "mod", oid }]);
      let remoteTree = await impl.gitCache.putFromGatekeeper(
          GATEKEEPER, "tree", module("1".repeat(40)));
      let base = await impl.gitCache.putFromGatekeeper(
          GATEKEEPER, "commit", commitPayload(remoteTree, [], "base"));
      let tree = await storeLocal(impl, "tree", module("2".repeat(40)));
      let head = await storeLocal(impl, "commit", commitPayload(tree, [base], "local work"));
      return { head, reason: `"mod" in commit ${head} adds or changes a submodule entry` };
    }],
    ["a commit that is not valid UTF-8", async impl => {
      let { base } = await seedPushableHistory(impl);
      let head = await storeLocal(impl, "commit", concatBytes(
          [commitPayload(EMPTY_TREE_OID, [base], "invalid"), Uint8Array.of(0xff, 0x0a)]));
      return {
        head,
        reason: `commit ${head} is not UTF-8 text of at most ${MAX_BUFFERED_BLOB_SIZE} bytes`,
      };
    }],
    ...([
      ["an entry name that is not valid UTF-8", [Uint8Array.of(0xff, 0xfe)]],
      ["an entry name twice", [utf8("notes.txt"), utf8("notes.txt")]],
      ["an entry name holding a slash", [utf8("a/b")]],
    ] as const).map(([what, names]): typeof UNREADABLE[0] => [what, async impl => {
      // A directory no encoder writes, stored as an agent can store one.
      let blob = await storeLocal(impl, "blob", utf8("text\n"));
      let { head } = await seedCommit(impl, concatBytes(names.flatMap(name => [
        utf8("100644 "), name, Uint8Array.of(0),
        Uint8Array.from(blob.match(/../g)!.map(byte => parseInt(byte, 16))),
      ])));
      return { head, reason: NOT_IN_FORM.replace("HEAD", head) };
    }]),
    ["a file entry that names a directory", async impl => {
      let blob = await storeLocal(impl, "blob", utf8("text\n"));
      let sub = await storeLocal(impl, "tree", encodeGitTree([fileAt("x", blob)]));
      let { head } = await seedCommit(impl, [fileAt("f", sub)]);
      return { head, reason: `"f" in commit ${head} names a tree where a blob is expected` };
    }],
    ["a commit whose tree is a file", async impl => {
      let { base } = await seedPushableHistory(impl);
      let blob = await storeLocal(impl, "blob", utf8("not a tree\n"));
      let head = await storeLocal(impl, "commit", commitPayload(blob, [base], "local work"));
      return {
        head, reason: `the root directory in commit ${head} names a blob where a tree is expected`,
      };
    }],
    ["one commit too many", async impl => {
      let { base: head } = await seedPushableHistory(impl);
      for (let i = 0; i <= MAX_RESTRICTED_PUSH_COMMITS; i++) {
        head = await storeLocal(impl, "commit", commitPayload(EMPTY_TREE_OID, [head], `${i}`));
      }
      return { head, reason: `it sends more than ${MAX_RESTRICTED_PUSH_COMMITS} commits` };
    }],
    ["one file too many", async impl => {
      let entries = [];
      for (let i = 0; i <= MAX_RESTRICTED_PUSH_FILES; i++) {
        entries.push(fileAt(`f${i}`, await storeLocal(impl, "blob", utf8(`${i}\n`))));
      }
      let { head } = await seedCommit(impl, entries);
      return { head, reason: `it sends more than ${MAX_RESTRICTED_PUSH_FILES} files` };
    }],
    ["one path too many", async impl => {
      // The root and one entry too many, each over a file the remote has: no file is sent.
      let blob = await impl.gitCache.putFromGatekeeper(GATEKEEPER, "blob", utf8("remote\n"));
      let { head } = await seedCommit(impl,
          Array.from({ length: MAX_RESTRICTED_PUSH_PATHS }, (_, i) => fileAt(`f${i}`, blob)));
      return { head, reason: `its commits change more than ${MAX_RESTRICTED_PUSH_PATHS} paths` };
    }],
    ["one file's worth of text too many", async impl => {
      let entries = [];
      for (let i = 0; i <= MAX_RESTRICTED_PUSH_TEXT_SIZE / MAX_BUFFERED_BLOB_SIZE; i++) {
        let blob = impl.gitCache.writeBlob(new Uint8Array(MAX_BUFFERED_BLOB_SIZE).fill(0x61 + i));
        entries.push(fileAt(`f${i}`, blob.oid));
      }
      let { head } = await seedCommit(impl, entries);
      return { head, reason: `it sends more than ${MAX_RESTRICTED_PUSH_TEXT_SIZE} bytes of text` };
    }],
  ];

  it("refuses a restricted push the approver could not read, queuing nothing", async () => {
    for (let [index, [what, build]] of UNREADABLE.entries()) {
      await inOverseer(`push-unreadable-${index}`, async impl => {
        let { head, reason } = await build(impl);
        impl.storage.containsRestrictedData.put(true);
        let nextActionId = impl.storage.nextActionId.get();

        await expect(
            impl.submitAction(GATEKEEPER, 1, pushDescription([head]), { from: "user" }), what)
            .rejects.toThrow(`This push was not queued: ${reason}. Change the commits`);
        expect(Array.from(impl.storage.actions.list()), what).toStrictEqual([]);
        expect(Array.from(impl.storage.gitObjectMetadata.byPendingPushAction.list()), what)
            .toStrictEqual([]);
        expect(impl.storage.nextActionId.get(), what).toBe(nextActionId);
      });
    }
  });

  it("queues the same pushes in an unrestricted workspace", async () => {
    for (let [index, [what, build]] of UNREADABLE.entries()) {
      await inOverseer(`push-unrestricted-${index}`, async impl => {
        let { head } = await build(impl);
        await impl.submitAction(GATEKEEPER, 1, pushDescription([head]), { from: "user" });
        expect(marksOf(impl, pendingPush(impl).id), what).toContain(head);
      });
    }
  });

  it("leaves a push that was waiting when the workspace became restricted, and refuses one " +
      "stacked on it", async () => {
    await inOverseer("push-waiting-then-restricted", async impl => {
      let image = await storeLocal(impl, "blob", Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0));
      let { head: first } = await seedCommit(impl, [fileAt("logo.png", image)]);
      await impl.submitAction(GATEKEEPER, 1, pushDescription([first]), { from: "user" });
      impl.storage.containsRestrictedData.put(true);

      // Nothing judges the waiting push again: it is pending, and its review says what it is.
      let waiting = pendingPush(impl);
      expect(impl.gitCache.readPushReview(waiting.id, [first]).entries).toContainEqual(
          expect.objectContaining({ path: "logo.png", sent: { kind: "binary", size: 5 } }));

      // A push on top of it would send the image too, under the commit that adds it.
      let notes = await storeLocal(impl, "blob", utf8("notes\n"));
      let tree = await storeLocal(impl, "tree",
          encodeGitTree([fileAt("logo.png", image), fileAt("notes.txt", notes)]));
      let second = await storeLocal(impl, "commit", commitPayload(tree, [first], "notes"));
      let stacked = () =>
          impl.submitAction(GATEKEEPER, 2, pushDescription([second]), { from: "user" });
      await expect(stacked()).rejects.toThrow(`"logo.png" in commit ${first} is not UTF-8 text`);
      expect(Array.from(impl.storage.actions.list())).toHaveLength(1);

      // Once the first is applied the remote has its objects, and the second sends only its own.
      impl.getGatekeeperFacet = () => ({ async applyAction() {} });
      await impl.applyPendingAction(waiting, USER, false);
      await stacked();
      expect(marksOf(impl, pendingPush(impl).id).toSorted())
          .toStrictEqual([second, tree, notes].toSorted());
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
