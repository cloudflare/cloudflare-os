// Exercise the pull delegate installed by the real Overseer, including its cache ingestion.
// Calling the delegate directly keeps cache retries from hiding a rejected transfer after some
// requested objects have already arrived. Only the provider facet is replaced, as in git-push-actions.

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { GitPullHints, GitPullStatus, GitPullTransfer } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { WorkspaceGitCache } from "../src/git-cache";
import { buildPackBytes, concatBytes } from "../src/git-codec";
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
    {type: "commit", filterBlobSize: 1024},
    {type: "tree", filterBlobSize: 1024},
  ] satisfies Pick<GitPullHints, "type" | "filterBlobSize">[])(
      "rejects an omitted $type unless it is a filtered blob", async hints => {
    const transfer = fakeTransfer(await emptyPack(), {state: "complete"});
    await inOverseer(`missing-${hints.type}`, transfer, async (_cache, pull) => {
      await expect(pull([MISSING_OID], {...OPTIONS, ...hints}))
          .rejects.toThrow(`git fetch did not provide the requested objects: ${MISSING_OID}`);
    });
  });

  it.each([0, 1024])("allows a filtered blob omission with filterBlobSize=%s", async filterBlobSize => {
    const transfer = fakeTransfer(await emptyPack(), {state: "complete"});
    await inOverseer(`filtered-blob-${filterBlobSize}`, transfer, async (cache, pull) => {
      await expect(pull([MISSING_OID], {...OPTIONS, type: "blob", filterBlobSize}))
          .resolves.toBeUndefined();
      expect(cache.hasLocalObject(MISSING_OID)).toBe(false);
    });
  });

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
