import type {
  GmailAttachmentInfo, GmailCustomLabel, GmailDraftPatch, GmailMutableSystemLabel,
} from "./types";
import {emailRecipientToAddress, MAX_GMAIL_FORWARD_SOURCE_BYTES} from "./google-api";
import type {GmailLabelRaw, GmailNormalizedRecipients, GmailParsedDraft} from "./google-api";

/** Bytes per stored forward-source chunk, leaving ample headroom below the 2 MiB value limit. */
export const GMAIL_FORWARD_SNAPSHOT_CHUNK_BYTES = 1024 * 1024;

/** Maximum aggregate raw forward-source bytes retained by one Gmail binding. */
export const MAX_GMAIL_PENDING_FORWARD_SNAPSHOT_BYTES = 50 * 1024 * 1024;

/** Integrity metadata persisted in an action instead of the forward source bytes themselves. */
export type GmailForwardSnapshotReference = {
  /** Opaque handle for private Durable Object storage. */
  handle: string;
  /** Exact decoded source size. */
  size: number;
  /** SHA-256 digest of the decoded source bytes. */
  digest: string;
};

type GmailForwardSnapshotManifest = GmailForwardSnapshotReference & {
  version: 1;
  chunks: number;
};

type GmailForwardSnapshotAllocation = {
  version: 1;
  size: number;
  chunks: number;
  createdAt: number;
};

type GmailSnapshotStorage = Pick<DurableObjectStorage, "kv" | "transactionSync">;

const FORWARD_SNAPSHOT_PREFIX = "gmail:forwardSnapshot:";
const FORWARD_SNAPSHOT_ALLOCATION_PREFIX = "gmail:forwardSnapshotAllocation:";
const FORWARD_SNAPSHOT_TOTAL_KEY = `${FORWARD_SNAPSHOT_ALLOCATION_PREFIX}totalBytes`;
const SNAPSHOT_HANDLE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function forwardSnapshotManifestKey(handle: string): string {
  return `${FORWARD_SNAPSHOT_PREFIX}${handle}:manifest`;
}

function forwardSnapshotAllocationKey(handle: string): string {
  return `${FORWARD_SNAPSHOT_ALLOCATION_PREFIX}${handle}`;
}

function forwardSnapshotChunkPrefix(handle: string): string {
  return `${FORWARD_SNAPSHOT_PREFIX}${handle}:chunk:`;
}

function forwardSnapshotChunkKey(handle: string, index: number): string {
  return `${forwardSnapshotChunkPrefix(handle)}${String(index).padStart(4, "0")}`;
}

function validSnapshotReference(value: unknown): value is GmailForwardSnapshotReference {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return typeof snapshot.handle === "string" && SNAPSHOT_HANDLE_PATTERN.test(snapshot.handle) &&
    Number.isSafeInteger(snapshot.size) && (snapshot.size as number) >= 0 &&
    (snapshot.size as number) <= MAX_GMAIL_FORWARD_SOURCE_BYTES &&
    typeof snapshot.digest === "string" && /^[0-9a-f]{64}$/.test(snapshot.digest);
}

function validSnapshotManifest(value: unknown): value is GmailForwardSnapshotManifest {
  if (!validSnapshotReference(value)) return false;
  const manifest = value as GmailForwardSnapshotManifest;
  return manifest.version === 1 && Number.isSafeInteger(manifest.chunks) && manifest.chunks >= 0 &&
    manifest.chunks === Math.ceil(manifest.size / GMAIL_FORWARD_SNAPSHOT_CHUNK_BYTES);
}

function validSnapshotAllocation(value: unknown): value is GmailForwardSnapshotAllocation {
  if (!value || typeof value !== "object") return false;
  const allocation = value as GmailForwardSnapshotAllocation;
  return allocation.version === 1 && Number.isSafeInteger(allocation.size) &&
    allocation.size >= 0 && allocation.size <= MAX_GMAIL_FORWARD_SOURCE_BYTES &&
    Number.isSafeInteger(allocation.chunks) && allocation.chunks >= 0 &&
    allocation.chunks === Math.ceil(allocation.size / GMAIL_FORWARD_SNAPSHOT_CHUNK_BYTES) &&
    Number.isSafeInteger(allocation.createdAt) && allocation.createdAt >= 0;
}

