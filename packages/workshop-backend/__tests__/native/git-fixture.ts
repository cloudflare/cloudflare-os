import {worktreeGitPull} from "../../src/worktree-git";
import {openGitPull} from "@gadgets/gatekeeper-kit/git-transport";
import type {GitObjectType} from "@gadgets/workshop-shared/gatekeeper";

interface Fixture {
  heads: string[]; boundary: string | null;
  objects: Record<string, {type: GitObjectType; bytes: number[]}>;
  upstreamPack: number[];
  forbiddenBlobs: string[];
}
export default {
  // `/repo<n>/...` serves the worktree with `heads[n]` as its head, as it moves.
  async fetch(request: Request, env: {FIXTURE: Fixture; UPSTREAM: Fetcher}) {
    const fixture = env.FIXTURE;
    const url = new URL(request.url);
    const head = fixture.heads[Number(/^\/repo(\d*)/.exec(url.pathname)?.[1] || 0)];
    url.pathname = url.pathname.replace(/^\/repo\d*/, "");
    return worktreeGitPull({ensureObject: async oid => {
      if (fixture.forbiddenBlobs.includes(oid)) throw new Error("Remote blob faulted into DO cache.");
      const object = fixture.objects[oid];
      if (!object) throw new Error(`Unknown fixture object ${oid}`);
      return {oid, type: object.type, payload: Uint8Array.from(object.bytes)};
    }}, {head, shallowCommit: fixture.boundary, check() {}, trees: new Set(),
      remotes: fixture.boundary ? [{haves: [fixture.boundary], pull: async (oids, hints) => {
        const {pack, shallowInfo} = await openGitPull(body => env.UPSTREAM.fetch("https://upstream.invalid/", {
          method: "POST", body}), oids, hints);
        return {shallow: await shallowInfo(), pack};
      }}] : [],
      upstream: async () => new ReadableStream({start(controller) {
        // Fragment the original pack header, entries, and trailer across network chunks.
        const bytes = Uint8Array.from(fixture.upstreamPack);
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
      }})}, new Request(url, request));
  },
};
