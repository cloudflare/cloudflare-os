import type { FileChangeByPath } from "@gadgets/workshop-shared/agent-integration";
import type { GitObjectType } from "@gadgets/workshop-shared/gatekeeper";
import type { WorkspaceGitCache } from "./git-cache";
import { buildPackStream, parseGitCommitRefs, parseGitTree } from "./git-codec";

/** Export captured heads, excluding objects already present in the fully materialized base. */
export async function replicaCommitPack(cache: Pick<WorkspaceGitCache, "ensureObject">, tree: {baseCommit: string | null; acceptedCommit?: string | null; headCommit?: string | null},
    requireLive: () => void, pending: FileChangeByPath[] = []): Promise<ReadableStream<Uint8Array>> {
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
    commits.push(...commit.parents);
  }
  for (const {change} of pending) if ("setBytes" in change) add(change.setBytes.oid, "blob");
  // The upstream pack already supplies the complete shallow base. A rename/copy can reuse a
  // base blob at another path: same-path comparisons above alone cannot prevent duplicate
  // objects, which native Git rejects in a single combined pack. Inspect tree metadata only;
  // never fault a base blob into DO storage or retain the base's file contents in memory.
  const excludeBase = async (oid: string) => {
    objects.delete(oid);
    for (const entry of parseGitTree((await read(oid, "tree")).payload)) {
      objects.delete(entry.oid);
      if (entry.mode === "40000") await excludeBase(entry.oid);
    }
  };
  if (baseTree && [...objects.values()].some(object => object.type !== "commit")) await excludeBase(baseTree);
  async function* contents() {
    for (const [oid, hint] of objects) yield await read(oid, hint.type, hint.referencedBy);
    requireLive();
  }
  return buildPackStream(objects.size, contents());
}