/** Stores and verifies exact forward source bytes in bounded private Durable Object chunks. */
export class GmailForwardSnapshotStore {
  #storage: GmailSnapshotStorage;

  constructor(storage: GmailSnapshotStorage) {
    this.#storage = storage;
  }

  /** Capture exact decoded source bytes and return only bounded integrity metadata. */
  async capture(bytes: Uint8Array): Promise<GmailForwardSnapshotReference> {
    if (bytes.byteLength > MAX_GMAIL_FORWARD_SOURCE_BYTES) {
      throw new Error(
        `Cannot retain a forward source larger than ${MAX_GMAIL_FORWARD_SOURCE_BYTES} bytes.`);
    }
    const snapshot: GmailForwardSnapshotReference = {
      handle: crypto.randomUUID(),
      size: bytes.byteLength,
      digest: await sha256(bytes),
    };
    const chunks = Math.ceil(bytes.byteLength / GMAIL_FORWARD_SNAPSHOT_CHUNK_BYTES);
    this.#storage.transactionSync(() => {
      const storedTotal = this.#storage.kv.get<unknown>(FORWARD_SNAPSHOT_TOTAL_KEY);
      const total = storedTotal === undefined ? 0 : storedTotal;
      if (!Number.isSafeInteger(total) || (total as number) < 0 ||
          (total as number) > MAX_GMAIL_PENDING_FORWARD_SNAPSHOT_BYTES) {
        throw new Error("Stored Gmail forward snapshot accounting is invalid.");
      }
      if ((total as number) + snapshot.size > MAX_GMAIL_PENDING_FORWARD_SNAPSHOT_BYTES) {
        throw new Error(
          "Pending Gmail forward snapshots exceed the safe aggregate storage limit. " +
          "Resolve existing forward actions before adding another.");
      }
      this.#storage.kv.put<GmailForwardSnapshotAllocation>(
        forwardSnapshotAllocationKey(snapshot.handle), {
          version: 1, size: snapshot.size, chunks, createdAt: Date.now(),
        });
      this.#storage.kv.put<GmailForwardSnapshotManifest>(
        forwardSnapshotManifestKey(snapshot.handle), {...snapshot, version: 1, chunks});
      for (let index = 0; index < chunks; index++) {
        const start = index * GMAIL_FORWARD_SNAPSHOT_CHUNK_BYTES;
        this.#storage.kv.put(
          forwardSnapshotChunkKey(snapshot.handle, index),
          bytes.slice(start, start + GMAIL_FORWARD_SNAPSHOT_CHUNK_BYTES));
      }
      this.#storage.kv.put(FORWARD_SNAPSHOT_TOTAL_KEY, (total as number) + snapshot.size);
    });
    return snapshot;
  }

  /** Reassemble a captured source only after checking shape, completeness, size, and digest. */
  async read(snapshot: GmailForwardSnapshotReference): Promise<Uint8Array> {
    if (!validSnapshotReference(snapshot)) {
      throw new Error(
        "This pending forward uses an obsolete source snapshot. Reject and resubmit it.");
    }
    const manifest = this.#storage.kv.get<unknown>(forwardSnapshotManifestKey(snapshot.handle));
    if (!validSnapshotManifest(manifest) || manifest.size !== snapshot.size ||
        manifest.digest !== snapshot.digest || manifest.handle !== snapshot.handle) {
      throw new Error("The stored forward snapshot is incomplete or corrupted.");
    }
    const entries = [...this.#storage.kv.list<unknown>({
      prefix: forwardSnapshotChunkPrefix(snapshot.handle),
    })].toSorted(([left], [right]) => left.localeCompare(right));
    if (entries.length !== manifest.chunks) {
      throw new Error("The stored forward snapshot is incomplete or corrupted.");
    }
    const bytes = new Uint8Array(manifest.size);
    let offset = 0;
    for (let index = 0; index < entries.length; index++) {
      const [key, chunk] = entries[index];
      const expectedKey = forwardSnapshotChunkKey(snapshot.handle, index);
      const expectedSize = Math.min(
        GMAIL_FORWARD_SNAPSHOT_CHUNK_BYTES, manifest.size - offset);
      if (key !== expectedKey || !(chunk instanceof Uint8Array) ||
          chunk.byteLength !== expectedSize) {
        throw new Error("The stored forward snapshot is incomplete or corrupted.");
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== manifest.size || await sha256(bytes) !== manifest.digest) {
      throw new Error("The stored forward snapshot is incomplete or corrupted.");
    }
    return bytes;
  }

  /** Delete all chunks for a snapshot and release its aggregate storage allocation. */
  delete(snapshot: GmailForwardSnapshotReference | undefined): void {
    if (!validSnapshotReference(snapshot)) return;
    this.#delete(snapshot.handle);
  }

  /** Delete stale allocations that no pending action references. */
  pruneUnreferenced(referencedHandles: ReadonlySet<string>, createdBefore: number): void {
    const orphaned: string[] = [];
    for (const [key, value] of this.#storage.kv.list<unknown>({
      prefix: FORWARD_SNAPSHOT_ALLOCATION_PREFIX,
    })) {
      if (key === FORWARD_SNAPSHOT_TOTAL_KEY || !validSnapshotAllocation(value) ||
          value.createdAt > createdBefore) continue;
      const handle = key.slice(FORWARD_SNAPSHOT_ALLOCATION_PREFIX.length);
      if (SNAPSHOT_HANDLE_PATTERN.test(handle) && !referencedHandles.has(handle)) orphaned.push(handle);
    }
    for (const handle of orphaned) this.#delete(handle);
  }

  #delete(handle: string): void {
    this.#storage.transactionSync(() => {
      const manifest = this.#storage.kv.get<unknown>(forwardSnapshotManifestKey(handle));
      const allocation = this.#storage.kv.get<unknown>(forwardSnapshotAllocationKey(handle));
      const chunks = validSnapshotAllocation(allocation)
        ? allocation.chunks
        : validSnapshotManifest(manifest)
          ? manifest.chunks
          : undefined;
      if (chunks !== undefined) {
        for (let index = 0; index < chunks; index++) {
          this.#storage.kv.delete(forwardSnapshotChunkKey(handle, index));
        }
      } else {
        // Corrupt metadata is exceptional; still make a best effort to remove private bytes.
        for (const [key] of this.#storage.kv.list({
          prefix: forwardSnapshotChunkPrefix(handle),
        })) {
          this.#storage.kv.delete(key);
        }
      }
      this.#storage.kv.delete(forwardSnapshotManifestKey(handle));
      this.#storage.kv.delete(forwardSnapshotAllocationKey(handle));
      const total = this.#storage.kv.get<unknown>(FORWARD_SNAPSHOT_TOTAL_KEY);
      const allocatedSize = validSnapshotAllocation(allocation)
        ? allocation.size
        : validSnapshotManifest(manifest)
          ? manifest.size
          : undefined;
      if (allocatedSize !== undefined && typeof total === "number" &&
          Number.isSafeInteger(total) && total >= 0) {
        this.#storage.kv.put(FORWARD_SNAPSHOT_TOTAL_KEY, Math.max(0, total - allocatedSize));
      }
    });
  }
}

