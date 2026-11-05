import {worktreeGitPull} from "../../src/worktree-git";
import type {GitObjectType} from "@gadgets/workshop-shared/gatekeeper";

interface Fixture {
  head: string; boundary: string | null;
  objects: Record<string, {type: GitObjectType; bytes: number[]}>;
  upstreamPack: number[];
  forbiddenBlobs: string[];
}
export default {
  async fetch(request: Request, env: {FIXTURE: Fixture; UPSTREAM: Fetcher}) {
    const fixture = env.FIXTURE;
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/^\/repo/, "");
    return worktreeGitPull({ensureObject: async oid => {
      if (fixture.forbiddenBlobs.includes(oid)) throw new Error("Remote blob faulted into DO cache.");
      const object = fixture.objects[oid];
      if (!object) throw new Error(`Unknown fixture object ${oid}`);
      return {oid, type: object.type, payload: Uint8Array.from(object.bytes)};
    }}, {head: fixture.head, shallowCommit: fixture.boundary, pending: [], check() {}, remotePull: request => env.UPSTREAM.fetch(request),
      upstream: async () => new ReadableStream({start(controller) {
        // Fragment the original pack header, entries, and trailer across network chunks.
        const bytes = Uint8Array.from(fixture.upstreamPack);
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
      }})}, new Request(url, request));
  },
};
