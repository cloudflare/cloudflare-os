// Migration of pre-git-storage workspaces: synthesizes git commits from the legacy Yjs code log.
//
// Before git-backed code storage, mainline code was a workspace-wide Yjs doc persisted as an
// incremental update log (the `code`/`snapshots` collections). This module replays that log once
// and synthesizes, per gadget, a chain of real git commits in the workspace's object store, then
// rewrites every record that referenced a code-log version to reference a commit instead:
// gadget heads (GadgetRecord.commitId), historical merge messages (their required `commits`
// field), blueprint records (codeVersion -> commitId), and live chats' code-base pins.
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
// Chats predating commit-pinned docs keep deriving their Yjs base from the retired log (see
// ChatCodeBase.legacy); the migration gives each a `codeBase` marked `legacy: true` whose
// per-gadget `mergedCommit` pins the synthesized commit at the same version its doc base
// anchors to -- what arms the accept flow's fast-forward gate (and update-from-mainline's merge
// base) for legacy chats until their first merge graduates them.
//
// The migration runs in the Overseer constructor under blockConcurrencyWhile, gated by the
// `version` singleton (see OverseerImpl.#migrateToGitStorage). It is re-runnable: object writes
// are content-addressed (recommitting identical history yields identical oids), and every record
// rewrite is deterministic from storage state, so a crashed run is simply redone.

import * as Y from "yjs";
import { keyString } from "@gadgets/typed-storage";
import type {
  AiChatMessage, ChatGadgetPin, CommitIdentity, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import type { CompactionCheckpoint } from "./agent";
import type { OverseerStorage } from "./overseer";
import { legacyChatBaseVersion } from "./agent-compaction";
import { GitStore, filesEqual } from "./git-store";
import { readDocFiles } from "./yjs-files";
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
  storage: Pick<OverseerStorage, "code" | "gadgets" | "chats" | "chatMeta" | "blueprints">;

  /** The workspace's git object store, which receives the synthesized commits. */
  gitStore: GitStore;

  /** Commit author/committer for every synthesized commit: the workspace owner's identity. */
  ownerIdentity: CommitIdentity;

  /** The workspace's default gadget, which legacy records reference by omission. */
  defaultGadgetId: WorkpieceId | undefined;

  /** Maps a gadget to its Y.Doc root name (the default gadget's is ""); see gadgetRootName. */
  gadgetRootName(id: WorkpieceId): string;

  /** The checkpoint named by the chat's `compactedTo`, for the chat's anchor computation. */
  getActiveChatCompaction(chatId: number): CompactionCheckpoint | undefined;
}

// One gadget's synthesis state: its files root, the file map and commit chain synthesized so
// far (`files` is the content of `chain`'s last entry -- the "previous synthesized commit" that
// unchanged versions are skipped against).
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

/**
 * Synthesizes commits from the legacy code log and rewrites version-pinned records to commit
 * pins (see the module comment for the full contract). Returns the number of commits written,
 * for logging. Does not bump the storage schema version; the caller owns that.
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

  // Historical merges (in any chat, including deleted gadgets' chats) and live chats' anchors.
  // Only versions actually present in the log become merge points: a merge that accepted no code
  // recorded a counter value with no code entry, and correctly backfills to `commits: []` below.
  type LegacyMergeMessage = Extract<AiChatMessage, { type: "merge" }>;
  let legacyMerges: LegacyMergeMessage[] = [];
  let chatAnchors = new Map<number, number>();
  for (let meta of Array.from(storage.chatMeta.list())) {
    if (meta.codeBase !== undefined && meta.codeBase.legacy !== true) continue;  // commit-pinned
    let messages = [...storage.chats.list({ prefix: `${keyString(meta.id)}.` })];
    for (let msg of messages) {
      if (msg.type === "merge" && msg.version !== undefined) {
        legacyMerges.push(msg);
        if (logVersions.has(msg.version)) points.add(msg.version);
      }
    }
    let anchor = legacyChatBaseVersion(host.getActiveChatCompaction(meta.id), messages);
    let resolved = floorLogVersion(anchor === "current" ? finalVersion : anchor);
    chatAnchors.set(meta.id, resolved);
    if (resolved > 0) points.add(resolved);
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
    let gadgetId = record.gadgetId ?? host.defaultGadgetId;
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
  // relies on; see GadgetRecord.commitId) and every legacy chat's anchor -- including one
  // predating the gadget's first content -- resolves to a pin (the chat's doc holds nothing
  // for the root there, and the empty tree is exactly that state; without the pin, edits to
  // such a root could never pass the accept gate once mainline moved). Pending gadgets are
  // excluded: promotion by their own chat's accept writes their first commit. Blueprint
  // resolution below likewise ignores version-0 floors, since an empty snapshot is not a
  // valid blueprint.
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

  let ydoc = new Y.Doc();
  for (let entry of storage.code.list()) {
    Y.applyUpdateV2(ydoc, entry.update);
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
  // Rewrite the version-pinned records. All writes below are synchronous, so they land
  // atomically under the output gate, after every object they reference exists.

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

  // Live legacy chats' pins: mergedCommit at the chain floor of the same version the chat's doc
  // base anchors to (so accept's fast-forward gate and update-from-mainline's merge base agree
  // with the doc the chat actually builds). No seedCommit and no seedHash: the chat's Yjs base
  // remains the legacy log (see getLegacyChatDocBase), which is exactly what the `legacy` flag
  // declares -- the chat behaves this way until its first merge graduates it. Every permanent
  // gadget has a floor (its chain is rooted at the version-0 empty commit, matching the doc's
  // empty root at anchors predating the gadget's content); only pending gadgets get no pin,
  // which reads as "nothing merged yet" everywhere pins are consumed -- accurate, since only
  // their own chat's accept can promote them.
  for (let meta of Array.from(storage.chatMeta.list())) {
    if (meta.codeBase !== undefined && meta.codeBase.legacy !== true) continue;
    let anchor = chatAnchors.get(meta.id)!;
    let pins: ChatGadgetPin[] = [];
    for (let gadget of Array.from(storage.gadgets.list())) {
      let state = tracked.get(gadget.id)!;
      let floor = chainFloor(state, anchor);
      if (floor !== undefined) {
        pins.push({ gadgetId: gadget.id, filesRoot: state.root, mergedCommit: floor.commitId });
      }
    }
    meta.codeBase = { legacy: true, generation: meta.codeBase?.generation ?? 0, gadgets: pins };
    storage.chatMeta.put(meta);
  }

  // Blueprint records: the exported snapshot's version becomes the commit whose tree is that
  // snapshot. (The chain floor's content is exactly the gadget's files at the pinned version,
  // because the resolved version was made a commit point above.)
  for (let record of Array.from(storage.blueprints.list())) {
    if (record.codeVersion === undefined || record.commitId !== undefined) continue;
    let gadgetId = record.gadgetId ?? host.defaultGadgetId;
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