export type GmailDraftSource = {
  kind: "reply" | "forward";
  messageId: string;
  /** Present on forwards created with Gmail's inline web-style representation. */
  format?: "inline";
};

export type GmailDraftAttachmentState = {
  key: string;
  info: GmailAttachmentInfo;
  contentDigest?: string;
};

export type GmailDraftState = GmailNormalizedRecipients & {
  logicalId: string;
  from: string;
  replyTo: string[];
  date?: string;
  providerId?: string;
  messageId?: string;
  threadId?: string;
  subject: string;
  text: string;
  html?: string;
  rfcMessageId?: string;
  inReplyTo?: string;
  references?: string;
  timestamp: number;
  source?: GmailDraftSource;
  attachments: GmailDraftAttachmentState[];
  version: number;
};

export type GmailDraftResource = {
  logicalId: string;
  providerId?: string;
  source?: GmailDraftSource;
  /** Exact source retained while an inline forward draft remains editable. */
  forwardSnapshot?: GmailForwardSnapshotReference;
  /** User-authored preface retained separately from the generated quoted source. */
  forwardBody?: string;
  forwardHtml?: string;
  createdAt: number;
  status: "active" | "rejected" | "deleted" | "sent";
  version: number;
};

export type GmailLabelResource = {
  logicalId: string;
  providerId?: string;
  name: string;
  status: "active" | "rejected" | "deleted";
};

