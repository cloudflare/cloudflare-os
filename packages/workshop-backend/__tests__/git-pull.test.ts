// Exercise the pull delegate installed by the real Overseer, including its cache ingestion.
// Calling the delegate directly keeps cache retries from hiding a rejected transfer after some
// requested objects have already arrived. Only the provider facet is replaced, as in git-push-actions.

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { GitPullHints, GitPullStatus, GitPullTransfer } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { WorkspaceGitCache } from "../src/git-cache";
import {
  buildPackBytes,
  buildPackStream,
  concatBytes,
  decodePackStream,
  gitObjectHasher,
  gitObjectOid,
} from "../src/git-codec";
import { COMMIT_1, PACK_OFS_DELTA, b64Bytes, byteStream } from "./git-cache-fixtures";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    }
  }
}

const GATEKEEPER = 7;
const MISSING_OID = "f".repeat(40);
const OPTIONS: GitPullHints = {type: "commit", commitHistory: {kind: "depth", depth: 1}};

function fakeTransfer(pack: ReadableStream<Uint8Array>, status: GitPullStatus | Error) {
  return {
    stream: vi.fn<GitPullTransfer["stream"]>(async () => pack),
    status: vi.fn<GitPullTransfer["status"]>(async () => {
      if (status instanceof Error) throw status;
      return status;
    }),
    [Symbol.dispose]: vi.fn(),
  };
}

