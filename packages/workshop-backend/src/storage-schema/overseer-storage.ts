// The Overseer Durable Object's storage schema: `makeOverseerStorage()` and the record types it
// stores.
//
// Everything a workspace persists in its Overseer is declared in this one file, so that a change
// to the stored shape of a workspace shows up as a change here. Declare new collections,
// singletons, and record types here even when the code operating on them lives in another module
// (git-store.ts, git-cache.ts, sharing.ts, agent.ts, ...). The exception is types that are also
// part of the wire API (e.g. BlueprintMetadata): those are defined in workshop-shared and stored
// as-is. Where old records still hold something the wire type has since dropped, the stored
// shape is declared here as a `Stored*` type extending it (or a `Legacy*` type, for a shape no
// longer written at all), so that readers of old data need no ad-hoc casts.
//
// This file has no runtime dependency on any other backend module, so any of them may import it
// without creating a cycle.

import type { RpcTarget } from "capnweb";
import type { RpcStub as NativeRpcStub } from "cloudflare:workers";
import type {
  AssistantMessage, TextContent, ThinkingContent, ToolCall,
} from "@earendil-works/pi-ai";
import { createTypedStorage, collection, singleton, keyString } from "@gadgets/typed-storage";
import {
  actionChangeTime,
  type ActionState, type AgentSpawnerConfig, type AiChatAuthorInfo, type AiChatMessage,
  type AiChatMetadata, type BlueprintBindingAnnotation, type BlueprintMetadata,
  type BlueprintOutput, type ChatGadgetPinRecord, type CollaboratorRole, type GadgetUpstream,
  type GatekeeperCreationSpec, type PermissionEdge, type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import type { CodeChange } from "@gadgets/workshop-shared/code-change";
import type { ChatGatewayRpcTarget } from "@gadgets/workshop-shared/external-message-gateway";
import type {
  ActionDescription, ActionKind, Gatekeeper, GitObjectType, GitOid, HookController,
  HookDescription, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { SpawnCallableOptions } from "../agent-spawner-binding";

// =======================================================================================
// Workpieces

export type GatekeeperClass = DurableObjectClass<Gatekeeper<any>>;

/**
 * A gatekeeper (connection) workpiece. IDs are allocated from the shared workpiece counter (see
 * the `nextGatekeeperId` singleton), so they never collide with gadget IDs.
 */
export type GatekeeperRecord = {
  id: WorkpieceId;
  resourceTitle?: string,   // denormalized to avoid gatekeeper query
  resourceUrl?: string;     // denormalized to avoid gatekeeper query
  hasSlashCommands?: true;  // denormalized from ResourceDescription
  class: GatekeeperClass,
  hook?: string,  // export name to which the gatekeeper's hook is connected

  /** Records how this gatekeeper was originally created, enabling blueprint metadata derivation. */
  creationSpec?: GatekeeperCreationSpec;

  /**
   * OBSOLETE: Before we had support for multiple gadgets per workspace, the binding name and
   * blueprint annotation information lived on the GatekeeperRecord. These properties continue
   * to be declared only to support migrating them away. The version 0 -> 1 migration copies
   * these into `GadgetRecord.bindings` for the default gadget. (A later migration may delete the
   * originals, or they may just be left around, but if so they are stale.)
   */
  bindingName?: string;
  blueprintAnnotation?: StoredBlueprintBindingAnnotation;
};

/**
 * A stored blueprint annotation. Those written while the UI still offered an exclusion control
 * may carry `included: false`, which keeps the binding out of blueprints. Nothing writes the
 * flag anymore, but old binding edges still hold it and collectBindingMetadata honors it.
 */
export type StoredBlueprintBindingAnnotation = BlueprintBindingAnnotation & {included?: boolean};

/**
 * The props of an agent-spawner gatekeeper's `GatekeeperRecord.class` stub. They are baked into
 * the stored stub, so this is a stored shape like any other record here: they cannot be edited
 * in place, only replaced by minting a new stub (as the version 0 -> 1 migration does).
 */
export type AgentSpawnerBindingProps = {
  /** ID of the overseer under which this agent should run. */
  overseerId: string,

  config: AgentSpawnerConfig,

  /**
   * DO ID of the user who created this binding. When agents are spawned, the model is
   * resolved from this user's account. Falls back to the gadget owner for bindings
   * created before collaborator support was added.
   */
  creatorUserId?: string,
};

/**
 * An agent-spawner config as stored before `env` became a name -> workpiece map (see
 * AgentSpawnerConfig.env): `env` was a binding-name allowlist, and its absence meant
 * "unrestricted". The version 0 -> 1 migration rewrote the configs held by gatekeeper records
 * (their `creationSpec` and AgentSpawnerBindingProps), but not the copies frozen into chats that
 * had already been spawned (see AiChatAgentContext.spawnerConfig).
 */
export type LegacyAgentSpawnerConfig = Omit<AgentSpawnerConfig, "env"> & {env?: string[]};

/**
 * A binding edge from one gadget to a target workpiece (today always a gatekeeper), stored in
 * GadgetRecord.bindings keyed by binding name.
 */
export type BindingRecord = {
  target: WorkpieceId;

  /**
   * User-provided metadata for how this binding should appear in blueprints. Absence means not
   * yet configured. This lives on the edge, not on the gatekeeper: two gadgets binding the same
   * gatekeeper can annotate it differently for their respective blueprints.
   */
  blueprintAnnotation?: StoredBlueprintBindingAnnotation;

  /**
   * Present while the binding edge is provisional: it was added within the given chat and
   * follows that chat's accept/reject lifecycle exactly like code changes and gadget creations
   * (see GadgetRecord.pending, whose stamping and crash-recovery mechanics this mirrors
   * edge-for-edge via the "changes" message's `addedBindings`). A pending edge is real in the
   * registry so the originating chat's own preview/test runs see it, but for *reads* everything
   * else (mainline loads, other chats, blueprints, "use"-role sharing) treats it as nonexistent.
   * For *writes* it still occupies its name: another chat attempting to add the same name on
   * this gadget fails with an explicit error until this chat's changes are accepted or reverted.
   */
  pending?: {chatId: number, sequence?: number};
};

/**
 * A gadget workpiece (one variant of WorkpieceRecord, below). IDs are allocated from the shared
 * workpiece counter (see the `nextGatekeeperId` singleton), so they never collide with
 * gatekeeper or worktree IDs -- in particular the facet names `gadget${id}` and
 * `gatekeeper${id}` can never collide either.
 */
export type GadgetRecord = {
  type: "gadget";
  id: WorkpieceId;
  title: string;
  created: Date;

  /**
   * The output format this gadget was built as, copied from the blueprint it was instantiated
   * from (see BlueprintMetadata.output). Absent for a gadget built from scratch, which displays as
   * a generic app. Purely descriptive: it names and draws the gadget, and confers nothing.
   */
  output?: BlueprintOutput;

  /**
   * Name of the gadget to use in the workspace's default binding list for new chats. That is, when
   * a new (normal, non-spawner) chat is started, this gadget will be available in its `env` under
   * this name from the start. The name is typically chosen at creation time (an argument to the
   * agent's createGadget tool). Gadgets which are still pending (`pending` is present) are
   * omitted from the default binding list, but still have `bindindName` set so that they claim the
   * name in the unique index, preventing awkward conflicts if two chats were to try to create the
   * same-named gadget provisionally at the same time.
   */
  bindingName: string;

  /**
   * The gadget's head commit (40-hex oid) in the workspace's git object store -- its committed
   * mainline code (see git-store.ts and the `gitObjects` collection). This field is the gadget's
   * "ref": the store itself has no ref layer. It advances only in mergeChanges(), which requires
   * the accepting chat to have already merged this commit (accepts are fast-forward only), and is
   * surfaced to clients as WorkpieceSummary.commitId.
   *
   * Invariant: **every permanent gadget has a head**; `commitId` is absent only while the gadget
   * is `pending` (its files exist only in the creating chat's proposed changes, and only that
   * chat can promote it). A gadget with no code gets an *empty-tree* initial commit -- at
   * permanent creation (createGadget with no chatId, blueprint instantiation) or synthesized by
   * the git migration -- so there is always a commit for a chat's first edit to pin, and
   * "rooted at nothing" is representable as an ordinary pin at the empty tree rather than as
   * unpinned doc content, which nothing could safely reconcile once another chat's accept moved
   * the head. Accepting a covered creation likewise always writes a first commit (an empty tree
   * when the gadget has no files yet), so promotion establishes the invariant too.
   */
  commitId?: string;

  /**
   * The blueprint this gadget follows and the release of it the gadget most recently merged.
   * Set when the gadget is instantiated from a blueprint, and by each accept of a proposal to
   * merge one into it (see AiChatMessageBody.blueprintMerges). A gadget created from scratch
   * is born with one that names no blueprint, which is how it says so.
   *
   * Absent if where the gadget came from is not known. That is so of a gadget an agent is
   * creating from a blueprint, until the creation is accepted. Otherwise it is so only of a
   * gadget made before this was recorded, and not of all of those: where the chat log still
   * told, migrateToBlueprintUpstreams() marked the ones made from scratch, and named the
   * blueprint, with no release, of the ones an agent created from one.
   *
   * The record has to name the blueprint because the release commit in the gadget's history
   * does not: a blueprint id is a share link, and release commits travel on into the packs of
   * blueprints derived from them.
   */
  upstream?: GadgetUpstream;

  /**
   * This gadget's bindings: binding name (as it appears in the gadget worker's `env`) -> binding
   * edge. Expected to stay small, so it's a map on the record rather than a separate collection.
   */
  bindings: Record<string, BindingRecord>;

  /**
   * Present while the gadget is provisional: it was created within the given chat and follows
   * that chat's accept/reject lifecycle exactly like code changes (see mergeChanges() /
   * revertChanges()). `sequence` is the chat-log sequence of the "changes" message whose
   * `createdGadgets` records the creation; it is stamped in the same transaction that persists
   * the message (the step's barrier), so the log and the registry can never disagree. An
   * unstamped record means the creating step hasn't reached its barrier yet: normally that step
   * is still running, but after a mid-step crash the record may linger -- backed by nothing,
   * since the step's message is by construction lost -- and is reaped (see
   * reconcilePendingGadgets()). The chat log is the source of truth; this record materializes
   * it so the gadget is fully functional (bindings, facet, env) before acceptance.
   */
  pending?: {chatId: number, sequence?: number};
};

/**
 * A worktree workpiece (the other variant of WorkpieceRecord): a file tree rooted at a git
 * commit, created by an agent's createWorktree tool and private to the chat that created it.
 * The agent reads and edits its files with the regular file tools -- its edits ride the chat's
 * ordinary change stream, pinned on first modification like a gadget's (see `pinBase`) -- but
 * it has no output, no bindings, no facet, and never executes. Clients see it as a
 * WorktreeSummary on build-role workpiece subscriptions (see subscribeToWorkpieces) and read its
 * content lazily, by commit and path (see listTree / readFilesAtCommit); its change-stream
 * entries and pins are delivered like a gadget's.
 */
export type WorktreeRecord = {
  type: "worktree";
  id: WorkpieceId;
  title: string;
  created: Date;

  /**
   * The chat this worktree belongs to. Permanent (never cleared): this is what keeps the
   * worktree chat-private for its whole life, independent of the `pending` lifecycle below --
   * acceptance makes the *record* permanent, not the worktree visible elsewhere. The worktree is
   * deleted with its chat.
   */
  chatId: number;

  /**
   * The gatekeeper (connection) the base commit was known from at creation time, when there was
   * one -- purely informational (pull routing uses the per-oid `gitObjectMetadata` sources, not
   * this). Absent for a worktree created from a purely local commit (e.g. gadget history).
   */
  sourceGatekeeperId?: WorkpieceId;

  /**
   * The commit the worktree was created at. Immutable.
   */
  baseCommit: string;

  /**
   * The last *explicit* commit (initially baseCommit): what the worktree API reports as HEAD and
   * what explicit commits parent on. Not advanced in this change -- the Worktree binding API's
   * commit() lands separately -- but stored from birth so the record shape is final.
   */
  headCommit: string;

  /**
   * The accepted commit (initially baseCommit): the worktree's content as of the chat's last
   * accept, and the worktree analog of a gadget's head. An unpinned worktree reads as this
   * commit's tree; the epoch's first modification -- a write, or a commit() -- pins the worktree
   * in the chat at exactly this commit (so a chat pin, when present, always has
   * `baseCommit === pinBase`), and the epoch's OT rows compose on it. Advanced only by epoch
   * resets, to the accept's auto-commit of the dirty overlay (never by explicit commits --
   * moving it mid-epoch would double-apply the still-live rows on replay). Published as
   * WorktreeSummary.pinBase: the commit the UI reads an unpinned worktree from, and the base a
   * client's pin declaration must name.
   */
  pinBase: string;

  /**
   * Never set: a worktree has no workspace-level binding name -- the name it was created under
   * lives only in its chat's binding map, so two chats can each have a worktree named `REPO`.
   * Declared (as optional-and-undefined) so the unified byBindingName index function can read
   * `record.bindingName ?? null` across the union, which also keeps the index keys of pre-v4
   * rows -- whose `type` discriminant is not yet stamped -- correct during the migration window.
   */
  bindingName?: undefined;

  /**
   * Set only between creation and the "changes" message that records it (via
   * `createdWorktrees`), which clears it in the same write: an unstamped record whose chat has
   * no active turn is a crash orphan, reaped by reconcilePendingGadgets like an unstamped
   * gadget. Unlike GadgetRecord.pending, it is never stamped for a later accept or revert to
   * decide on, because creating a worktree proposes nothing (see proposedChangeWorkpieceIds):
   * once recorded, the worktree lives as long as its chat, and a revert covering the creation
   * rolls back its content and head but never deletes it. `sequence` appears only on records
   * written before this was so; reconcilePendingGadgets promotes those.
   */
  pending?: {chatId: number, sequence?: number};
};

/**
 * The unified workpiece registry record: the `gadgets` collection (named before worktrees
 * existed) stores both variants, discriminated by `type`. One table so a WorkpieceId resolves
 * in one lookup and content-handling code can be shared; rows written before schema version 4
 * lack the discriminant on disk and are stamped `type: "gadget"` by migrateToWorkpieceTypes.
 */
export type WorkpieceRecord = GadgetRecord | WorktreeRecord;

// =======================================================================================
// Git object store

/**
 * One git loose object: `data` is the zlib-deflated object exactly as git would store it under
 * `.git/objects/xx/yyyy...`, and `oid` is its 40-hex SHA-1 name. Content-addressed, hence
 * immutable and idempotent to rewrite.
 */
export interface GitObjectRecord {
  oid: string;
  data: Uint8Array;
}

/**
 * Per-oid metadata relating a git object to gatekeepers' remotes. One row per oid with source
 * *arrays* (rather than one row per pair, the idiomatic typed-storage shape); a row may exist
 * for an object the store does not hold.
 */
export interface GitObjectMetadataRecord {
  oid: GitOid;

  /**
   * The object's type. Always known at write time: *measured* from hash-verified bytes
   * (put/consumePack, including oversize rejections), or *asserted* by the referencing context
   * that introduced the oid (a tree entry's mode, a commit's tree/parent headers, an
   * advertisement) -- which is how it can exist for objects never fetched. The two grades are
   * distinguished by `size`: measured writers always record both together, so `size !==
   * undefined` iff the type is proof-grade. Conflicting claims (always a forged object or a
   * gatekeeper bug) are reconciled by `#metaFor`: measured wins unconditionally, an assertion
   * never overrides a measured type, and among assertions "commit" wins, otherwise first claim
   * kept. Readers must never hard-reject an operation based on an assertion-grade type --
   * decode local bytes or pull first; asserted types only shape advisory pull hints.
   */
  type: GitObjectType;

  /**
   * The payload byte size. Recorded ONLY from bytes actually measured: a stored put(), or a
   * put()/pack entry rejected for exceeding MAX_GIT_OBJECT_SIZE (the content was in hand, so
   * the measurement is proof-grade and lets later reads fail fast). Never inferred from an
   * object's *absence* -- an omitted blob's size is unknowable, and an absence-based record
   * would durably trust gatekeeper behavior as if it were a measurement. Doubles as `type`'s
   * evidentiary grade (see its doc).
   */
  size?: number;

  /**
   * Gatekeepers whose remote *provably* possesses this object: entered only by a hash-verified
   * put() from that gatekeeper or by a successfully applied push to it. This is what the scoped
   * read view serves, what push ancestry verification terminates on, and what the marking walk
   * skips.
   */
  onRemote: WorkpieceId[];

  /**
   * Unproven pull-routing hints: gatekeepers that advertised this commit, or that are recorded
   * as a source, proven or not, of a stored object referencing this one. Used to route pulls
   * and to bound the marking walk; grants no reads. A wrong claim only misroutes a pull (the
   * next recorded source is tried).
   */
  pullableFrom: WorkpieceId[];

  /**
   * Queued pushes that include this object, written by the marking walk at submitAction and
   * keyed to the action (via the `byPendingPushAction` index) for cleanup. This is the read
   * grant that lets the destination gatekeeper simulate a queued push as if it had already
   * landed.
   */
  pendingPush: { gatekeeperId: WorkpieceId, actionId: number }[];
}

// =======================================================================================
// Actions and hooks

export type GatekeeperCaller = {
  from: "agent";
  chatId: number;
} | {
  from: "gadget";
  chatId?: number;

  /**
   * Which gadget made the call. Optional for backward compatibility: callers embedded in
   * ActionRecords persisted before multi-gadget support have no gadgetId. `defaultGadgetId`
   * should be assumed when `gadgetId` is absent.
   */
  gadgetId?: WorkpieceId;
} | {
  from: "user";
  chatId?: number;
} | {
  from: "hook";
};

export type ActionRecord = {
  id: number,
  gatekeeperId: WorkpieceId;
  caller: GatekeeperCaller;
  resourceTitle?: string;   // denormalized to avoid gatekeeper query
  resourceUrl?: string;     // denormalized to avoid gatekeeper query
  createdAt: Date;

  /**
   * When the record last changed state: an action's approval/rejection, a hook's enable/disable
   * toggle or deletion. Absent while nothing has happened since creation (and on legacy records
   * from before it was tracked).
   */
  appliedAt?: Date;

  state: ActionState;

  /**
   * OBSOLETE: May still be present in records written when there was only one gadget per
   * workspace. Ignore; use `resourceTitle` for display instead.
   */
  bindingName?: string;
} & ({
  type: "action";
  /**
   * Action key assigned by the gatekeeper, passed back on apply/reject/revert; or "create" for the
   * creation queued by createExternalResource, which applies via Gatekeeper.applyCreation().
   */
  action: number | "create";
  description: ActionDescription;
  resolvedBy?: AiChatAuthorInfo;  // set when resolved (approved/rejected); absent while pending (or legacy)
  autoApproved?: boolean;         // set when applied by an auto-approval rule rather than a human
} | {
  type: "observation";
  description: ObservationDescription;
} | {
  type: "bindHook";

  /** Denormalized so that the log is coherent even after the hook itself has been deleted. */
  description: HookDescription;

  /**
   * Binding a hook is treated as an action in the log for the purpose of logging that the hook
   * was created, but hooks are also independently long-lived entities that live in their own
   * table. `hookId` is a reference into the bound hooks table.
   *
   * This becomes `undefined` if the hook was later deleted.
   */
  hookId?: number;

  /** Denormalized for display purposes. */
  enabled: boolean;
});

/**
 * Key of the actions `byLastChanged` index: last state-change time, id-disambiguated because the
 * frozen clock makes same-instant records routine. Every mutation path stamps appliedAt (apply,
 * reject, stampBindHookAction); one that doesn't would be missed by the resume replay.
 */
export function actionLastChangedKey(record: ActionRecord): string {
  return `${keyString(actionChangeTime(record).valueOf())}.${keyString(record.id)}`;
}

export type BoundHookRecord = {
  id: number;
  actionId: number;
  gatekeeperId: WorkpieceId;

  /**
   * The gadget whose code this hook wakes. Bookkeeping only -- used to display which gadget a
   * hook belongs to and to delete a gadget's hooks when the gadget is deleted. Operationally the
   * `callback` already encapsulates OverseerRestoreParams pointing at the correct gadget.
   * If omitted, use `defaultGadgetId`.
   */
  gadgetId?: WorkpieceId;

  vendorId?: string;
  controller: Fetcher<HookController<RpcTarget>>;
  callback: NativeRpcStub<RpcTarget>;
  description: HookDescription;
  enabled: boolean;
};

/** A user opt-in to auto-approve actions carrying a given `actionKind` on a given gatekeeper */
export type AutoApproveTagRecord = {
  gatekeeperId: WorkpieceId;
  /**
   * The action kind (stable tag + display label, from ActionDescription.actionKind), captured when
   * the rule was enabled so the rule can be listed without showing the raw machine tag.
   */
  actionKind: ActionKind;
  /**
   * Who turned this rule on. Auto-approvals run under this user's authority, so each auto-applied
   * action is attributed to them in the audit log.
   */
  enabledBy: AiChatAuthorInfo;
};

// =======================================================================================
// Chats and agents

/**
 * Primary key of a record in a chat-scoped collection: the chat's id, then the integer
 * component(s) that identify the record within the chat, e.g. `chatKey(chatId, sequence)` for a
 * message in `chats`. Each collection keyed this way names its components where it is declared
 * in makeOverseerStorage. Keys order by each component in turn, so one also serves as a
 * `start`, `startAfter` or `end` bound when listing.
 */
export function chatKey(chatId: number, ...rest: [number, ...number[]]): string {
  return [chatId, ...rest].map(keyString).join(".");
}

/**
 * `list()` prefix selecting one chat's records in a chat-scoped collection -- or, given leading
 * key components too, the chat's records that share them, e.g. `chatKeyPrefix(chatId,
 * generation)` for one generation of `chatChanges`.
 */
export function chatKeyPrefix(chatId: number, ...leading: number[]): string {
  return [chatId, ...leading].map(keyString).join(".") + ".";
}

/**
 * A stored chat metadata row. Rows written before proposed-ness became derived (see
 * Overseer.proposedChangeWorkpieceIds) carried a cached `hasProposedChanges` flag; nothing
 * writes or reads it anymore, but old rows still hold stale values, so the stored shape admits
 * it and chatMetaForClient strips it from deliveries.
 */
export type StoredChatMetadata = AiChatMetadata & {hasProposedChanges?: boolean};

/**
 * A stored "changes" message. Those written before git-backed code storage carry the retired
 * Yjs (V2) `update` payload, which is gone from the wire type but kept on disk as rollback
 * insurance. The git-storage migration's conversion is the only reader that applies it; agent
 * replay only tests its presence, and hydrateChatMessageForClient strips it from deliveries.
 */
type StoredChangesMessage = Extract<AiChatMessage, {type: "changes"}> & {update?: Uint8Array};

/** A stored chat message: the wire type, except that "changes" messages may be legacy ones. */
export type StoredChatMessage =
    Exclude<AiChatMessage, {type: "changes"}> | StoredChangesMessage;

/** Additional per-chat-thread info needed by the AI agent but not by the client. */
export type AiChatAgentContext = {
  /** Chat ID, corresponds to `chatMeta`. */
  chatId: number;

  /**
   * If present, this chat was spawned using a spawner, and this was the spawner config at the
   * time. It is frozen, so a chat spawned before the structured env still holds the legacy
   * form, which is resolved when the chat's bindings are seeded.
   */
  spawnerConfig?: AgentSpawnerConfig | LegacyAgentSpawnerConfig;

  /**
   * If present, this chat was spawned with `spawnCallable()`, and these are the TypeScript
   * declarations of the interface the agent implements, frozen at spawn time like
   * `spawnerConfig`. Kept here rather than in the chat log so the system-prompt builder can read
   * them without a log scan and they don't render in the chat.
   */
  spawnerTypes?: SpawnCallableOptions;

  /**
   * Initial `env` binding set gathered when this chat was started, typically including all gadgets
   * and all gatekeepers which those gadgets bind to, but the contents may be different depending
   * on how the chat thread was started (e.g. agent spawners initialize env in a specific way).
   *
   * This map is frozen after the chat starts. "changes" messages in the chat log may introduce
   * new bindings, but they aren't added here; instead, the chat log must be replayed to find out
   * the current binding set.
   *
   * This is absent for chats created before named chat bindings existed; such chats are seeded
   * lazily at their next turn start.
   *
   * If any workpieces referenced here are deleted, this will be detected when the env is
   * materialized for a particular execution, and the corresponding bindings will be dropped.
   */
  bindings?: Record<string, WorkpieceId>;

  /**
   * Gatekeeper IDs for ambient capsules which were instantiated into this chat when it started.
   * This array predates the creation of per-chat named bindings; back then, ambient gatekeepers
   * were delivered as numbered "capsules", occupying the lowest numbers in the capsules array, and
   * this array specified their order. But with the advent of per-chat named bindings, these are now
   * folded into `bindings`, above. This array continues to exist to support migrations from old
   * chats (`bindings` will be initialized on next use), and as a record of which bindings came
   * from ambient gatekeepers (though arguably some other data structure might make more sense for
   * that).
   */
  alwaysAvailableCapsuleIds?: WorkpieceId[];
};

/**
 * One entry of the chat's binding map: what a name in the agent's executeCode `env` resolves to.
 * Either a workpiece (a gadget or gatekeeper -- the overseer distinguishes at env-build time) or
 * the value arguments of an agent callback.
 */
export type ChatBindingEntry =
  | { type: "workpiece"; id: WorkpieceId }
  | { type: "value"; messageSequence: number };

/**
 * Stores replay state for one compacted chat prefix. A chat keeps every checkpoint it has
 * published, so reading history or reverting can select the newest checkpoint below any sequence.
 * The summary never changes; a revert reaching below the boundary refolds the code state (`pins`,
 * `epoch`, `proposedChange`) from the log.
 */
export type CompactionCheckpoint = {
  /** Chat this checkpoint belongs to. */
  chatId: number;

  /** First sequence replay starts at. Messages before this are represented by the checkpoint. */
  compactedTo: number;

  /** The summary the model wrote. We send it as one user message before the retained messages. */
  summary: string;

  /**
   * The chat's named bindings. Retained messages and the summary refer to these names as
   * `env.NAME`.
   */
  chatBindings: [string, ChatBindingEntry][];

  /** The next change ID for replayed tool results. Change IDs remain sequential across boundaries. */
  nextChangeId: number;

  /**
   * Historical (pre-git-storage): the workspace-wide code version the chat's retired Yjs replay
   * base was anchored to. Survives only as stored data on checkpoints written before the
   * git-storage conversion (the migration's conversion anchor reads it); new checkpoints never
   * record it, and replay ignores it (pre-conversion reads are elided).
   */
  observedCodeVersion?: number;

  /**
   * The pins active at the boundary: each gadget's last surviving declaration before it (see
   * ChatGadgetPinRecord). Replay establishes their base trees before applying `proposedChange`.
   */
  pins?: ChatGadgetPinRecord[];

  /**
   * Sequence of the message that opened the epoch the boundary lies in, mirroring
   * ChatCodeBase.epoch; absent when the boundary is in the chat's first epoch.
   */
  epoch?: number;

  /**
   * Historical (pre-git-storage): still-proposed and accepted Yjs updates from before the
   * boundary. Survive only as stored data on pre-conversion checkpoints, read by the migration's
   * conversion; new checkpoints record `proposedChange` instead.
   */
  acceptedChanges?: Uint8Array;
  proposedChanges?: Uint8Array;

  /**
   * Still-proposed code changes from before the boundary, composed into one change over `pins`
   * (bounded by content size, not edit history). Individual batches remain addressable through
   * the chat log, so reverting to a point before the boundary is still possible.
   *
   * This is content and nothing else: what replay applies over the pins' trees. It is absent
   * when the composition leaves nothing, which says nothing about whether the prefix proposes
   * anything. A pin can be the whole of a proposal (a merge commit, see ChatGadgetPinRecord), and
   * provisional gadget creations and binding additions are recorded by the registry rows they
   * created (`GadgetRecord.pending`, `BindingRecord.pending`), untouched by compaction. What a
   * chat proposes is read from that state, never from this (see mergeChanges).
   */
  proposedChange?: CodeChange;
};

/**
 * Server-only record describing an in-progress agent turn, enabling resumption after a server
 * restart. Keyed by chatId. A record is present (mirroring `chatMeta.activeAgent`) for exactly as
 * long as an agent turn is, or should be, running. On startup, the set of these records identifies
 * which agents were interrupted by a restart and need to be resumed.
 *
 * Note we deliberately do NOT store the resolved `AiModelConfig` here, because it contains a secret
 * API token. Instead we store enough to re-fetch it from the initiator's user DO on resume.
 */
export type ActiveAgentRecord = {
  chatId: number;
  /**
   * Hex durable object ID of the initiator's user DO, used to re-resolve the model config and for
   * billing.
   */
  initiatorUserId: string;
  /** Model ID, used to re-resolve the model config (matches `chatMeta.activeAgent.id`). */
  modelId: string;
  /** Who initiated this turn (a user, or a gadget for spawner/callback turns). */
  initiator: AiChatAuthorInfo;
  /** Whether this turn was initiated by a gadget callback (vs. a chat message). */
  callbackInitiated: boolean;
};

/**
 * A tool-call block as persisted in a StoredAssistantMessage: everything pi produced except the
 * arguments, which the step's AiToolCall record already stores (as `input`) and which replay
 * rehydrates by id (see rehydrateStoredAssistantMessage). Tool arguments are the one genuinely
 * large duplicate (writeFile/executeCode payloads are whole files); everything else is kept.
 */
export type StoredToolCall = Omit<ToolCall, "arguments">;

/**
 * The AssistantMessage for one agent step, persisted exactly as pi produced it (except for
 * StoredToolCall's deliberate subtraction) so later turns can replay the step verbatim. This is
 * what preserves reasoning across turns and restarts: thinking blocks keep their provider
 * signatures (including encrypted/redacted payloads), and the message keeps its true
 * api/provider/model provenance, so pi's transformMessages can reflect same-model reasoning back
 * to the provider and apply its cross-model conversions when the user switches models. The
 * snapshot is subtractive on purpose -- copy everything, delete only what's provably redundant --
 * so fields pi adds in the future are retained by default (dropping them would silently reduce
 * fidelity and break prompt caching). Stored server-side only (see `chatModelData`
 * below); clients never receive these.
 */
export type StoredAssistantMessage = Omit<AssistantMessage, "content"> & {
  content: (TextContent | ThinkingContent | StoredToolCall)[];
};

// One agent step's model-facing snapshot (see StoredAssistantMessage), keyed by the
// chatId.sequence of the step's "message" record.
type ChatModelDataRecord = {
  chatId: number;
  sequence: number;
  message: StoredAssistantMessage;
};

// A call made on a callable agent (the `self` object or a spawnCallable() stub) that has not yet
// been appended to its chat log. See the `pendingAgentCalls` collection.
type PendingAgentCallRecord = {
  chatId: number;
  callId: number;             // from the nextAgentCallId singleton; the key is chatId.callId
  methodName: string;
  args: unknown[];            // must be storable: any RPC stubs among them are persistent stubs
  argsSummary: string;        // depth-limited summary string (see summarizeArgs)
  initiatorUserId: string;    // hex durable object ID of user DO
  initiatorModelId: string | null;  // null when the spawner has no model (see spawnAgent)
};

/**
 * External message gateways pass a response target when submitting a prompt. While the agent turn is
 * in progress, `waiting` records persist that target across DO eviction/restart; once response
 * text is known, `ready` records retry delivery until acknowledged; `delivered` records are
 * retained briefly so retries of the same external message remain idempotent.
 */
export type ExternalMessageRecord = {
  /** Namespaced external message key used to dedupe retries of the same submission. */
  idempotencyKey: string;
  chatId: number;
  /**
   * Chat log sequence number of the external prompt. The target sends the latest agent/error
   * response after this sequence, stopping before the next user message.
   */
  promptSequence: number;
  createdAt: number;
} & (
  | {
      status: "waiting";
      chatGatewayRpcTarget: NativeRpcStub<ChatGatewayRpcTarget>;
    }
  | {
      status: "ready";
      chatGatewayRpcTarget: NativeRpcStub<ChatGatewayRpcTarget>;
      responseText: string;
    }
  | {
      status: "delivered";
      deliveredAt: number;
    }
);

export type ExternalChatRecord = {
  externalChatKey: string;
  chatId: number;
};

type ChatAttachmentContentRecord = {
  fileId: string;
  data: Uint8Array;
  state:
    | {
        type: "staged";
        uploadedAt: number;
        mimeType: string;
        name?: string;
      }
    | {
        type: "committed";
        chatId: number;
      };
};

// =======================================================================================
// Chat code changes

/**
 * One accepted row of a chat's code-change stream: the uncommitted-changes representation (see
 * ChatCodeBase in the API). Every producer's change -- a user submitCodeChange(), an agent tool
 * edit -- becomes one row, numbered by a per-generation revision counter and broadcast to
 * subscribers as `changeApplied`. Rows are periodically
 * *materialized* into a durable "changes" message (see materializeChatChanges): the message's
 * `change` re-records their composition and its `watermark` names the rows it absorbed.
 */
export type ChatChangeRecord = {
  chatId: number;

  /**
   * The generation of the chat's change stream this row belongs to (see ChatCodeBase.generation).
   */
  generation: number;

  /** 1-based revision within `generation`; rows are contiguous by construction. */
  revision: number;

  timestamp: Date;
  author: AiChatAuthorInfo;
  change: CodeChange;

  /** The submission echo for user rows (see AiChatSubscriber.changeApplied); absent otherwise. */
  submission?: {clientId: string, seq: number};

  /**
   * Set when the row is no longer live: a "changes" message has materialized it (its change is part
   * of the message), or its generation was closed by a merge's epoch reset. Retired rows are
   * excluded from content folds and from subscribe-replay; they are retained briefly as a pure
   * transform window -- the grace buffer late submissions (including the straggler bridge)
   * transform across -- and expire lazily by age (see CHAT_CHANGE_RETIRED_TTL_MS).
   */
  retired?: true;
};

/**
 * Per (user, client editing session) submission-dedupe record (see Overseer.submitCodeChange): the
 * last accepted seq, where it landed, and a digest of the submission, updated in place at each
 * accept. Lives outside the rows so recognition survives materialization, epoch resets, and
 * destructive bumps; never pruned (an expired record would let a sufficiently delayed retry of
 * a session's first change re-apply as a fresh `seq: 1`), deleted only with the chat.
 */
type ChatChangeClientRecord = {
  chatId: number;

  /** The submitting user's User DO id: records are scoped to the authenticated user. */
  userId: string;

  /** The client-minted session token (validated against CHAT_CHANGE_CLIENT_ID_PATTERN). */
  clientId: string;

  /** The last accepted submission's seq. */
  seq: number;

  /** Where the last accepted submission landed. */
  generation: number;
  revision: number;

  /**
   * SHA-256 (64-hex) of the accepted submission's serialized content. A same-seq retry must
   * match it byte-for-byte: acknowledging different content as "already applied" would silently
   * strand a change the server never ran.
   */
  digest: string;
};

/**
 * Primary key of the dedupe record for one user's client session in a chat (see
 * ChatChangeClientRecord). It starts with chatKeyPrefix(chatId) like the other chat-scoped
 * keys, so a chat's records list under that prefix.
 */
export function chatChangeClientKey(chatId: number, userId: string, clientId: string): string {
  return `${chatKeyPrefix(chatId)}${userId}:${clientId}`;
}

/**
 * The straggler bridge's record of a chat's most recent content-preserving generation close (a
 * merge's epoch reset; see Overseer.submitCodeChange and ChatCodeBase.prior). Destructive bumps
 * delete it -- their closed stream is not bridgeable.
 */
export type ChatChangeBoundaryRecord = {
  chatId: number;

  /** The closed generation (equals ChatCodeBase.prior.generation while the bridge is open). */
  generation: number;

  /** The closed generation's terminal revision. */
  finalRevision: number;

  /**
   * Per-gadget boundary: the commit whose tree equals the gadget's chat content at the reset --
   * the merge's commit for a committed gadget, or head-at-reset for a pin that evaporated with
   * no net change while `mergedCommit` equaled head -- or null when the reset visibly changed
   * the gadget's content (bridge-ineligible; mirrored in ChatCodeBase.prior.discontinuousGadgets).
   * Bridged changes' pins derive from these commits, never from the client's declarations.
   */
  boundaries: {gadgetId: WorkpieceId, commitId: string | null}[];
};

// READ-ONLY LEGACY: one pre-git-storage live draft edit (a Yjs V2 update). Nothing writes or
// reads these anymore -- uncommitted changes are `chatChanges` rows -- but pre-conversion chats
// may still hold stored drafts, which the git-storage migration folds into each chat's conversion
// change and then deletes.
type ChatDraftUpdateRecord = {
  chatId: number;
  timestamp: Date;
  author: AiChatAuthorInfo;
  update: Uint8Array;
};

/**
 * One incremental update in the workspace-wide Yjs code log (the `code` and `snapshots`
 * collections). Formerly the public `CodeUpdate` wire type; the git-storage transition removed it
 * from the API along with `subscribeToCode()` (mainline code becomes commits; see git-store.ts),
 * leaving it as the internal record type of the retired log, whose one remaining reader is the
 * git-storage migration's replay (overseer-git-migration.ts).
 */
type CodeUpdate = {
  /** Version number of the code AFTER this update has been applied. */
  version: number;

  /** Original timestamp of this update. */
  timestamp: Date;

  /** Yjs-encoded (V2) update blob. */
  update: Uint8Array;
};

// =======================================================================================
// Sharing and observers

/** Each gadget stores its collaborator list. */
export type CollaboratorRecord = {
  /** Denormalized profile snapshot for display without hitting the user's DO. */
  profile: AiChatAuthorInfo;

  /** How this collaborator got access. Multiple edges are possible. */
  addedBy: PermissionEdge[];
};

/**
 * A share link. This is what the management UI shows and operates on, and it owns all of a link's
 * metadata. A link may have one or more keys (see ShareKeyAliasRecord): creating a link mints its
 * first key, and copying it later mints another for the same link.
 */
export type ShareLinkRecord = {
  id: string;        // HMAC-SHA-256 hex of the raw key; also the link id

  /** Never set on a link; present only on aliases, which discriminates the union. */
  alias?: never;

  note?: string;
  created: Date;
  createdBy: string; // profile.id of the creator

  /**
   * The role granted to anyone who redeems the link. Absent on links created before roles were
   * introduced; treated as "build".
   */
  role?: CollaboratorRole;

  /**
   * Soft-revocation flag. Revoking a link sets this rather than deleting the record, so that the
   * permission graph keeps its `shareKey` edges intact (no dangling references) and access could
   * be restored in the future. A revoked link contributes nothing to the permission graph and its
   * keys can no longer be redeemed.
   */
  revoked?: boolean;
};

/**
 * Another key for an existing link, minted when the user copies it. Carries no metadata of its
 * own: redeeming it resolves to the link record, so all of a link's keys behave identically.
 */
export type ShareKeyAliasRecord = {
  id: string;        // HMAC-SHA-256 hex of the raw key
  alias: string;     // id of the link this key is a copy of
};

/**
 * A row of the share keys table: either a link or a copy of one. Because a link is itself a key
 * record, keys written before copies existed are already valid links -- no migration needed.
 */
export type ShareKeyRecord = ShareLinkRecord | ShareKeyAliasRecord;

/**
 * Storage record describing a non-owner collaborator who has configured their gatekeeper accounts
 * and passed all `addObserver` checks -- i.e. is actually set up to observe data the Gadget has
 * read. This is distinct from the sharing table (which records the owner's *intent* that a user
 * have access): opening requires BOTH a reachable role in the sharing graph AND a complete
 * observer record. See observers-implementation-plan.md §3.
 */
export type ObserverRecord = {
  /** The sharing-table key for this user (their profile.id). Primary key of the collection. */
  profileId: string;

  /**
   * Random, opaque, stable-for-this-record handle passed to gatekeepers as `addObserver`'s `id`.
   * We deliberately do NOT use profileId here, to avoid tempting gatekeeper authors to parse
   * identity out of it -- identity is conveyed only via the verifier. The id need not survive
   * removal/re-add: a user who loses and regains access gets a fresh record and a fresh id.
   */
  observerId: string;

  /**
   * The account the user chose to satisfy each in-scope gatekeeper binding, remembered so they are
   * not asked again. Keyed by gatekeeper id (GatekeeperRecord.id). The accountId refers to a
   * ConnectedAccountRecord in THIS user's own User DO. An entry records only that choice -- it
   * asserts nothing about whether the gatekeeper still admits them, which every open re-checks.
   */
  accountChoices: { [gatekeeperId: number]: number };
};

// =======================================================================================
// Blueprints

/** One published version of a blueprint's code (see blueprint-release.ts). */
export type BlueprintRelease = {
  /** The blueprint's version counter at this release (`BlueprintMetadata.version`). */
  version: number;

  /** The release commit, in the workspace's git object store. */
  releaseCommit: string;

  /** The commit of the source gadget whose tree the release took. */
  sourceCommit: string;
};

/** Blueprint record stored in the Overseer DO's `blueprints` collection. */
export type BlueprintGadgetRecord = {
  id: string;
  metadata: BlueprintMetadata;

  /** Which gadget this blueprint exports. If omitted, use `defaultGadgetId`. */
  gadgetId?: WorkpieceId;

  /**
   * The commit (in the workspace's git object store) whose tree was exported into this
   * blueprint: the source of its latest release. Every record written since git-backed code
   * storage carries it (a blueprint of a gadget with no committed code cannot be created);
   * absent only on records written before, which carry `codeVersion` instead until the
   * migration converts them.
   */
  commitId?: string;

  /**
   * The blueprint's releases, oldest first: one per published version of its code, and each
   * the first parent of the next. The last is what `metadata.commitId` names.
   *
   * Absent on a record last published before releases were commits. The release it published
   * is then the snapshot release of `commitId`'s files (see `buildSnapshotRelease()`), which
   * its first entry here will have as parent.
   */
  releases?: BlueprintRelease[];

  /**
   * Legacy (pre-git-storage): version of the workspace code (from the read-only `code`
   * collection) that was exported into this blueprint. Superseded by `commitId`; retained so
   * old records stay interpretable until the migration rewrites them.
   */
  codeVersion?: number;

  /**
   * Set true before propagating to User DO / KV; cleared on success.
   * If persistently true, the UI should show a retry indicator.
   */
  dirty?: boolean;
};

// =======================================================================================
// Schema

/**
 * The Overseer's storage schema. Tests of the modules that operate on a slice of it (the git
 * store and cache, the git migration, the action log) also call this over mock storage, so they
 * exercise the real schema rather than a copy.
 */
export function makeOverseerStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    singletons: {
      // Initialized on first startup.
      ownerId: <string | undefined>undefined,

      // Version of this DO's storage schema, gating lazy migrations. Used to trigger migrations
      // at construction time.
      //   0 = Workspace from before multi-gadget mode was introduced (unless `ownerId` is absent,
      //       in which case this is a brand-new DO). The workspace contains at most one gadget,
      //       which becomes `defaultGadgetId`. (If the workspace has no code or named bindings,
      //       treat as having zero gadgets.)
      //   1 = multi-gadget: the `gadgets` registry is the source of truth; binding names and
      //       blueprint annotations live on binding edges; boundHooks/blueprints records carry a
      //       gadgetId. Additionally (added before the 0 -> 1 migration was ever deployed, so no
      //       new version was minted): gadget records carry a `bindingName` (from which chat
      //       binding-map seeds are derived), and agent-spawner configs hold the new
      //       `env: Record<name, WorkpieceId>` form (old `env?: string[]` allowlists rewritten,
      //       in both the creationSpec and the class stub's baked-in props).
      //   2 = git-backed code: mainline code lives in `gitObjects` as commits synthesized from
      //       the legacy `code` log (see overseer-git-migration.ts); gadget records carry a
      //       `commitId`, blueprint records reference commits, historical merge messages carry
      //       `commits`, and every live chat was converted to the commit-pinned change stream (a
      //       `conversionBoundary` changes message plus a `codeBase`). The `code`/`snapshots`
      //       collections are dead stored data from this version on.
      //   3 = the actions collection's indexes (pendingByGatekeeper, byHistoryFilter,
      //       byLastChanged) exist and are backfilled.
      //   4 = unified workpiece records: every row of the `gadgets` collection carries the
      //       WorkpieceRecord `type` discriminant (pre-existing rows stamped "gadget"); worktree
      //       rows may exist from here on.
      //   5 = gadgets made before gadgets recorded where they came from say so as `upstream`,
      //       where the chat log still told: those an agent created from a blueprint name it,
      //       and those created from scratch name none. Every gadget created from here on has
      //       an `upstream` once it is permanent.
      version: 0,

      // The workspace title. (Each chat, gatekeeper, and gadget has its own title, elsewhere.)
      title: "Untitled Workspace",

      // If present, this gadget was migrated from version zero, when a workspace had only one
      // gadget. Many stored records that normally contain a `gadgetId` might be missing it; they
      // should be treated as referring to this gadget ID.
      //
      // Additionally, the specified gadget ID is named specially in certain contexts:
      // - In the Yjs doc, the root name is the empty string, rather than the decimal
      //   stringification of the ID.
      // - The facet name is just "gadget", rather than "gadget<N>".
      //
      // `defaultGadgetId` is not present for new gadgets created in multi-gadget mode. It is also
      // not present for upgraded workspaces that did not have any relevant gadget content at the
      // time of upgrade.
      //
      // Aside from when it is set while auto-creating a workspace's first (only) gadget -- during
      // migration from version 0, or when instantiating a blueprint into a fresh workspace (see
      // ensureDefaultGadget) -- `defaultGadgetId` must NEVER be changed. Even if the gadget is
      // deleted, `defaultGadgetId` remains so that old records can be correctly interpreted (as
      // referring to a deleted gadget). Since it can't change after workspace initialization,
      // `defaultGadgetId` can be cached in memory after it is first read.
      defaultGadgetId: <WorkpieceId | undefined>undefined,

      // External-message Gadgets claim ownership before registering in the owner's UserDO. If that
      // registration fails, this keeps the owner-table write retryable.
      ownerRegistrationPending: false,

      codeVersion: 0,
      totalCost: 0,

      // Next workpiece ID. This is called `nextGatekeeperId` for historical reasons (it predates
      // the ability to have multiple gadgets per workspace), but it is actually used to allocate
      // workpiece IDs of any type.
      nextGatekeeperId: 0,

      nextActionId: 0,
      nextChatId: 0,
      nextHookId: 0,
      nextAgentCallId: 0,

      // OBSOLETE: deadWorktreeIds existed to facilitate hiding worktrees from clients, but we
      // no longer do that. Noted here since old workspaces may still have a singleton by this
      // name in storage.
      // deadWorktreeIds: <WorkpieceId[]>[],

      // True if any past observation was authorized that had the `containsRestrictedData` flag
      // set in its `ObservationDescription`. While set, public-web fetches are refused and every
      // action pends for manual approval (autoApprovalRule never fires); the approver checks the
      // action text for restricted data. The key on disk predates the flag's rename.
      containsRestrictedData: singleton(false, {storageKey: "prohibitAllSharing"}),

      // True if any past observation was authorized that had the `ownerInvitesOnly` flag set in
      // its `ObservationDescription`. Share links stop working and only the owner can add
      // collaborators (enforced by SharingManager).
      ownerInvitesOnly: singleton(false),

      // A random string, created on the workspace's first agent turn, that leads the
      // project-specific part of the agent's system prompt, so nobody without that prompt can
      // probe a shared prompt cache for it (see runAgentPass).
      promptCacheSalt: <string | undefined>undefined,
    },

    collections: {
      // READ-ONLY LEGACY: the pre-git-storage incremental code log, tightly-packed from version 1
      // (there's no entry for version 0, the starting empty state). Nothing writes it anymore --
      // mainline code lives in `gitObjects` as commits -- and it is read only by the git-storage
      // migration (overseer-git-migration.ts), which collapses each pre-git chat's uncommitted
      // state into a conversion change; deletion is a later cleanup change. Workspaces initialized
      // after git storage never write it at all.
      code: collection<CodeUpdate>()({
        primaryKey: "version"
      }),

      // READ-ONLY LEGACY: "snapshots" of the code log, each an encoded update "from zero",
      // formerly a replay optimization. Nothing reads or writes them anymore (the migration's
      // single replay scans `code` itself); retained as dead stored data alongside `code` for
      // one release as rollback insurance, then deleted together.
      snapshots: collection<CodeUpdate>()({
        primaryKey: "version"
      }),

      // The workspace's git object store: real git loose objects (blobs, trees, commits) keyed
      // by 40-hex SHA-1 oid. Mainline gadget code lives here as commits, with each
      // GadgetRecord.commitId pointing at its head (superseding the `code`/`snapshots` Yjs log).
      // There is deliberately no ref layer: gadget/blueprint records and chats' pinned commits
      // are the refs, and all gadgets' histories share this one content-addressed store. See
      // git-store.ts.
      gitObjects: collection<GitObjectRecord>()({
        primaryKey: "oid",
      }),

      // Per-oid provenance and push-authorization metadata over `gitObjects`: which gatekeepers'
      // remotes provably hold each object, which claim to (pull routing), and which queued
      // actions plan to push it (indexed by action id, so apply/reject can convert or clean an
      // action's marks without re-walking the object graph). Kept separate from `gitObjects`
      // because reading an object row means reading its whole content, and because metadata
      // routinely exists for objects the store does not hold. See git-cache.ts.
      gitObjectMetadata: collection<GitObjectMetadataRecord>()({
        primaryKey: "oid",
        nonUniqueIndexes: {
          // The pending-push marks index: one entry per `pendingPush` element, keyed by action
          // id, so an action's lifecycle transitions (apply-converts, reject-cleans) iterate
          // exactly its marked oids without re-walking the object graph. Being derived from the
          // record at write time, it can never disagree with the `pendingPush` arrays.
          byPendingPushAction(record: GitObjectMetadataRecord) {
            return record.pendingPush.map(entry => entry.actionId);
          },
        },
      }),

      // Registry of gadget and worktree workpieces (named before worktrees existed; see
      // WorkpieceRecord).
      //
      // Note that this collection -- not the set of Y.Doc roots -- is the enumeration source of
      // truth for which gadgets exist: content can linger in (or even be resurrected into) the
      // files root of a deleted gadget, since Yjs roots can't be deleted and whole-doc sync can't
      // stop an old client or later-merged branch from writing there. Such content is inert --
      // never listed, loaded, executed, or rendered -- because it has no registry entry.
      gadgets: collection<WorkpieceRecord>()({
        primaryKey: "id",

        uniqueIndexes: {
          // Enforces workspace-wide uniqueness of gadget binding names (see
          // GadgetRecord.bindingName): a put() that would reuse another gadget's name throws.
          // Because pending gadgets' records are real, this makes a provisional gadget reserve its
          // name from the moment of creation, exactly like pending binding edges reserve theirs.
          // Worktree rows opt out (null, the pattern the gatekeepers index uses): they carry no
          // bindingName, so two chats can each have a worktree named REPO without conflict.
          byBindingName(record: WorkpieceRecord) {
            return record.bindingName ?? null;
          }
        }
      }),

      gatekeepers: collection<GatekeeperRecord>()({
        primaryKey: "id",

        // OBSOLETE: The `bindingName` property of `GatekeeperRecord` is now obsolete, but the
        // index still exists for now. This may be cleaned up in a later migration (but doing so
        // may require support from the typed-storage package).
        uniqueIndexes: {
          byBindingName(gatekeeper: GatekeeperRecord) {
            return gatekeeper.bindingName ?? null;
          }
        }
      }),

      actions: collection<ActionRecord>()({
        primaryKey: "id",

        // All three indexes are backfilled by the version-3 migration.
        uniqueIndexes: {
          // Resume-replay index (see subscribeToActions): keyed by last state-change time so a
          // reconnect replays only the records changed during the gap.
          byLastChanged: actionLastChangedKey,
        },

        nonUniqueIndexes: {
          // Sparse index over just the pending records, keyed by gatekeeper, so the auto-approval
          // drain is O(pending on that gatekeeper) rather than a full-log scan.
          pendingByGatekeeper(record: ActionRecord) {
            return record.state === "pending" ? record.gatekeeperId : null;
          },

          // Keyed by the wire ActionHistoryFilter values, in lockstep with
          // matchesActionHistoryFilter (api.ts), so every listActions() filter is one ranged
          // read. The "all" filter has no key: it reads the collection itself.
          byHistoryFilter(record: ActionRecord) {
            return record.state === "pending" ? ["pending", record.type] : record.type;
          },
        }
      }),

      boundHooks: collection<BoundHookRecord>()({
        primaryKey: "id",
      }),

      // User-enabled rules to auto-approve actions carrying a given action kind on a given
      // gatekeeper. Presence of a record -> the rule is enabled. Keyed by
      // `${gatekeeperId}:${actionKind.tag}`.
      autoApproveTags: collection<AutoApproveTagRecord>()({
        primaryKey: (r) => `${r.gatekeeperId}:${r.actionKind.tag}`,
      }),

      chatMeta: collection<StoredChatMetadata>()({
        primaryKey: "id",

        // Allow quick lookup of chats with active agents.
        uniqueIndexes: {
          byLastActive(meta: StoredChatMetadata) { return meta.lastActive.valueOf(); }
        }
      }),

      chatContext: collection<AiChatAgentContext>()({
        primaryKey: "chatId"
      }),

      // Compaction checkpoints, keyed by `chatId.compactedTo` so a chat's checkpoints sort by
      // boundary. A chat keeps every checkpoint it has published, not just the newest: history
      // pages back through them, and a revert across a boundary refolds from the one before it
      // (see refoldChatCompactions). Only deleting the chat removes any.
      chatCompactions: collection<CompactionCheckpoint>()({
        primaryKey: (checkpoint) => chatKey(checkpoint.chatId, checkpoint.compactedTo),
      }),

      // Tracks in-progress agent turns so they can be resumed after a server restart. See
      // `ActiveAgentRecord`.
      activeAgents: collection<ActiveAgentRecord>()({
        primaryKey: "chatId"
      }),

      gadgetResponseDeliveries: collection<ExternalMessageRecord>()({
        primaryKey: "idempotencyKey",
        uniqueIndexes: {
          undeliveredByChatId(record: ExternalMessageRecord) {
            return record.status === "delivered" ? null : record.chatId;
          },
        },
        nonUniqueIndexes: {
          // Retry delivery by listing only ready records, not the whole idempotency history.
          readyByIdempotencyKey(record: ExternalMessageRecord) {
            return record.status === "ready" ? record.idempotencyKey : null;
          },
          // Sweep expired delivered records by age without scanning pending/ready records.
          deliveredByDeliveredAt(record: ExternalMessageRecord) {
            return record.status === "delivered" ? record.deliveredAt : null;
          },
        },
      }),

      externalChats: collection<ExternalChatRecord>()({
        primaryKey: "externalChatKey",
      }),

      chats: collection<StoredChatMessage>()({
        primaryKey: (msg: StoredChatMessage) => chatKey(msg.chatId, msg.sequence),
        uniqueIndexes: {
          byTimestamp(msg: StoredChatMessage) { return msg.timestamp.valueOf(); }
        }
      }),

      // READ-ONLY LEGACY: pre-git-storage live drafts. Retained only as migration input (the
      // conversion change folds them in and deletes them); nothing else reads or writes it, apart
      // from deleteChat's defensive sweep.
      chatDraftUpdates: collection<ChatDraftUpdateRecord>()({
        primaryKey: (record: ChatDraftUpdateRecord) =>
            chatKey(record.chatId, record.timestamp.valueOf()),
      }),

      // The chats' code-change streams (see ChatChangeRecord). Keyed so a generation's rows list in
      // revision order under one prefix.
      chatChanges: collection<ChatChangeRecord>()({
        primaryKey: (record: ChatChangeRecord) =>
            chatKey(record.chatId, record.generation, record.revision),
      }),

      // Per-(user, client session) submission dedupe records (see ChatChangeClientRecord). The
      // clientId's validated charset keeps the composed key unambiguous.
      chatChangeClients: collection<ChatChangeClientRecord>()({
        primaryKey: (record: ChatChangeClientRecord) =>
            chatChangeClientKey(record.chatId, record.userId, record.clientId),
      }),

      // Each chat's most recent content-preserving generation boundary, for the straggler
      // bridge (see ChatChangeBoundaryRecord). At most one per chat.
      chatChangeBoundaries: collection<ChatChangeBoundaryRecord>()({
        primaryKey: "chatId"
      }),

      nextChatSequences: collection<{chatId: number, nextSequence: number}>()({
        primaryKey: "chatId"
      }),

      // Storable version of agent callback arguments, stored separately from the chat
      // messages to avoid sending potentially large data (including Fetchers) to clients.
      // Keyed by chatId.sequence matching the agentCallback chat message.
      agentCallbackArgs: collection<{chatId: number, sequence: number, args: unknown[]}>()({
        primaryKey: (entry) => chatKey(entry.chatId, entry.sequence),
      }),

      // Calls delivered to a callable agent that have not yet been appended to its chat log.
      // Written synchronously by deliverAgentCallback so a call is durable the moment the
      // caller's RPC returns; drained into agentCallback messages (and agentCallbackArgs records)
      // by drainPendingAgentCalls at turn boundaries. Keyed by chatId.callId so a chat's calls
      // list in arrival order.
      pendingAgentCalls: collection<PendingAgentCallRecord>()({
        primaryKey: (entry) => chatKey(entry.chatId, entry.callId),
      }),

      // Model-facing snapshots of agent steps, replayed verbatim on later turns so reasoning
      // (including provider-opaque signatures) and true model provenance survive turn boundaries
      // and restarts. Stored separately from the chat messages so these payloads -- opaque and
      // potentially several KB per step -- are never sent to clients. Keyed by chatId.sequence
      // matching the step's "message" chat record.
      chatModelData: collection<ChatModelDataRecord>()({
        primaryKey: (entry: ChatModelDataRecord) => chatKey(entry.chatId, entry.sequence),
      }),

      collaborators: collection<CollaboratorRecord>()({
        primaryKey: record => record.profile.id
      }),

      // Share links and their copies; see ShareKeyRecord. The index groups a link's copies under
      // the link's id, so a GC can enumerate or drop them together (`byAlias.delete(linkId)`).
      shareKeys: collection<ShareKeyRecord>()({
        primaryKey: "id",
        nonUniqueIndexes: {
          byAlias(record: ShareKeyRecord) {
            return record.alias ?? null;
          }
        }
      }),

      blueprints: collection<BlueprintGadgetRecord>()({
        primaryKey: "id"
      }),

      // Attachment bytes. Before an attachment is committed to a chat message, this also carries
      // the temporary metadata needed to construct its ChatAttachmentRef. Once committed, the
      // message owns that metadata and this record retains only the bytes and owning chat ID.
      chatAttachmentContent: collection<ChatAttachmentContentRecord>()({
        primaryKey: "fileId",
        nonUniqueIndexes: {
          stagedByUploadedAt(record: ChatAttachmentContentRecord) {
            return record.state.type === "staged" ? record.state.uploadedAt : null;
          },
        },
      }),

      // Non-owner collaborators who have configured their gatekeeper accounts and passed all
      // `addObserver` checks. See `ObserverRecord`. The secondary index lets the forward-exclusion
      // path (`authorizeObservation`) map an opaque observerId back to a profileId.
      observers: collection<ObserverRecord>()({
        primaryKey: "profileId",
        uniqueIndexes: {
          byObserverId(observer: ObserverRecord) {
            return observer.observerId;
          }
        }
      }),
    }
  });
}

/** The Overseer's typed storage. See makeOverseerStorage. */
export type OverseerStorage = ReturnType<typeof makeOverseerStorage>;