export type GmailDecision = "applied" | "rejected";

type WithDependencies = {dependsOn?: number[]};

export type GmailDraftOverlayAction = WithDependencies & (
  | {type: "draftCreate"; draft: GmailDraftState}
  | {type: "draftUpdate"; draftId: string; after: GmailDraftState}
  | {type: "draftDelete" | "draftSend"; draftId: string}
);

export type GmailLabelOverlayAction = WithDependencies & (
  | {type: "labelCreate"; label: GmailLabelResource}
  | {type: "labelRename"; labelId: string; name: string}
  | {type: "labelDelete"; labelId: string}
);

export type PendingOverlayAction<Action> = {id: number; action: Action};

/** A dependency is usable only after application; rejection permanently invalidates the child. */
export function gmailDependencyError(
    action: WithDependencies, pendingIds: ReadonlySet<number>,
    decisions: ReadonlyMap<number, GmailDecision>): string | undefined {
  for (const dependency of action.dependsOn ?? []) {
    if (pendingIds.has(dependency)) return "Approve this action's pending prerequisite first.";
    const decision = decisions.get(dependency);
    if (decision === "rejected") {
      return "A prerequisite was rejected; this dependent action is invalid and should be rejected.";
    }
    if (decision !== "applied") {
      return "A prerequisite has no recorded successful outcome; reject this dependent action.";
    }
  }
  return undefined;
}

export function applyGmailDraftPatch(
    draft: GmailDraftState, patch: GmailDraftPatch & Partial<GmailNormalizedRecipients>): GmailDraftState {
  if (draft.source?.kind === "reply" && patch.subject !== undefined && patch.subject !== draft.subject) {
    throw new Error("A reply draft's subject is immutable.");
  }
  const html = patch.html === null ? undefined : patch.html ?? draft.html;
  return {
    ...draft,
    ...(patch.to !== undefined ? {to: patch.to} : {}),
    ...(patch.cc !== undefined ? {cc: patch.cc} : {}),
    ...(patch.bcc !== undefined ? {bcc: patch.bcc} : {}),
    ...(patch.subject !== undefined ? {subject: patch.subject} : {}),
    ...(patch.text !== undefined ? {text: patch.text} : {}),
    ...(html !== undefined ? {html} : {}),
    ...((patch.html === null || (patch.html !== undefined && html === undefined)) ? {html: undefined} : {}),
    timestamp: Date.now(),
    version: draft.version + 1,
  };
}

/** Overlay valid pending actions in submission order; null means deleted/sent/not yet creatable. */
export function overlayGmailDraft(
    logicalId: string, base: GmailDraftState | undefined,
    pending: readonly PendingOverlayAction<GmailDraftOverlayAction>[],
    decisions: ReadonlyMap<number, GmailDecision> = new Map()): GmailDraftState | null {
  let current = base;
  for (const {action} of pending) {
    if ((action.dependsOn ?? []).some(id => decisions.get(id) === "rejected")) continue;
    if (action.type === "draftCreate" && action.draft.logicalId === logicalId) {
      current = {
        ...action.draft,
        ...(current?.providerId !== undefined ? {providerId: current.providerId} : {}),
        ...(current?.messageId !== undefined ? {messageId: current.messageId} : {}),
        ...(current?.threadId !== undefined ? {threadId: current.threadId} : {}),
      };
    } else if (action.type === "draftUpdate" && action.draftId === logicalId && current) {
      current = {
        ...action.after,
        ...(current.providerId !== undefined ? {providerId: current.providerId} : {}),
        ...(current.messageId !== undefined ? {messageId: current.messageId} : {}),
        ...(current.threadId !== undefined ? {threadId: current.threadId} : {}),
      };
    } else if ((action.type === "draftDelete" || action.type === "draftSend") &&
        action.draftId === logicalId) {
      current = undefined;
    }
  }
  return current ?? null;
}