async function inOverseer(
    name: string, transfer: ReturnType<typeof fakeTransfer>,
    test: (cache: WorkspaceGitCache, pull: (oids: string[], options: GitPullHints) => Promise<void>,
           gitPull: ReturnType<typeof vi.fn>) => Promise<void>): Promise<void> {
  const stub = env.TEST_OVERSEER.getByName(`git-pull-${name}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // Same private-impl access as the other overseer chokepoint tests; no production test hooks.
    const impl = (instance as unknown as {impl: any}).impl;
    impl.storage.gatekeepers.put({id: GATEKEEPER, resourceTitle: "Remote repository", class: {} as any});
    const gitPull = vi.fn(async () => transfer);
    impl.getGatekeeperFacet = vi.fn(async () => ({gitPull}));
    const cache: WorkspaceGitCache = impl.gitCache;
    await test(cache, (oids, options) => cache["puller"].pull(GATEKEEPER, oids, options), gitPull);
    expect(transfer[Symbol.dispose]).toHaveBeenCalledOnce();
  });
}

async function emptyPack(): Promise<ReadableStream<Uint8Array>> {
  return byteStream(concatBytes(await buildPackBytes([])));
}

describe("Git pull consumption through the Overseer delegate", () => {
  it("ingests the raw pack, records its source, and accepts a completed transfer", async () => {
    const transfer = fakeTransfer(byteStream(b64Bytes(PACK_OFS_DELTA)), {state: "complete"});
    await inOverseer("complete", transfer, async (cache, pull, gitPull) => {
      await pull([COMMIT_1], OPTIONS);
      expect(gitPull).toHaveBeenCalledExactlyOnceWith([COMMIT_1], OPTIONS);
      expect(transfer.stream).toHaveBeenCalledOnce();
      expect(transfer.status).toHaveBeenCalledOnce();
      expect(cache.hasLocalObject(COMMIT_1)).toBe(true);
      expect(cache.readLocalObject(COMMIT_1)?.type).toBe("commit");
      expect((await cache.readForGatekeeper(GATEKEEPER, COMMIT_1))?.type).toBe("commit");
      expect(await cache.readForGatekeeper(GATEKEEPER + 1, COMMIT_1)).toBeNull();
    });
  });

  it("rejects a batch when a completed pack omits one requested object", async () => {
    const transfer = fakeTransfer(byteStream(b64Bytes(PACK_OFS_DELTA)), {state: "complete"});
    await inOverseer("missing-batch-object", transfer, async (cache, pull) => {
      await expect(pull([COMMIT_1, MISSING_OID], OPTIONS))
          .rejects.toThrow(`git fetch did not provide the requested objects: ${MISSING_OID}`);
      expect(cache.hasLocalObject(COMMIT_1)).toBe(true);
      expect(cache.hasLocalObject(MISSING_OID)).toBe(false);
    });
  });

  it.each([
    {type: "blob"},
    {type: "blob", filterBlobSize: 0},
    {type: "blob", filterBlobSize: 1024},
    {type: "commit", filterBlobSize: 1024},
    {type: "tree", filterBlobSize: 1024},
  ] satisfies Pick<GitPullHints, "type" | "filterBlobSize">[])(
      "rejects an omitted $type, filtered or not", async hints => {
    const transfer = fakeTransfer(await emptyPack(), {state: "complete"});
    await inOverseer(`missing-${hints.type}-${hints.filterBlobSize}`, transfer, async (cache, pull) => {
      await expect(pull([MISSING_OID], {...OPTIONS, ...hints}))
          .rejects.toThrow(`git fetch did not provide the requested objects: ${MISSING_OID}`);
      expect(cache.hasLocalObject(MISSING_OID)).toBe(false);
    });
  });

  it("pulls a blob over the old 8 MB limit, unfiltered, and stores it chunked", async () => {
    const payload = new Uint8Array(9_000_000).fill(0x5a);
    const oid = await gitObjectOid("blob", payload);
    const pack = byteStream(concatBytes(await buildPackBytes([{type: "blob", payload}])), 65536);
    const transfer = fakeTransfer(pack, {state: "complete"});
    await inOverseer("large-blob", transfer, async (cache, pull) => {
      await pull([oid], {type: "blob", commitHistory: {kind: "depth", depth: 1}});
      expect(cache.blobSize(oid)).toBe(payload.byteLength);
      expect(Buffer.from(cache.readBlob(oid, payload.byteLength)).equals(payload)).toBe(true);
    });
  });

  it("pulls and pushes a ~200 MB blob in bounded memory", async () => {
    // Never held whole, here either: the pack is generated by streaming, and read back the same
    // way, from a pseudo-random block cycled through (its period is not a chunk size).
    const SIZE = 200 * 1024 * 1024;
    const block = new Uint8Array(1_000_003);
    for (let i = 0, x = 1; i < block.length; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      block[i] = x >>> 24;
    }
    const hasher = gitObjectHasher("blob", SIZE);
    function* pieces(): Generator<Uint8Array> {
      for (let offset = 0; offset < SIZE;) {
        const piece = new Uint8Array(Math.min(65536, SIZE - offset));
        for (let filled = 0; filled < piece.length;) {
          const from = (offset + filled) % block.length;
          const part = block.subarray(from, Math.min(block.length, from + piece.length - filled));
          piece.set(part, filled);
          filled += part.length;
        }
        hasher.update(piece);
        offset += piece.length;
        yield piece;
      }
    }
    const pack = buildPackStream(1, (async function* () {
      yield {type: "blob" as const, size: SIZE, pieces};
    })());
    const transfer = fakeTransfer(pack, {state: "complete"});
    await inOverseer("huge-blob", transfer, async (cache, pull) => {
      // The oid is known only once the pack has been generated, so the pull names no object.
      await pull([], {type: "blob", commitHistory: {kind: "depth", depth: 1}});


      const oid = hasher.digest("hex");
      expect(cache.blobSize(oid)).toBe(SIZE);

      // Push it back out, and check the pack carries it, hashing it as it streams by.
      const commit = await cache.writeFilesAsCommit(new Map([["huge.bin", {oid, byteLength: SIZE}]]), {
        parents: [], author: {name: "A", email: "a@b"}, message: "huge", timestamp: new Date(0),
      });
      cache.markPushClosure(GATEKEEPER + 1, 1, [commit]);
      const out = await cache.buildPackForAction(GATEKEEPER + 1, 1);
      const seen: string[] = [];

      for await (const object of decodePackStream(out, {
        resolveBase: () => undefined,
        openBlobSink: size => {
          if (size !== SIZE) return undefined;
          const check = gitObjectHasher("blob", size);
          return {write: piece => { check.update(piece); }, finish: () => check.digest("hex")};
        },
      })) {
        seen.push(object.oid);
      }
      expect(seen).toContain(oid);
    });
  }, 300_000);

  it("recovers the producer error after ingestion sees a generic RPC disconnect", async () => {
    const disconnect = new Error("Network connection lost");
    const message = "git fetch failed: upload-pack: not our ref";
    const transfer = fakeTransfer(new ReadableStream({
      type: "bytes",
      pull(controller) { controller.error(disconnect); },
    }), {state: "failed", message});
    await inOverseer("producer-error", transfer, async (_cache, pull) => {
      await expect(pull([COMMIT_1], OPTIONS)).rejects.toMatchObject({message, cause: disconnect});
      expect(transfer.status).toHaveBeenCalledOnce();
    });
  });

  it.each([
    {state: "streaming"},
    {state: "complete"},
    new Error("status RPC disconnected"),
  ] satisfies (GitPullStatus | Error)[])("preserves a local ingestion error with status %j", async status => {
    const transfer = fakeTransfer(await emptyPack(), status);
    const name = status instanceof Error ? "status-disconnect" : status.state;
    await inOverseer(`consumer-error-${name}`, transfer, async (cache, pull) => {
      const localError = new Error("invalid packfile: checksum mismatch");
      const consume = vi.spyOn(cache, "consumePackFromGatekeeper").mockRejectedValueOnce(localError);
      await expect(pull([COMMIT_1], OPTIONS)).rejects.toBe(localError);
      expect(transfer.status).toHaveBeenCalledOnce();
      consume.mockRestore();
    });
  });

  it.each(["streaming", "canceled"] as const)(
      "rejects status %s even after a valid pack drains", async state => {
    const transfer = fakeTransfer(byteStream(b64Bytes(PACK_OFS_DELTA)), {state});
    await inOverseer(`incomplete-${state}`, transfer, async (cache, pull) => {
      await expect(pull([COMMIT_1], OPTIONS))
          .rejects.toThrow(`git fetch ended without a completed transfer (${state})`);
      expect(cache.hasLocalObject(COMMIT_1)).toBe(true);
    });
  });

  it("rejects a failed producer status even when ingestion succeeds", async () => {
    const message = "git fetch failed: upload-pack failed after sending the pack";
    const transfer = fakeTransfer(byteStream(b64Bytes(PACK_OFS_DELTA)), {state: "failed", message});
    await inOverseer("failed-after-pack", transfer, async (_cache, pull) => {
      await expect(pull([COMMIT_1], OPTIONS)).rejects.toThrow(message);
    });
  });
});
