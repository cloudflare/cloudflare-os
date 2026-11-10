// A worktree's replica endpoints as the overseer serves them, minus the overseer, for native Git:
// a worktree whose history is all in the workspace, held by an InMemoryWorktree (which is its
// turn as well as its host) over mock storage, and the replica state of one execution that never
// ends. HTTP stands in for RPC: `/repo/...` is native Git's fetch, through the kit's
// serveGitUploadPack() over gitHead() and gitPull(), `/snapshot` and `/submit` are
// snapshot() and a command's submit(), and `/write` and `/read` are the agent's code using the
// Worktree binding meanwhile.

import {WorkspaceGitCache} from "../../src/git-cache";
import {InMemoryWorktree} from "../../src/git-binding";
import {makeOverseerStorage} from "../../src/storage-schema/overseer-storage";
import {worktreeGitPull} from "../../src/worktree-git";
import {serveGitUploadPack} from "@gadgets/gatekeeper-kit/git-upload-pack";
import {WorktreeReplicas} from "../../src/worktree-replica";
import type {WorktreeCommand} from "@gadgets/workshop-shared/worktree-replica";
import {makeMockStorage} from "../mock-storage";

async function start() {
  const storage = makeOverseerStorage(makeMockStorage());
  const cache = new WorkspaceGitCache(storage, {pull: async () => { throw new Error("Nothing to pull."); }});
  const base = await cache.writeFilesAsCommit(new Map([["a.txt", "one\ntwo\n"], ["lib/b.txt", "bee\n"]]),
    {parents: [], author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0)});
  const worktree = new InMemoryWorktree(cache, base);
  const replicas = new WorktreeReplicas(worktree, worktree, () => true, {type: "agent", id: "test", name: "Test"});
  return {worktree, replicas, commands: [] as WorktreeCommand[]};
}
let state: ReturnType<typeof start> | undefined;

export default {
  async fetch(request: Request) {
    const {worktree, replicas, commands} = await (state ??= start());
    const url = new URL(request.url);
    const param = (name: string) => url.searchParams.get(name)!;
    try {
      if (url.pathname.startsWith("/repo/")) {
        url.pathname = url.pathname.slice("/repo".length);
        const head = worktree.getWorktreeRecord().headCommit;
        return await serveGitUploadPack(new Request(url, request), {gitHead: async () => head,
          gitPull: (oids, hints) => worktreeGitPull(worktree.gitCache,
            {head, trees: replicas.fetchableTrees(0), remotes: []}, oids, hints)});
      }
      switch (url.pathname) {
        case "/snapshot": {
          const {tree, head, command} = await replicas.snapshot(0);
          return Response.json({tree, head, command: commands.push(command) - 1});
        }
        case "/submit":
          return Response.json(await commands[Number(param("command"))].submit(param("tree"), request.body!));
        case "/write":
          worktree.appendChange(0, param("path"), {set: await request.text()});
          return new Response();
        case "/read":
          return new Response(await worktree.readFile(0, param("path")));
      }
      return new Response("Not found", {status: 404});
    } catch (error) {
      return new Response(String(error), {status: 500});
    }
  },
};
