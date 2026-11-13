import {worktreeGitPull} from "../../src/worktree-git";
import {serveGitUploadPack} from "@gadgets/gatekeeper-kit/git-upload-pack";
import {openGitPull} from "@gadgets/gatekeeper-kit/git-transport";
import type {GitObjectType} from "@gadgets/workshop-shared/gatekeeper";
import type {WorktreeGitPullHints} from "@gadgets/workshop-shared/worktree-replica";

interface Fixture {
  heads: string[];
  /** The history's boundary commits, which the upstream repository has. */
  boundary: string[];
  objects: Record<string, {type: GitObjectType; bytes: number[]}>;
  forbiddenBlobs: string[];
  /** Trees fetchable by ID, as snapshot trees are. */
  trees: string[];
  /** Trees the cache lacks until a blob-less pull of each brings it. */
  unstoredTrees: string[];
}
const pulledTrees = new Set<string>();
export default {
  // `/repo<n>/...` serves the worktree with `heads[n]` as its head, as it moves.
  async fetch(request: Request, env: {FIXTURE: Fixture; UPSTREAM: Fetcher}) {
    const fixture = env.FIXTURE;
    const url = new URL(request.url);
    const head = fixture.heads[Number(/^\/repo(\d*)/.exec(url.pathname)?.[1] || 0)];
    url.pathname = url.pathname.replace(/^\/repo\d*/, "");
    const ensureObject = async (oid: string) => {
      if (fixture.forbiddenBlobs.includes(oid)) throw new Error("Remote blob faulted into DO cache.");
      if (fixture.unstoredTrees.includes(oid) && !pulledTrees.has(oid)) throw new Error("Boundary tree faulted in alone.");
      const object = fixture.objects[oid];
      if (!object) throw new Error(`Unknown fixture object ${oid}`);
      return {type: object.type, payload: Uint8Array.from(object.bytes)};
    };
    const gitPull = (wants: string[], wantHints: WorktreeGitPullHints) => worktreeGitPull({ensureObject,
      packEntry: ensureObject, ensureGitObjects: async (oids, hints) => {
        if (hints.filterBlobSize === 0) for (const oid of oids) pulledTrees.add(oid);
      }}, {head, trees: new Set(fixture.trees),
      remotes: fixture.boundary.length ? [{haves: fixture.boundary, pull: async (oids, hints) => {
        const {pack, shallowInfo} = await openGitPull(body => env.UPSTREAM.fetch("https://upstream.invalid/", {
          method: "POST", body}), oids, hints);
        // Fragment the pack header, entries, and trailer across network chunks.
        return {shallow: await shallowInfo(), pack: pack.pipeThrough(new TransformStream({transform(chunk, controller) {
          for (let offset = 0; offset < chunk.length; offset += 7) controller.enqueue(chunk.slice(offset, offset + 7));
        }}))};
      }}] : []}, wants, wantHints);
    return serveGitUploadPack(new Request(url, request), {gitHead: async () => head, gitPull});
  },
};
