import type { WorktreeBase } from "@gadgets/workshop-shared/agent-integration";
import type { GitObjectType } from "@gadgets/workshop-shared/gatekeeper";
import type { WorkspaceGitCache } from "./git-cache";
import { buildPackStream, parseGitCommitRefs, parseGitTree } from "./git-codec";

/** Export captured heads, excluding objects already present in the fully materialized base. */
export async function replicaCommitPack(cache: WorkspaceGitCache, tree: WorktreeBase,
    requireLive: () => void, historyBase = tree.baseCommit): Promise<ReadableStream<Uint8Array>> {
  const objects = new Map<string, {type: GitObjectType; referencedBy?: string}>();
  const add = (oid: string, type: GitObjectType, referencedBy?: string) => {
    objects.set(oid, {type, referencedBy});
    if (objects.size > 100_000) throw new Error("Replica commit export exceeds its object budget.");
  };
  const read = async (oid: string, type: GitObjectType, referencedBy?: string) => {
    requireLive();
    const object = await cache.ensureObject(oid, {type, referencedBy});
    requireLive();
    return object;
  };
  const baseTree = tree.baseCommit
    ? parseGitCommitRefs((await read(tree.baseCommit, "commit")).payload).tree : undefined;
  const trees = async (oid: string, previous?: string) => {
    if (oid === previous || objects.has(oid)) return;
    add(oid, "tree");
    const entries = parseGitTree((await read(oid, "tree")).payload);
    const prior = new Map(previous
      ? parseGitTree((await read(previous, "tree")).payload).map(entry => [entry.name, entry]) : []);
    for (const entry of entries) {
      const old = prior.get(entry.name);
      if (entry.oid === old?.oid || entry.mode === "160000") continue;
      if (entry.mode === "40000") await trees(entry.oid, old?.mode === "40000" ? old.oid : undefined);
      else add(entry.oid, "blob", oid);
    }
  };
  const commits = [...new Set([tree.acceptedCommit, tree.headCommit].filter((oid): oid is string => !!oid))];
  while (commits.length) {
    const oid = commits.pop()!;
    if (oid === tree.baseCommit || objects.has(oid)) continue;
    add(oid, "commit");
    const commit = parseGitCommitRefs((await read(oid, "commit")).payload);
    await trees(commit.tree, baseTree);
    // A migrated worktree can hydrate from a newer local accepted commit while its explicit
    // HEAD still points at the original upstream shallow boundary. Never pull its ancestry.
    if (oid !== historyBase) commits.push(...commit.parents);
  }
  // Any source can fall back to byte hydration, with only a placeholder base commit. Export
  // the real header too, retaining the shallow boundary without retransmitting base files.
  if (tree.baseCommit) add(tree.baseCommit, "commit");
  async function* contents() {
    for (const [oid, hint] of objects) yield await read(oid, hint.type, hint.referencedBy);
    requireLive();
  }
  return buildPackStream(objects.size, contents());
}
