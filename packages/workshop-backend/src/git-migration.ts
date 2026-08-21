// Migration of pre-git-storage workspaces: synthesizes git commits from the legacy Yjs code log
// and converts every live chat to the commit-pinned change-stream representation.
//
// Before git-backed code storage, mainline code was a workspace-wide Yjs doc persisted as an
// incremental update log (the `code`/`snapshots` collections), and each chat's uncommitted
// changes were Yjs updates riding its "changes" messages (plus live drafts in
// `chatDraftUpdates`). This module replays that log once and synthesizes, per gadget, a chain of
// real git commits in the workspace's object store, then rewrites every record that referenced a
// code-log version to reference a commit instead: gadget heads (GadgetRecord.commitId),
// historical merge messages (their required `commits` field), and blueprint records
// (codeVersion -> commitId).
//
// The log has limited information about *why* code changed -- essentially just timestamps -- so
// commit points are chosen as:
//   - every code version recorded by a historical `merge` message (each is a moment a user
//     deliberately accepted changes -- the principled commit points);
//   - any version followed by a >= 1 hour gap in the log's timestamps, batching the keystroke
//     bursts old standalone (out-of-chat) editing wrote straight to mainline;
//   - the final version; and
//   - every persisted pinned version -- each live legacy chat's anchor (see
//     legacyChatBaseVersion) and each blueprint's exported codeVersion -- resolved to the last
//     code version at or below it, so the pinned state is exactly some commit's tree.
// Versions where a gadget's flattened files are unchanged from its previous synthesized commit
// are skipped for that gadget, so a gadget untouched by most of the log gets a short chain.
// Every permanent gadget's chain is additionally rooted at a version-0 empty-tree commit, so
// every permanent gadget leaves the migration with a head even if the log never gave it content
// (the invariant chat pinning relies on; see GadgetRecord.commitId).
//
// Each live pre-git chat is then **converted** in place (see
// AiChatMessageBody.conversionBoundary): its legacy doc -- the mainline doc at the chat's anchor
// version, plus its non-reverted "changes" updates, plus any outstanding drafts (which are then
// deleted) -- is flattened once, and its uncommitted state becomes one synthetic "changes"
// message whose `change` is the diff of that flatten against the anchor commits' trees, carrying a
// pin per touched permanent gadget ({baseCommit: anchor, mergedCommit: anchor} -- what arms the
// accept flow's fast-forward gate). Untouched gadgets get no pin (they track head live, the lazy
// semantics); gadgets still pending in the chat get their content as plain `set`s with no pin,
// like any chat-created gadget. The boundary message is written even when there is nothing to
// convert (empty change, no pins): ChatCodeBase.epoch points at it, and replay keys the elision of
// pre-conversion tool reads on it. After conversion the chat is an ordinary new-model chat; the
// pre-conversion messages keep their retired Yjs `update` bytes on disk as rollback insurance,
// but nothing can apply them (delivery strips them; see hydrateChatMessageForClient).
//
// One repair predates all of that: the multi-gadget migration (version 0 -> 1, see
// OverseerImpl.#migrateStorage) counted only *mainline* code as gadget content, so a workspace
// whose only code was proposed-but-unaccepted chat changes migrated to zero gadgets -- leaving
// that content orphaned in the legacy root "", which no gadget record owns (and which the
// conversion would otherwise silently drop, since the registry is its enumeration source of
// truth). Such content is still the workspace's implicit single gadget, so the migration
// creates its record (via the createDefaultGadget host callback) before synthesizing chains:
// the record is permanent -- several chats may propose against the same root, and each must pin
// one shared head -- gets the ordinary version-0 empty-tree root as its head, and each affected
// chat then converts like any other: pinned at the empty tree with its files as proposed sets.
//
// The migration runs in the Overseer constructor under blockConcurrencyWhile, gated by the
// `version` singleton (see OverseerImpl.#migrateToGitStorage). It is re-runnable: object writes
// are content-addressed (recommitting identical history yields identical oids), every record
// rewrite is deterministic from storage state, and all record writes (chat conversion included)
// happen in one synchronous tail, so a crashed run is simply redone. (Defensively, a chat that
// already has a codeBase is skipped: it was converted by a previous run. A re-run after the
// default gadget's creation flushed sees defaultGadgetId set and doesn't create it again.)

import * as Y from "yjs";
import { keyString } from "@gadgets/typed-storage";
import type {
  AiChatMessage, AiChatMetadata, ChatGadgetPin, ChatGadgetPinState, CommitIdentity, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent, type CodeChange } from "@gadgets/workshop-shared/code-change";
