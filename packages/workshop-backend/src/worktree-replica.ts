import type {FileChangeByPath} from "@gadgets/workshop-shared/worktree-replica";
import {codeChangeSerializedSize, validateCodeChangeSchema, type CodeChange}
  from "@gadgets/workshop-shared/code-change";

/** An expected pre-commit conflict; retry before accepting an agent step. */
export class ReplicaChangedError extends Error {}

/** Reject filesystem aliases and private Git metadata at the API boundary. */
export function requireReplicaPath(path: string): void {
  if (!path || path.length > 4096 || path.includes("\0") || path.includes("\\") ||
      path.split("/").some(part => !part || part === "." || part === ".." || part === ".git"))
    throw new Error("Invalid worktree path.");
}

/** Validate one bounded batch without expanding text OTs into replacement contents. */
export function worktreeBatch(worktreeId: number, changes: FileChangeByPath[]): CodeChange {
  if (changes.length > 128) throw new Error("Worktree batch exceeds its budget.");
  const seen = new Set<string>();
  for (const {path} of changes) {
    requireReplicaPath(path);
    if (seen.has(path)) throw new Error("Duplicate worktree path.");
    seen.add(path);
  }
  const change: CodeChange = changes.length
    ? {[worktreeId]: changes.map(({path, change}) => [path, change])} : {};
  validateCodeChangeSchema(change);
  if (codeChangeSerializedSize(change) > 1024 * 1024)
    throw new Error("Worktree batch exceeds its budget.");
  return change;
}