const MUTABLE_SYSTEM_LABELS = new Set<GmailMutableSystemLabel>([
  "INBOX", "TRASH", "SPAM", "UNREAD", "STARRED", "IMPORTANT",
  "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES", "CATEGORY_FORUMS",
]);

export type CanonicalMutableLabel = GmailCustomLabel | {
  id: GmailMutableSystemLabel;
  name: GmailMutableSystemLabel;
  type: "system";
};

/** Resolve an untrusted RPC label object solely through account/binding-owned records. */
export function canonicalizeGmailMutableLabel(
    candidate: unknown, providerLabels: readonly GmailLabelRaw[],
    localLabels: readonly GmailLabelResource[]): CanonicalMutableLabel {
  if (!candidate || typeof candidate !== "object") throw new Error("Invalid Gmail label object.");
  const value = candidate as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.name !== "string" ||
      (value.type !== "system" && value.type !== "custom")) {
    throw new Error("Invalid Gmail label object.");
  }

  if (value.type === "system") {
    if (value.id !== value.name || !MUTABLE_SYSTEM_LABELS.has(value.id as GmailMutableSystemLabel)) {
      throw new Error("This Gmail system label is not mutable or has inconsistent identity.");
    }
    const provider = providerLabels.find(label => label.id === value.id && label.type === "system");
    if (!provider || provider.name !== value.name) throw new Error("Gmail system label was not found.");
    return {id: value.id as GmailMutableSystemLabel, name: value.id as GmailMutableSystemLabel, type: "system"};
  }

  const local = localLabels.find(label => label.logicalId === value.id);
  if (local) {
    if (local.status !== "active") throw new Error("This provisional Gmail label is no longer valid.");
    if (local.providerId) {
      const provider = providerLabels.find(
        label => label.id === local.providerId && label.type === "user");
      if (!provider) throw new Error("Custom Gmail label was not found in this account.");
      return {id: local.logicalId, name: provider.name, type: "custom"};
    }
    return {id: local.logicalId, name: local.name, type: "custom"};
  }
  const provider = providerLabels.find(label => label.id === value.id && label.type === "user");
  if (!provider) throw new Error("Custom Gmail label was not found in this account.");
  return {id: provider.id, name: provider.name, type: "custom"};
}

/** Merge provider labels with pending creates/renames/deletes and stable logical IDs. */
export function overlayGmailLabels(
    providerLabels: readonly GmailLabelRaw[], resources: readonly GmailLabelResource[],
    pending: readonly PendingOverlayAction<GmailLabelOverlayAction>[],
    decisions: ReadonlyMap<number, GmailDecision> = new Map()): GmailLabelRaw[] {
  const byId = new Map<string, GmailLabelRaw>();
  const providerToResource = new Map(
    resources.filter(item => item.providerId).map(item => [item.providerId!, item]));
  for (const label of providerLabels) {
    const resource = providerToResource.get(label.id);
    if (resource?.status === "deleted" || resource?.status === "rejected") continue;
    byId.set(resource?.logicalId ?? label.id, {
      ...label,
      id: resource?.logicalId ?? label.id,
      name: label.name,
    });
  }
  // Keep a still-provisional logical label visible before Gmail has assigned its provider ID.
  for (const resource of resources) {
    if (resource.status === "active" && !resource.providerId && !byId.has(resource.logicalId)) {
      byId.set(resource.logicalId, {
        id: resource.logicalId,
        name: resource.name,
        type: "user",
      });
    }
  }
  for (const {action} of pending) {
    if ((action.dependsOn ?? []).some(id => decisions.get(id) === "rejected")) continue;
    if (action.type === "labelCreate") {
      byId.set(action.label.logicalId, {
        id: action.label.logicalId, name: action.label.name, type: "user",
      });
    } else if (action.type === "labelRename") {
      const label = byId.get(action.labelId);
      if (label) byId.set(action.labelId, {...label, name: action.name});
    } else if (action.type === "labelDelete") {
      byId.delete(action.labelId);
    }
  }
  return [...byId.values()];
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, "");
  const binary = atob(normalized);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function normalizeDraftBody(value: string): string {
  return value.replace(/\r\n|\r|\n/g, "\r\n");
}

