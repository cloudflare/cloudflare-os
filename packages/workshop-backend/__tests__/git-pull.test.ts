// Exercise the real Overseer's Git protocol composer/demultiplexer and cache ingestion.
// Only the source facet is replaced; no fake transfer/status capability bypasses the protocol.
import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import type {GitPullHints} from "@gadgets/workshop-shared/gatekeeper";
import {buildGitFetchRequest, encodePktLine, FLUSH_PKT} from "@gadgets/gatekeeper-kit/git-transport";
import type {OverseerDurableObject} from "../src/overseer.js";
import type {WorkspaceGitCache} from "../src/git-cache";
import {buildPackBytes, buildPackStream, decodePackStream, gitObjectHasher, gitObjectOid, concatBytes} from "../src/git-codec";
import {COMMIT_1, PACK_OFS_DELTA, b64Bytes, byteStream} from "./git-cache-fixtures";

declare global {
  namespace Cloudflare {
    interface Env {TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;}
  }
}
const GATEKEEPER = 7, MISSING_OID = "f".repeat(40);
const OPTIONS: GitPullHints = {type: "commit", commitHistory: {kind: "depth", depth: 1}};
const band = (id: number, bytes: Uint8Array) => concatBytes([
  new TextEncoder().encode((bytes.length + 5).toString(16).padStart(4, "0")), Uint8Array.of(id), bytes,
]);
const response = (pack = b64Bytes(PACK_OFS_DELTA), trailer = FLUSH_PKT) => new Response(byteStream(concatBytes([
  encodePktLine("packfile"), band(1, pack), trailer,
])));
function streamedResponse(pack: ReadableStream<Uint8Array>): Response {
  const frames = (async function* () {
    yield encodePktLine("packfile");
    for await (const chunk of pack) {
      for (let offset = 0; offset < chunk.length; offset += 65515)
        yield band(1, chunk.subarray(offset, offset + 65515));
    }
    yield FLUSH_PKT;
  })();
  return new Response(new ReadableStream({
    async pull(controller) {
      const result = await frames.next();
      if (result.done) controller.close(); else controller.enqueue(result.value);
    },
    async cancel(reason) { await frames.throw(reason); },
  }));
}
async function inOverseer(name: string, upstream: Response,
    test: (cache: WorkspaceGitCache, pull: (oids: string[], options: GitPullHints) => Promise<void>,
      gitPull: ReturnType<typeof vi.fn>) => Promise<void>) {
  await runInDurableObject(env.TEST_OVERSEER.getByName(`git-pull-${name}`), async instance => {
    const impl = instance["impl"];
    impl.storage.gatekeepers.put({id: GATEKEEPER, resourceTitle: "Remote repository", class: {} as any});
    const gitPull = vi.fn(async (_request: Request) => upstream);
    vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({gitPull} as Awaited<ReturnType<typeof impl.getGatekeeperFacet>>);
    const cache = impl.gitCache;
    await test(cache, (oids, options) => cache["puller"].pull(GATEKEEPER, oids, options), gitPull);
  });
}
async function emptyPack() {return concatBytes(await buildPackBytes([]));}

describe("Git pull consumption through the Overseer delegate", () => {
  it("uses unified smart HTTP without a new observer for known-object pulls and records provenance", async () => {
    await inOverseer("complete", response(), async (cache, pull, gitPull) => {
      await pull([COMMIT_1], OPTIONS);
      expect(gitPull).toHaveBeenCalledTimes(1);
      expect(gitPull.mock.calls[0]).toHaveLength(1);
      const request = gitPull.mock.calls[0][0] as Request;
      expect(request.url).toBe("https://git.invalid/git-upload-pack");
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(buildGitFetchRequest([COMMIT_1], OPTIONS));
      expect(cache.hasLocalObject(COMMIT_1)).toBe(true);
      expect((await cache.readForGatekeeper(GATEKEEPER, COMMIT_1))?.type).toBe("commit");
      expect(await cache.readForGatekeeper(GATEKEEPER + 1, COMMIT_1)).toBeNull();
    });
  });
  it("rejects a complete pack missing one requested object, without dropping the objects received", async () => {
    await inOverseer("missing-batch", response(), async (cache, pull) => {
      await expect(pull([COMMIT_1, MISSING_OID], OPTIONS)).rejects.toThrow(`git fetch did not provide the requested objects: ${MISSING_OID}`);
      expect(cache.hasLocalObject(COMMIT_1)).toBe(true);
      expect(cache.hasLocalObject(MISSING_OID)).toBe(false);
    });
  });
  it.each([
    {type: "blob"}, {type: "commit", filterBlobSize: 1024}, {type: "tree", filterBlobSize: 1024},
  ] satisfies Pick<GitPullHints, "type" | "filterBlobSize">[])("rejects an omitted $type", async hints => {
    await inOverseer(`missing-${hints.type}`, response(await emptyPack()), async (_cache, pull) => {
      await expect(pull([MISSING_OID], {...OPTIONS, ...hints})).rejects.toThrow(`git fetch did not provide the requested objects: ${MISSING_OID}`);
    });
  });
  it.each([0, 1024])("requires the requested blob even with filterBlobSize=%s", async filterBlobSize => {
    await inOverseer(`filtered-${filterBlobSize}`, response(await emptyPack()), async (cache, pull) => {
      await expect(pull([MISSING_OID], {...OPTIONS, type: "blob", filterBlobSize}))
        .rejects.toThrow(`git fetch did not provide the requested objects: ${MISSING_OID}`);
      expect(cache.hasLocalObject(MISSING_OID)).toBe(false);
    });
  });
  it("pulls a blob over the old 8 MB limit, unfiltered, and stores it chunked", async () => {
    const payload = new Uint8Array(9_000_000).fill(0x5a);
    const oid = gitObjectOid("blob", payload);
    const pack = byteStream(concatBytes(await buildPackBytes([{type: "blob", payload}])), 65536);
    await inOverseer("large-blob", streamedResponse(pack), async (cache, pull) => {
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
        offset += piece.length;
        yield piece;
      }
    }
    for (const piece of pieces()) hasher.update(piece);
    const oid = hasher.digest("hex");
    const pack = buildPackStream(1, (async function* () {
      yield {type: "blob" as const, size: SIZE, pieces};
    })());
    await inOverseer("huge-blob", streamedResponse(pack), async (cache, pull) => {
      await pull([oid], {type: "blob", commitHistory: {kind: "depth", depth: 1}});


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

  it("preserves a local ingestion error rather than replacing it with transfer state", async () => {
    await inOverseer("local-error", response(), async (cache, pull) => {
      const error = new Error("invalid packfile: checksum mismatch");
      const consume = vi.spyOn(cache, "consumePackFromGatekeeper").mockRejectedValueOnce(error);
      try {await expect(pull([COMMIT_1], OPTIONS)).rejects.toBe(error);}
      finally {consume.mockRestore();}
    });
  });
  it.each([
    [new Uint8Array(), "truncated git fetch response: missing final flush"],
    [band(3, new TextEncoder().encode("fatal: upload-pack failed")), "git fetch failed: fatal: upload-pack failed"],
  ] as const)("retains protocol failure after pack bytes arrive", async (trailer, message) => {
    await inOverseer(message, response(undefined, trailer), async (_cache, pull) => {
      await expect(pull([COMMIT_1], OPTIONS)).rejects.toThrow(message);
    });
  });
});