import type { CompactionCheckpoint } from "./agent";
import type { OverseerStorage } from "./overseer";
import { chatChangeStatuses, legacyChatBaseVersion } from "./agent-compaction";
import { GitStore, filesEqual } from "./git-store";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.overseer.git-migration");

/**
 * Minimum gap between consecutive code-log timestamps that ends a batch of standalone edits,
 * materializing a commit at the version before the gap. Exported for tests.
 */
export const HISTORY_COMMIT_GAP_MS = 60 * 60 * 1000;

/**
 * What the migration needs from the Overseer. Everything is expressed against the storage
 * schema and small callbacks (rather than OverseerImpl itself) so tests can drive the migration
 * over synthetic logs on mock storage.
 */
export interface GitMigrationHost {
  /** The workspace's storage. Only the listed collections are read or written. */
  storage: Pick<OverseerStorage,
      "code" | "gadgets" | "chats" | "chatMeta" | "chatDraftUpdates" | "nextChatSequences" |
      "blueprints">;

  /** The workspace's git object store, which receives the synthesized commits. */
  gitStore: GitStore;

  /** Commit author/committer for every synthesized commit: the workspace owner's identity. */
  ownerIdentity: CommitIdentity;

  /** The workspace's default gadget, which legacy records reference by omission. */
  defaultGadgetId: WorkpieceId | undefined;

  /**
   * Create the workspace's default gadget record and record it as the default gadget, returning
   * its id. Called at most once, only when `defaultGadgetId` is undefined and a live chat still
   * proposes content in the legacy root "" (see the module comment). The record is created
   * head-less: the migration roots it at the version-0 empty tree and assigns its head like any
   * other permanent gadget's, before the migration's critical section ends. After the call,
   * `gadgetRootName` must map the returned id to "".
   */
  createDefaultGadget(): WorkpieceId;

  /** Maps a gadget to its legacy Y.Doc root name (the default gadget's is ""). */
  gadgetRootName(id: WorkpieceId): string;

  /** The checkpoint named by the chat's `compactedTo`, for the chat's anchor computation. */
  getActiveChatCompaction(chatId: number): CompactionCheckpoint | undefined;

  /**
   * A unique, monotonic chat-message timestamp (the chats collection's byTimestamp index is
   * unique), for the conversion boundary messages.
   */
  getChatTimestamp(): Date;
}

// A stored pre-conversion "changes" message: the retired Yjs V2 update payload is gone from the
// wire type but still present on disk. The conversion is the only reader that *applies* it;
// delivery strips it (hydrateChatMessageForClient) and agent replay only tests its presence
// (the generic pre-conversion user-edit note).
type StoredChangesMessage = Extract<AiChatMessage, { type: "changes" }> & {
  update?: Uint8Array,
};

// One gadget's synthesis state: its legacy files root, the file map and commit chain synthesized
// so far (`files` is the content of `chain`'s last entry -- the "previous synthesized commit"
// that unchanged versions are skipped against).
type GadgetSynthesis = {
  root: string;
  files: Map<string, string>;
  chain: { version: number, commitId: string }[];
};

// The last chain entry at or below `version`, or undefined if the gadget had no commit yet.
function chainFloor(state: GadgetSynthesis, version: number)
    : { version: number, commitId: string } | undefined {
  let found: { version: number, commitId: string } | undefined;
  for (let entry of state.chain) {
    if (entry.version > version) break;
    found = entry;
  }
  return found;
}

// Read all files of one root map of a legacy code doc as a plain `name -> text` map. (Formerly
// yjs-files.ts's readDocFiles; this module is the last reader of legacy docs.)
function readDocFiles(doc: Y.Doc, rootName: string): Map<string, string> {
  let files = new Map<string, string>();
  for (let [name, text] of doc.getMap<Y.Text>(rootName)) {
    files.set(name, text.toString());
  }
  return files;
}

/**
 * Synthesizes commits from the legacy code log, rewrites version-pinned records to commit
 * references, and converts live chats (see the module comment for the full contract). Returns
 * the number of commits written, for logging. Does not bump the storage schema version; the
 * caller owns that.
 */
