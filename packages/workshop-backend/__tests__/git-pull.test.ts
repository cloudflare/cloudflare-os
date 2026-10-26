// Exercise the real Overseer's Git protocol composer/demultiplexer and cache ingestion.
// Only the source facet is replaced; no fake transfer/status capability bypasses the protocol.
import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import type {GitPullHints} from "@gadgets/workshop-shared/gatekeeper";
import {buildGitFetchRequest, encodePktLine, FLUSH_PKT} from "@gadgets/gatekeeper-kit/git-transport";
import type {OverseerDurableObject} from "../src/overseer.js";
import type {WorkspaceGitCache} from "../src/git-cache";
import {buildPackBytes, concatBytes} from "../src/git-codec";
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
  ] satisfies Pick<GitPullHints, "type" | "filterBlobSize">[])("rejects an omitted $type unless it is a filtered blob", async hints => {
    await inOverseer(`missing-${hints.type}`, response(await emptyPack()), async (_cache, pull) => {
      await expect(pull([MISSING_OID], {...OPTIONS, ...hints})).rejects.toThrow(`git fetch did not provide the requested objects: ${MISSING_OID}`);
    });
  });
  it.each([0, 1024])("allows filtered blob omission with filterBlobSize=%s", async filterBlobSize => {
    await inOverseer(`filtered-${filterBlobSize}`, response(await emptyPack()), async (cache, pull) => {
      await pull([MISSING_OID], {...OPTIONS, type: "blob", filterBlobSize});
      expect(cache.hasLocalObject(MISSING_OID)).toBe(false);
    });
  });
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
