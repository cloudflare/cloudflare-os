import {
  applyCodeChange, composeCodeChange, transformCodeChange, validateCodeChangeSchema,
  validateCodeChangeContent, MAX_FILE_PATH_LENGTH,
  type CodeChange, type FileChange, type FileContent,
} from "@gadgets/workshop-shared/code-change";

/** A frozen replica batch, anchored to the last canonical content it acknowledged. */
export type ReplicaBatch = {
  batchId: string;
  files: {path: string, before: FileContent | null, change: FileChange | null}[];
};

/** Content identity of a replica anchor; absence differs from empty UTF-8 text. */
export async function replicaTextHash(text: string | null): Promise<string | null> {
  return text === null ? null : new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(text))).toHex();
}

/** Byte versions hash immutable metadata, never bulk payload; text retains its existing identity. */
export async function replicaContentHash(value: FileContent | null): Promise<string | null> {
  if (typeof value === "string" || value === null) return replicaTextHash(value);
  return "bytes:" + new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(value)))).toHex();
}

/** Persisted atomically with the accepted DO changes, before releasing the replica barrier. */
export type ReplicaAck = {
  checkoutId: number;
  batchId: string;
  changes: [string, FileChange][];
  /** Canonical OTs from the replica's acknowledged anchor, retained in its disk journal. */
  operations: [string, FileChange][];
  accepted: [string, FileContent | null][];
};

/** Reconcile local edits against DO edits with the existing server-ordered OT engine. */
export async function mergeReplicaBatch(
    checkoutId: number, batch: ReplicaBatch,
    remoteChange: CodeChange)
    : Promise<{change: CodeChange, ack: ReplicaAck}> {
  if (!batch || typeof batch.batchId !== "string" || batch.batchId.length > 64 ||
      batch.batchId === "" || !Array.isArray(batch.files) || batch.files.length > 10_000) {
    throw new Error("Invalid replica batch.");
  }
  let before = new Map<string, FileContent>();
  let seen = new Set<string>();
  for (let file of batch.files) {
    // CodeChange validates OT shape, not filesystem namespaces. Reject aliases and private
    // metadata here, before reading a canonical path or constructing a durable change.
    if (!file || typeof file.path !== "string" || file.path.length > MAX_FILE_PATH_LENGTH ||
        file.path.includes("\0") || file.path.split("/").some(segment =>
          segment === "" || segment === "." || segment === ".." || segment === ".git")) {
      throw new Error("Invalid replica path.");
    }
    for (let text of [file.before]) {
      if (typeof text === "string" && text.includes("\0")) {
        throw new Error("Invalid replica text.");
      }
    }
    if (seen.has(file.path)) throw new Error("Duplicate path in replica batch.");
    seen.add(file.path);
    if (file.before !== null) before.set(file.path, file.before);
  }
  let base = new Map([[checkoutId, before]]);
  // Canonical operations come from the journal, never from re-diffing their resulting bytes.
  // In repeated text a diff can relocate an insertion and change the established OT ordering.
  let localChange: CodeChange = {};
  for (const file of batch.files) {
    const change = file.change;
    if (change) (localChange[checkoutId] ??= []).push([file.path, change]);
  }
  validateCodeChangeSchema(remoteChange);
  validateCodeChangeSchema(localChange);
  // The replica bridge only supports non-NUL text anchors. Check the submitted payload, not a
  // full-file diff, before an ACK can make an unsupported file part of its next anchor.
  for (const [, change] of localChange[checkoutId] ?? []) {
    if ("set" in change ? change.set.includes("\0") : "edit" in change &&
        change.edit.some(section => Array.isArray(section) && section.some((part, index) =>
          index > 0 && typeof part === "string" && part.includes("\0")))) {
      throw new Error("Invalid replica text.");
    }
  }
  validateCodeChangeContent(remoteChange, base);
  validateCodeChangeContent(localChange, base);
  const doContent = applyCodeChange(base, remoteChange);
  const localContent = applyCodeChange(base, localChange);
  // The DO serializes the canonical stream. This is deliberately not a second, timestamp-
  // based merge algorithm: set/remove conflicts have the existing OT engine's semantics.
  const transformed = transformCodeChange(remoteChange, localChange);
  let change = transformed.b;
  validateCodeChangeSchema(change);
  validateCodeChangeContent(change, doContent);
  let merged = applyCodeChange(doContent, change);
  let reply = transformed.a;
  validateCodeChangeSchema(reply);
  validateCodeChangeContent(reply, localContent);
  return {change, ack: {
    checkoutId, batchId: batch.batchId,
    changes: reply[checkoutId] ?? [],
    operations: composeCodeChange(remoteChange, change)[checkoutId] ?? [],
    accepted: batch.files.map(({path}) => [path, merged.get(checkoutId)?.get(path) ?? null]),
  }};
}
