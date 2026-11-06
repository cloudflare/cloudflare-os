// A WorkspaceGitCache for tests that exercise only the workspace's own history, which never
// pulls: any pull fails the test.

import { WorkspaceGitCache } from "../src/git-cache";
import { makeOverseerStorage, type OverseerStorage } from "../src/storage-schema/overseer-storage";
import { makeMockStorage } from "./mock-storage";

export function makeLocalGitCache(
    storage: OverseerStorage = makeOverseerStorage(makeMockStorage())): WorkspaceGitCache {
  return new WorkspaceGitCache(storage, {
    pull: async () => { throw new Error("test: unexpected git pull"); },
  });
}