export async function migrateCodeLogToGit(host: GitMigrationHost): Promise<{ commits: number }> {
  let { storage, gitStore } = host;

  // ---------------------------------------------------------------------------------------
  // Inventory the log and choose commit points.

  let log: { version: number, timestamp: Date }[] = [];
  for (let entry of storage.code.list()) {
    log.push({ version: entry.version, timestamp: entry.timestamp });
  }
  let logVersions = new Set(log.map(entry => entry.version));
  let finalVersion = log[log.length - 1]?.version ?? 0;

  // The last code version at or below `version`, or 0 if none. Anchors and blueprint pins may
  // name versions with no code entry (legacy merges of creation-only batches recorded the shared
  // change counter, which also counted non-code changes), and the doc state at such a version is
  // the state at the last code entry before it -- that's the version whose tree must exist.
  let floorLogVersion = (version: number): number => {
    let found = 0;
    for (let entry of log) {
      if (entry.version > version) break;
      found = entry.version;
    }
    return found;
  };

  let points = new Set<number>();

  // Batch gaps and the final version.
  for (let i = 0; i < log.length; i++) {
    if (i === log.length - 1 ||
        log[i + 1].timestamp.getTime() - log[i].timestamp.getTime() >= HISTORY_COMMIT_GAP_MS) {
      points.add(log[i].version);
    }
  }

  // Historical merges (in any chat, including deleted gadgets' chats) and every chat's anchor.
  // Only versions actually present in the log become merge points: a merge that accepted no
  // code recorded a counter value with no code entry, and correctly backfills to `commits: []`
  // below. Already-converted chats (a defensive re-run case; see the module comment) are not
  // converted again, but their merges are still re-backfilled and their anchors still become
  // commit points -- the anchor derives from the log's version stamps, which the conversion
  // didn't touch, so a re-run chooses the same points and converges on the same chains
  // (dropping a converted chat's anchor would synthesize different commits than the ones its
  // boundary already pins).
  type LegacyMergeMessage = Extract<AiChatMessage, { type: "merge" }>;
  let legacyMerges: LegacyMergeMessage[] = [];
  let chatAnchors = new Map<number, number>();
  let defaultGadgetId = host.defaultGadgetId;
  let orphanedRootContent = false;
  for (let meta of Array.from(storage.chatMeta.list())) {
    let messages = [...storage.chats.list({ prefix: `${keyString(meta.id)}.` })];
    for (let msg of messages) {
      if (msg.type === "merge" && msg.version !== undefined) {
        legacyMerges.push(msg);
        if (logVersions.has(msg.version)) points.add(msg.version);
      }
    }
    let anchor = legacyChatBaseVersion(host.getActiveChatCompaction(meta.id), messages);
    let resolved = floorLogVersion(anchor === "current" ? finalVersion : anchor);
    if (resolved > 0) points.add(resolved);
    if (meta.codeBase === undefined) {
      chatAnchors.set(meta.id, resolved);
      if (defaultGadgetId === undefined && !orphanedRootContent) {
        orphanedRootContent = chatDocHasLegacyRootContent(storage, meta.id, messages);
      }
    }
  }

  // Recover chat content the multi-gadget migration orphaned (see the module comment): with no
  // default gadget, a live chat's content in the legacy root "" belongs to no gadget record and
  // the conversion below would drop it. Create the workspace's implicit gadget so that content
  // converts into ordinary proposed changes against its empty-tree head. (When defaultGadgetId
  // is defined but the gadget was since deleted, leftover root-"" content stays ignored, like
  // every deleted gadget's -- the user deleted that gadget.) The mainline log cannot hold
  // root-"" content here: any pre-multi-gadget mainline code would have made that migration
  // create the gadget record, so orphaned content only ever lives in chats.
  if (orphanedRootContent) {
    defaultGadgetId = host.createDefaultGadget();
  }

  // Blueprint pins. Tracks the referenced gadget even when it has since been deleted from the
  // registry: the blueprint's snapshot must remain reconstructable from its commit.
  let tracked = new Map<WorkpieceId, GadgetSynthesis>();
  let track = (id: WorkpieceId) => {
    if (!tracked.has(id)) {
      tracked.set(id, { root: host.gadgetRootName(id), files: new Map(), chain: [] });
    }
  };
  for (let gadget of storage.gadgets.list()) {
    track(gadget.id);
  }
  for (let record of storage.blueprints.list()) {
    if (record.codeVersion === undefined || record.commitId !== undefined) continue;
    let gadgetId = record.gadgetId ?? defaultGadgetId;
    if (gadgetId === undefined) continue;  // unresolvable; left as-is below
    track(gadgetId);
    let resolved = floorLogVersion(record.codeVersion);
    if (resolved > 0) points.add(resolved);
  }

  // ---------------------------------------------------------------------------------------
  // Replay the log once, synthesizing each tracked gadget's chain at the chosen points.

  let commits = 0;

  // Every permanent gadget's chain is rooted at a version-0 empty-tree commit, so every
  // permanent gadget ends the migration with a head (the invariant the chat pinning flow
  // relies on; see GadgetRecord.commitId) and every chat anchor -- including one predating the
  // gadget's first content -- resolves to a pin base (the chat's doc holds nothing for the root
  // there, and the empty tree is exactly that state; without it, edits to such a root could
  // never pass the accept gate once mainline moved). Pending gadgets are excluded: promotion by
  // their own chat's accept writes their first commit. Blueprint resolution below likewise
  // ignores version-0 floors, since an empty snapshot is not a valid blueprint.
  for (let gadget of storage.gadgets.list()) {
    if (gadget.pending) continue;
    let state = tracked.get(gadget.id)!;
    state.chain.push({
      version: 0,
      commitId: await gitStore.writeFilesAsCommit(new Map(), {
        parents: [],
        author: host.ownerIdentity,
        message: "Import pre-git history (initial empty state)",
        timestamp: gadget.created,
      }),
    });
    commits++;
  }

  // Snapshots of the mainline doc at each live chat's anchor version, captured during the same
  // replay: the conversion below rebuilds each chat's doc base from these. (Version 0 -- an
  // anchor before any code entry -- needs no snapshot; the base is the empty doc.)
  let anchorVersions = new Set(chatAnchors.values());
  let anchorStates = new Map<number, Uint8Array>();

  let ydoc = new Y.Doc();
  for (let entry of storage.code.list()) {
    Y.applyUpdateV2(ydoc, entry.update);
    if (anchorVersions.has(entry.version)) {
      anchorStates.set(entry.version, Y.encodeStateAsUpdateV2(ydoc));
    }
    if (!points.has(entry.version)) continue;
    for (let state of tracked.values()) {
      let files = readDocFiles(ydoc, state.root);
      if (filesEqual(files, state.files)) continue;
      // A chain still empty here belongs to a pending gadget or a deleted one tracked only for
      // a blueprint pin; such a gadget that has never had content gets no commit at all (an
      // empty state with no history is nothing worth recording), whereas deletions after real
      // content are history worth a commit.
      if (files.size === 0 && state.chain.length === 0) continue;
      let parent = state.chain[state.chain.length - 1];
      let commitId = await gitStore.writeFilesAsCommit(files, {
        parents: parent !== undefined ? [parent.commitId] : [],
        author: host.ownerIdentity,
        message: `Import pre-git history (code versions ${(parent?.version ?? 0) + 1}-` +
            `${entry.version})`,
        timestamp: entry.timestamp,
      });
      state.chain.push({ version: entry.version, commitId });
      state.files = files;
      commits++;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Rewrite the version-pinned records and convert the live chats. All writes below are
  // synchronous, so they land atomically under the output gate, after every object they
  // reference exists.

  // Gadget heads.
  for (let gadget of Array.from(storage.gadgets.list())) {
    let tip = tracked.get(gadget.id)!.chain[tracked.get(gadget.id)!.chain.length - 1];
    if (tip !== undefined && gadget.commitId !== tip.commitId) {
      gadget.commitId = tip.commitId;
      storage.gadgets.put(gadget);
    }
  }

  // Historical merge messages: backfill `commits` with the commits synthesized at each merge's
  // recorded version -- empty when the merge changed no code, exactly what the field means.
  for (let msg of legacyMerges) {
    msg.commits = [];
    for (let [gadgetId, state] of tracked) {
      let hit = state.chain.find(entry => entry.version === msg.version);
      if (hit !== undefined) msg.commits.push({ gadgetId, commitId: hit.commitId });
    }
    storage.chats.put(msg);
  }

  // Convert each live pre-git chat (see the module comment).
  for (let meta of Array.from(storage.chatMeta.list())) {
    let anchor = chatAnchors.get(meta.id);
    if (anchor === undefined) continue;  // already converted by a previous run
    convertLegacyChat(host, tracked, meta, anchor, anchorStates.get(anchor));
  }

  // Blueprint records: the exported snapshot's version becomes the commit whose tree is that
  // snapshot. (The chain floor's content is exactly the gadget's files at the pinned version,
  // because the resolved version was made a commit point above.)
  for (let record of Array.from(storage.blueprints.list())) {
    if (record.codeVersion === undefined || record.commitId !== undefined) continue;
    let gadgetId = record.gadgetId ?? defaultGadgetId;
    let state = gadgetId === undefined ? undefined : tracked.get(gadgetId);
    let floor = state === undefined
        ? undefined : chainFloor(state, floorLogVersion(record.codeVersion));
    if (floor === undefined || floor.version === 0) {
      // No content ever existed at that version (or the gadget is unresolvable) -- the floor is
      // at best the synthesized empty root, and an empty snapshot is not a valid blueprint
      // (instantiation refuses empty archives). Leave the legacy record; its readers keep
      // their explicit legacy errors.
      logger.warn("blueprint record has no synthesizable commit", {
        event: "storage.migration.git.blueprint.unresolved", blueprintId: record.id,
      });
      continue;
    }
    record.commitId = floor.commitId;
    delete record.codeVersion;
    storage.blueprints.put(record);
  }

  return { commits };
}

// Whether a live pre-git chat's uncommitted doc holds content in the legacy root "". Applies the
// same construction rule as convertLegacyChat (non-reverted "changes" updates plus outstanding
// drafts, which are left in place here), minus the anchor state: when the workspace has no
// default gadget the mainline log holds nothing for root "" (see the caller), so the chat's own
// updates are the root's only possible source. Size alone decides, mirroring the conversion's
// own diff-against-empty-anchor condition.
function chatDocHasLegacyRootContent(
    storage: GitMigrationHost["storage"], chatId: number, messages: AiChatMessage[]): boolean {
  let statuses = chatChangeStatuses(messages);
  let doc = new Y.Doc();
  for (let msg of messages) {
    if (msg.type !== "changes" || statuses.get(msg.sequence) === "reverted") continue;
    let update = (msg as StoredChangesMessage).update;
    if (update !== undefined) Y.applyUpdateV2(doc, update);
  }
  for (let draft of storage.chatDraftUpdates.list({ prefix: `${keyString(chatId)}.` })) {
    Y.applyUpdateV2(doc, draft.update);
  }
  return readDocFiles(doc, "").size > 0;
}

// Converts one live pre-git chat: flatten its legacy doc (anchor state + non-reverted "changes"
// updates + outstanding drafts, which are deleted), then record the flatten as a
// conversion-boundary "changes" message and the matching commit-pinned codeBase. Fully
// synchronous (see the caller's atomicity note).
function convertLegacyChat(
    host: GitMigrationHost, tracked: Map<WorkpieceId, GadgetSynthesis>, meta: AiChatMetadata,
    anchor: number, anchorState: Uint8Array | undefined): void {
  let { storage } = host;
  let messages = [...storage.chats.list({ prefix: `${keyString(meta.id)}.` })];
  let statuses = chatChangeStatuses(messages);

  // The anchor doc (the conversion diff's base) and the chat doc built on top of it. Applying
  // *merged* updates too is deliberate and harmless: a legacy merge appended the chat's updates
  // to the mainline log itself, and the anchor is at or past the merge's version (see
  // legacyChatBaseVersion), so the anchor state already contains those items and re-applying
  // them is a no-op. Reverted updates are skipped, as the legacy doc construction skipped them.
  let anchorDoc = new Y.Doc();
  let chatDoc = new Y.Doc();
  if (anchorState !== undefined) {
    Y.applyUpdateV2(anchorDoc, anchorState);
    Y.applyUpdateV2(chatDoc, anchorState);
  }
  for (let msg of messages) {
    if (msg.type !== "changes" || statuses.get(msg.sequence) === "reverted") continue;
    let update = (msg as StoredChangesMessage).update;
    if (update !== undefined) Y.applyUpdateV2(chatDoc, update);
  }

  // Outstanding drafts fold in (they are strictly newer than every message, and their keys --
  // hence this iteration -- order by timestamp), then are deleted: their content now lives in
  // the conversion change.
  for (let draft of Array.from(storage.chatDraftUpdates.list(
      { prefix: `${keyString(meta.id)}.` }))) {
    Y.applyUpdateV2(chatDoc, draft.update);
    storage.chatDraftUpdates.delete(
        `${keyString(draft.chatId)}.${keyString(draft.timestamp.valueOf())}`);
  }

  // Diff the flatten against the anchor trees, gadget by gadget. Untouched gadgets contribute
  // nothing and get no pin -- they track mainline head live. Touched permanent gadgets pin at
  // the anchor's chain floor, whose tree is exactly the anchor doc's content for that root (the
  // anchor was made a commit point). A gadget still pending in this chat gets no pin -- its
  // anchor content is empty, so its files arrive as plain `set`s, like any chat-created gadget
  // -- and a gadget pending in *another* chat is skipped outright (its files live only in that
  // chat's proposed changes; this doc holds nothing for it). Deleted gadgets' leftover roots
  // are ignored, as everywhere (the registry is the enumeration source of truth).
  let before: CodeContent = new Map();
  let after: CodeContent = new Map();
  let pins: ChatGadgetPinState[] = [];
  let carriedPending: WorkpieceId[] = [];
  for (let gadget of storage.gadgets.list()) {
    if (gadget.pending !== undefined && gadget.pending.chatId !== meta.id) continue;
    let root = host.gadgetRootName(gadget.id);
    let anchorFiles = readDocFiles(anchorDoc, root);
    let chatFiles = readDocFiles(chatDoc, root);
    if (filesEqual(anchorFiles, chatFiles)) continue;
    before.set(gadget.id, anchorFiles);
    after.set(gadget.id, chatFiles);
    if (gadget.pending === undefined) {
      let floor = chainFloor(tracked.get(gadget.id)!, anchor)!;
      pins.push({ gadgetId: gadget.id, baseCommit: floor.commitId,
                  mergedCommit: floor.commitId });
    } else if (gadget.pending.sequence !== undefined) {
      // A touched pending gadget's files now ride the boundary change, but its creation was
      // recorded by an earlier message -- a split the new model never produces (a creation's
      // files ride the message that records it) and the accept/revert lifecycle mishandles:
      // reverting at the boundary would erase the files while leaving the creation proposed,
      // stranding a permanently content-less pending gadget. So the boundary *re-records* the
      // creation (`createdGadgets` below) and the record is re-stamped to it, keeping creation
      // and content on one message. (An unstamped record is a crashed turn's tail with no
      // flushed files, hence never touched; it stays with the existing reconciliation flow.)
      carriedPending.push(gadget.id);
    }
  }
  let change: CodeChange | undefined = diffFiles(before, after);
  if (Object.keys(change).length === 0) change = undefined;

  // The boundary message is written even when the chat has nothing to convert: the boundary
  // itself is load-bearing (epoch points at it; replay keys pre-conversion elision on it). An
  // empty boundary carries no change and no pins, and proposes nothing (see foldProposedChanges).
  let sequenceRecord = storage.nextChatSequences.get(meta.id);
  let sequence = sequenceRecord?.nextSequence ?? 0;
  storage.nextChatSequences.put({ chatId: meta.id, nextSequence: sequence + 1 });
  let createdGadgets = carriedPending.map(id => {
    let gadget = storage.gadgets.get(id)!;
    return { gadgetId: id, title: gadget.title, bindingName: gadget.bindingName };
  });
  storage.chats.put({
    chatId: meta.id,
    sequence,
    timestamp: host.getChatTimestamp(),
    // Attribution is cosmetic, as on the synthesized commits: the change collapses potentially
    // many authors' edits.
    author: { type: "user", id: host.ownerIdentity.email, name: host.ownerIdentity.name },
    type: "changes",
    ...(change !== undefined ? { change } : {}),
    ...(pins.length > 0
        ? { pins: pins.map((pin): ChatGadgetPin =>
              ({ gadgetId: pin.gadgetId, baseCommit: pin.baseCommit })) }
        : {}),
    ...(createdGadgets.length > 0 ? { createdGadgets } : {}),
    conversionBoundary: true,
  });

  // Re-stamp the carried creations onto the boundary (see above): accept and revert then treat
  // creation and content as one, exactly as if the boundary had created the gadget. (The
  // original message's `createdGadgets` remains as display history; every consumer of the
  // duplicate entry is idempotent.)
  for (let id of carriedPending) {
    let gadget = storage.gadgets.get(id)!;
    gadget.pending = { chatId: meta.id, sequence };
    storage.gadgets.put(gadget);
  }

  meta.codeBase = { pins, generation: 0, epoch: sequence, revision: 0 };
  // A non-empty conversion change is a proposed change (uncommitted content survived the
  // conversion); an empty one changes nothing about the chat's proposedness (pre-conversion
  // creation-only batches may still be proposed, which the stored flag already reflects).
  if (change !== undefined) meta.hasProposedChanges = true;
  storage.chatMeta.put(meta);
}