function canonicalMailbox(value: string): {address: string; name: string | null} {
  const mailbox = emailRecipientToAddress(value);
  const name = mailbox.name?.normalize("NFC").replace(/\s+/g, " ").trim();
  return {
    address: mailbox.address.toLowerCase(),
    name: name || null,
  };
}

function canonicalMailboxes(values: readonly string[]): Array<ReturnType<typeof canonicalMailbox>> {
  return values.map(canonicalMailbox);
}

/** Fingerprint only send-relevant semantics, including attachment bytes, to detect unsafe drift. */
export async function gmailDraftFingerprint(
    draft: GmailParsedDraft, threadId?: string): Promise<string> {
  const attachmentDigests = await Promise.all(draft.attachments.map(async attachment => ({
    filename: attachment.filename || null,
    contentType: attachment.contentType,
    disposition: attachment.disposition ?? null,
    contentId: attachment.contentId ?? null,
    digest: await sha256(decodeBase64(attachment.data)),
  })));
  const stable = JSON.stringify({
    from: draft.from === undefined ? null : canonicalMailbox(draft.from),
    replyTo: canonicalMailboxes(draft.replyTo),
    to: canonicalMailboxes(draft.to),
    cc: canonicalMailboxes(draft.cc),
    bcc: canonicalMailboxes(draft.bcc),
    date: draft.date ?? null,
    subject: draft.subject,
    text: normalizeDraftBody(draft.text),
    html: draft.html === undefined ? null : normalizeDraftBody(draft.html),
    messageId: draft.messageId ?? null,
    inReplyTo: draft.inReplyTo ?? null,
    references: draft.references ?? null,
    threadId: draft.inReplyTo ? threadId ?? null : null,
    attachments: attachmentDigests,
  });
  return sha256(new TextEncoder().encode(stable));
}

/** Fingerprint a simulated state using the attachment digests captured from its base snapshot. */
export async function gmailDraftStateFingerprint(draft: GmailDraftState): Promise<string> {
  if (draft.attachments.some(attachment => !attachment.contentDigest)) {
    throw new Error("Draft attachment bytes must be captured before fingerprinting.");
  }
  const stable = JSON.stringify({
    from: canonicalMailbox(draft.from),
    replyTo: canonicalMailboxes(draft.replyTo),
    to: canonicalMailboxes(draft.to),
    cc: canonicalMailboxes(draft.cc),
    bcc: canonicalMailboxes(draft.bcc),
    date: draft.date ?? null,
    subject: draft.subject,
    text: normalizeDraftBody(draft.text),
    html: draft.html === undefined ? null : normalizeDraftBody(draft.html),
    messageId: draft.rfcMessageId ?? null,
    inReplyTo: draft.inReplyTo ?? null,
    references: draft.references ?? null,
    threadId: draft.inReplyTo ? draft.threadId ?? null : null,
    attachments: draft.attachments.map(attachment => ({
      filename: attachment.info.filename || null,
      contentType: attachment.info.mimeType,
      disposition: attachment.info.disposition,
      contentId: attachment.info.contentId ?? null,
      digest: attachment.contentDigest,
    })),
  });
  return sha256(new TextEncoder().encode(stable));
}

export function newGmailLogicalId(kind: "draft" | "label"): string {
  return `provisional-${kind}-${crypto.randomUUID()}`;
}
