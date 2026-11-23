/** Approval-backed resource action declaration, submission, and resolution. */

import { createLogger } from "@gadgets/observability/logger";
import type { RpcStub } from "cloudflare:workers";
import type {
  ActionDescription,
  ActionKind,
  ApplyActionsResult,
  ApprovalQueue,
  BranchView,
  GitCache,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  ActionJournal,
  copyView,
  couldSee,
  type ActionFence,
  type JournalEntry,
  type JournalRecord,
} from "./action-journal";
import { SerialTaskQueue } from "./serial-queue";

export {
  ActionJournal,
  type ActionFence,
  type ActionJournalKv,
  type ActionJournalOptions,
  type JournalEntry,
  type JournalKeys,
  type JournalRecord,
  type RetainedActionPage,
} from "./action-journal";

/** The queue surface staging needs; a session's own approval-queue stub satisfies it. */
export type ActionSubmitter = Pick<RpcStub<ApprovalQueue>, "submitAction">;

/**
 * The queue surface a session handle needs: staging, and settling a submission an earlier
 * activation left unconfirmed (see `BoundActionSet.session()`).
 */
export type ActionSessionQueue = Pick<RpcStub<ApprovalQueue>, "submitAction" | "holdsAction">;

type ActionLogFields = {
  outcome: ResolveOutcome; vendorId: string; action: number; stranded: number; settled: number;
};

const logger = createLogger<ActionLogFields>({ component: "gatekeeper.actions" });

// Serialize submissions per journal so pruning cannot remove an in-flight staged record.
const submissions = new WeakMap<object, SerialTaskQueue>();

// The records each journal's lane is submitting right now. A staged record with a view that is not
// among them was left by an earlier activation, and a session settles it (`listUnconfirmed`).
const submitting = new WeakMap<object, Set<number>>();

// Bounds what an apply failure hands the Workshop, which stores and shows it.
const MAX_REPORTED_FAILURE = 1024;

// How long one `applyList` call keeps starting actions once it has applied one. The Workshop calls
// again with what is left, so this bounds a call's duration, not how much a list may hold.
const APPLY_LIST_BUDGET_MS = 30_000;

/**
 * Stages and submits an action for approval.
 * @param journal Durable action journal.
 * @param queue Approval queue capability.
 * @param action Action payload to store.
 * @param description Approver-facing action description.
 * @param fence Connection generation the staging operation ran under, when the action is fenced.
 * @returns The allocated action ID.
 */
export function stageAction<A>(
  journal: ActionJournal<A>,
  queue: ActionSubmitter,
  action: A,
  description: ActionDescription,
  fence?: ActionFence,
): Promise<number> {
  return stage(journal, queue, action, description, { fence });
}

// Fails a submitted action that depends on `ref`, which nothing can still resolve.
function markStranded<A>(journal: ActionJournal<A>, id: number, ref: string): void {
  journal.markFailed(id, `This action needed ${ref}, whose providing action did not complete.`,
    { undispatched: true });
}

// `unmet` names a provisional reference nothing can still resolve. Asked inside the lane, so it
// cannot race the provider's own staging, it refuses the action before allocating; asked again once
// submitted, it fails one whose provider was decided while it was staged, out of the cascade's sight.
function stage<A>(
  journal: ActionJournal<A>,
  queue: ActionSubmitter,
  action: A,
  description: ActionDescription,
  { fence, unmet, view, holds }: {
    fence?: ActionFence;
    unmet?: () => string | undefined;
    /** The view a session handle submits under, stored with the record. */
    view?: BranchView;
    /** Asks the Workshop whether it holds a submission, for one whose call failed. */
    holds?: (id: number) => Promise<boolean>;
  },
): Promise<number> {
  // Snapshotted before the lane yields, as `submit` does before `describe`.
  const staged = fence && { generation: fence.generation };
  let lane = submissions.get(journal);
  if (!lane) submissions.set(journal, lane = new SerialTaskQueue());
  let inFlight = submitting.get(journal);
  if (!inFlight) submitting.set(journal, inFlight = new Set());
  return lane.run(async () => {
    const refused = unmet?.();
    if (refused !== undefined) {
      throw new Error(`This action depends on ${refused}, which no pending action will create: the `
        + "action that was to create it was rejected or failed. Target an existing ID instead.");
    }
    const id = journal.allocate(action, staged, view);
    inFlight.add(id);
    try {
      await queue.submitAction(id, description);
    } catch (error) {
      // Rolled back only while still staged: an auto-approval can resolve the action mid-flight,
      // and a record that left "staged" proves the overseer received it -- only the reply was lost.
      if (journal.get(id)?.state === "staged") {
        // A session's submission may have been recorded with only its reply lost, and one the
        // Workshop holds is never dropped (see `ApprovalQueue.submitAction()`, rule 4). With no
        // answer either, the record stays unconfirmed, as a crash would leave it.
        const held = holds ? await holds(id).catch(() => undefined) : false;
        // Read again: an apply naming the record meanwhile confirmed it, whatever the answer.
        if (journal.get(id)?.state === "staged") {
          if (held === false) journal.rollbackSubmission(id);
          if (!held) throw error;
        }
      }
    } finally {
      inFlight.delete(id);
    }
    journal.markSubmitted(id);
    const stranded = unmet?.();
    if (stranded !== undefined) markStranded(journal, id, stranded);
    return id;
  });
}

/**
 * Marks an apply failure as terminal, safe to show, and **known** to have left no usable provider
 * effect. Dependents whose references this action was to provide are retired with it. Ordinary
 * apply errors remain retryable; in a reject handler this class has no special meaning.
 *
 * Throw `ActionOutcomeUnknownError` instead whenever the provider may have committed the effect.
 */
export class ActionApplyError extends Error {}

/**
 * Marks an apply failure as terminal with an **unknown** provider outcome: the call may already
 * have taken effect. The record is not pruned and no dependent is retired on its account -- a
 * reference it was to provide may in fact exist at the provider -- so it stays until the user
 * rejects it and the reconciliation warning survives. Rejecting it retires the dependents whose
 * references it never bound, since nothing can bind them once it is withdrawn.
 *
 * Pair it with `claimBeforeApply`. Non-replay rests on the durable claim taken *before* dispatch:
 * without one the record is still `pending` when the handler throws, so an activation that dies
 * between the provider call and this mark leaves it replayable, which is the effect the class
 * exists to prevent. Thrown from an unclaimed definition it still records the outcome, and the kit
 * logs that the guarantee was unavailable.
 *
 * This is the honest classification for a timeout, an aborted request, or any failure after the
 * provider was reached. Use `ActionApplyError` only when the effect is known absent.
 */
export class ActionOutcomeUnknownError extends Error {}

/** Message stored when a dispatched action's outcome is unknown. */
export const APPLY_OUTCOME_UNKNOWN_MESSAGE = "This action was interrupted after it was dispatched, "
  + "so it may or may not have taken effect. Check the provider before submitting it again.";

type KitOwnedField = "awaitDecision" | "autoApprovable" | "actionKind";
type ProviderOwnedField =
  | "title" | "description" | "fields" | "descriptionIsComplete" | "pushedCommits"
  | "implementsRevert";
type Unclassified = Exclude<keyof ActionDescription, KitOwnedField | ProviderOwnedField>;

/**
 * The approver-facing description for one action; policy fields come from the declaration. A field
 * added to `ActionDescription` must join one of the two classifications above, or this resolves to
 * the error object and every `describe` implementation fails to compile.
 */
export type ActionPresentation = [Unclassified] extends [never]
  ? Pick<ActionDescription, ProviderOwnedField>
  : { CLASSIFY_NEW_ActionDescription_FIELD: Unclassified };

/**
 * Durable action ID and apply-time context available to handlers. The ID is stable across retries
 * and can seed provider idempotency keys.
 */
export type ActionContext = {
  readonly id: number;
  /**
   * Action-scoped git cache the overseer handed `applyAction`; absent outside apply, and for
   * gatekeepers that pass none.
   */
  readonly gitCache?: RpcStub<GitCache>;
  /**
   * The connection fence captured at submit, when the submitter passed one. Apply already refuses
   * a record whose fence does not match the generation handed to `apply()`; a handler wanting
   * strict enforcement compares this against the `CredentialRead` its own operation runs under,
   * which also catches a reconnect landing after that entry check.
   */
  readonly fence?: ActionFence;
};

/** How one kind of action is described to the approver and carried out once approved. */
export type ActionDefinition<Payload, Host> = {
  /**
   * Sent as `ActionDescription.actionKind`. Users' auto-approval rules are stored under its tag, so
   * an existing tag is never renamed; definitions sharing a tag must share its label.
   */
  kind: ActionKind;
  /**
   * Sent as `ActionDescription.autoApprovable`: whether an action of this definition may be applied
   * without review once the user enables a rule for its `kind`. `true` is the norm; the
   * `write-gatekeeper` skill's "Action kinds and auto-approval" lists when it must be `false`. A
   * verdict that depends on the payload is sibling definitions, one `true` and one `false`, with
   * the session submitting through the one that matches.
   */
  autoApprovable: boolean;
  /** Whether pending effects are simulated or the agent must await the decision. */
  delivery: "continue-with-simulation" | "await-decision";
  /**
   * Durably claims an irreversible provider call so a crash becomes a terminal unknown outcome. A
   * plain handler error restores pending; `ActionApplyError` records a terminal failure.
   */
  claimBeforeApply?: boolean;
  /**
   * Builds approver-facing text.
   * @param payload Stored action payload.
   * @param host Bound provider host.
   * @returns The action presentation.
   */
  describe(payload: Payload, host: Host): ActionPresentation | Promise<ActionPresentation>;
  /**
   * Lists provisional references created by a payload.
   * @param payload Stored action payload.
   * @returns Created provisional references.
   */
  provides?(payload: Payload): readonly string[];
  /**
   * Lists provisional references consumed by a payload. `submit` refuses a payload naming one that
   * is neither resolved nor provided by a pending action.
   * @param payload Stored action payload.
   * @returns Consumed provisional references.
   */
  dependsOn?(payload: Payload): readonly string[];
  /**
   * Applies an approved action.
   * @param payload Stored action payload.
   * @param host Bound provider host.
   * @param ctx Durable action context.
   * @returns Optional payload updates to retain.
   */
  apply(payload: Payload, host: Host, ctx: ActionContext): Promise<void | { action?: Payload }>;
  /**
   * Releases what staging set up for an action that will never apply. Also runs when the user
   * rejects a terminal failure the apply refused *before* dispatch, whose artifacts are still
   * unreleased; a failure the handler itself raised is cleared without it, since the handler owns
   * whatever its partial effect left behind.
   *
   * Cleanup only: rejecting withdraws the action even when the provider may already hold its
   * effect, so the hook must not refuse. One that throws is logged and the action removed anyway.
   * @param payload Stored action payload.
   * @param host Bound provider host.
   * @param ctx Durable action context.
   */
  reject?(payload: Payload, host: Host, ctx: ActionContext): Promise<void>;
};

/** How a resolution ended, for cache invalidation. */
export type ResolveOutcome = "applied" | "rejected" | "failed" | "reverted";

/**
 * Whether an action's payload still means anything under a different authority.
 *
 * - `"authority"` — pin it. `submit` requires a fence, and apply refuses a record whose authority
 *   has since changed.
 * - `"none"` — the action is authority-independent, so no fence is captured or checked.
 *
 * The kit never interprets the fence, so *which* authority it names is the provider's to choose.
 * The common one is the connection generation from the `CredentialRead` the staging operation ran
 * under: `CredentialCoordinator` rotates it on `connect()` and `clear()` only, never on refresh,
 * so a same-account re-authorization trips the fence too. A provider that wants an action to
 * survive re-authorization of the same account stores its own stable account id instead and passes
 * that at apply — the comparison is opaque equality either way.
 */
export type FencePolicy = "authority" | "none";

/** Cross-cutting policy for a whole action set, as opposed to one kind's behavior. */
export type ActionSetOptions<Host, M> = {
  /**
   * The fence every kind takes unless `fenceOverrides` says otherwise. Required: a set that
   * silently defaulted to unfenced is how an action approved under one provider account comes to
   * be applied under the next one.
   */
  fence: FencePolicy;
  /** Kinds whose fence differs from the set's, named one by one so each is a decision. */
  fenceOverrides?: Partial<Record<keyof M, FencePolicy>>;
  /** Keeps applied records for revert or consumer-managed retention. */
  retainApplied?: boolean;
  /**
   * Handles a completed resolution. Failures are logged and do not change the action outcome.
   * @param host Bound provider host.
   * @param outcome Resolution outcome.
   * @returns Completion, optionally asynchronous.
   */
  afterResolve?(host: Host, outcome: ResolveOutcome): void | Promise<void>;
  /**
   * Reports whether a provisional reference from `dependsOn` has been bound to a real provider id
   * (e.g. `(host, ref) => host.provisionalIds.isResolved(ref)`). Required as soon as any
   * definition declares `dependsOn`: apply refuses to run a handler whose references are
   * unresolved instead of passing provisional strings to the provider.
   * The host is passed because the bindings are durable provider state, which lives per resource.
   * @param host Provider host this set is bound to.
   * @param ref Provisional reference the action depends on.
   * @returns Whether the reference names a real provider id.
   */
  isResolvedReference?(host: Host, ref: string): boolean;
  /** Vendor id for log attribution. */
  vendorId?: string;
  /**
   * Applies several consecutive actions of a list in one provider call (see `ActionBatch`).
   * Only `applyList` uses it; `apply(id)` always runs one action's own handler.
   */
  batch?: ActionBatch<Host, M>;
};

/** A journal entry tagged with the kind that knows how to resolve it. */
export type TaggedAction<M> = { [K in keyof M]: { kind: K; payload: M[K] } }[keyof M];

/** One action of a batch: its ID, what it carries, and the fence it was staged under. */
export type BatchedAction<M> = {
  readonly id: number;
  readonly action: TaggedAction<M>;
  readonly fence?: ActionFence;
};

/**
 * Coalesces consecutive actions of a list into one provider call, such as several document edits
 * into one batch update. Optional: without it, `applyList` runs each action's own handler.
 *
 * A batch is a run of two or more consecutive actions in the list, each of a kind in `kinds`,
 * each of which its own handler could run now: pending, fenced to the connection `applyList` was
 * given, its references resolved. An action that names a reference an earlier one in the run
 * provides ends the run, since that reference is bound only once the earlier one applies.
 * Claims are taken first when any of the batch's definitions sets `claimBeforeApply`.
 *
 * `apply` is all or nothing. Resolving applies every action in the batch. Throwing
 * `ActionOutcomeUnknownError` records every one as having an unknown outcome, and the list stops
 * at the first. Any other error says nothing landed, so the kit applies the same actions again
 * one at a time through their own handlers, which pin a failure on the action that caused it.
 */
export type ActionBatch<Host, M> = {
  /** The kinds `apply` accepts. */
  readonly kinds: readonly (keyof M)[];
  /**
   * Applies `actions`, in order, in one provider call.
   * @param actions The batch, in the list's order.
   * @param host Bound provider host.
   * @param ctx The apply-time git cache, when the Workshop passed one.
   */
  apply(
    actions: readonly BatchedAction<M>[],
    host: Host,
    ctx: { readonly gitCache?: RpcStub<GitCache> },
  ): Promise<void>;
};

/** Approval-time context the overseer hands `Gatekeeper.applyAction`. */
export type ActionApplyContext = {
  /** The action-scoped git cache stub, for handlers that touch git. */
  gitCache?: RpcStub<GitCache>;
  /**
   * The current value of whatever authority the fence carries, compared by opaque equality. For
   * the common connection fence that is `CredentialSource.read()`'s `generation`; for a provider
   * fencing on a stable account id, it is that id. Required to apply an authority-fenced record.
   */
  generation?: string;
};

/** The action set bound to one resource's journal and host. */
export type BoundActionSet<M extends Record<string, unknown>> = {
  /**
   * Submits an action for approval.
   * The payload is cloned before presentation so approval text and apply use the same value.
   * @param queue Approval queue capability.
   * @param kind Declared action kind.
   * @param payload Action payload.
   * @param options `fence` is **required** for a kind the set declares `"authority"`, and refused
   * for one declared `"none"`. For the common connection fence, pass the `CredentialRead` the
   * staging operation itself ran under — structurally an `ActionFence`, so `{ fence: read }` works
   * verbatim. Never a second read taken here, and never a shared accessor: either can move between
   * the payload's read and this call, pinning old-connection data to the new connection.
   * @returns The allocated action ID.
   */
  submit<K extends keyof M>(
    queue: ActionSubmitter,
    kind: K,
    payload: M[K],
    options?: { fence?: ActionFence },
  ): Promise<number>;
  /**
   * Applies an action, at-least-once across activations unless its definition sets
   * `claimBeforeApply`; re-applying an applied ID is a no-op. Resolution is serialized with
   * rejection to prevent a duplicate provider call. A missing definition records a terminal
   * failure so the action can still be rejected.
   * @param id Action ID to apply.
   * @param context Apply-time context from the overseer: `gitCache` is the `cache` stub
   * `applyAction(action, cache)` received (git-free gatekeepers omit it), and `generation` is the
   * account's current connection generation, required for an action submitted with a fence.
   */
  apply(id: number, context?: ActionApplyContext): Promise<void>;
  /**
   * Rejects an action, including one whose definition was removed after submission. The pending
   * actions that needed a reference only it was to provide are marked failed and left for the
   * user, as before denials reported their consequences; `rejectAction()` rejects them with it.
   * @param id Action ID to reject.
   */
  reject(id: number): Promise<void>;
  /**
   * Starts a session's use of this set: what backs `Gatekeeper.startSession()` once the
   * gatekeeper implements `applyActions()` (see `applyList`). The handle submits under `branch`
   * and reads only the pending actions visible in it, so a session cannot see another branch's
   * actions or file its own on the wrong one. Pass the view the facet was handed, without looking
   * inside it, and the queue the session keeps (its own `dup()`): the handle calls through it.
   *
   * Resolves at once, unless an earlier activation left a submission whose reply it never saw.
   * Then the first session asks the Workshop whether it holds each one (`holdsAction()`), keeps
   * those it does and deletes the rest, releasing what their staging set up through the `reject`
   * hook, before it resolves. Sessions that start meanwhile wait for the same answers, so none
   * reads or submits around an unsettled record (`ApprovalQueue.submitAction()`, rule 4). If the
   * question fails, so does this call, and the next session asks again.
   * @param queue The session's approval queue.
   * @param branch The view the facet was handed; absent means a session outside any chat.
   * @returns The session's handle.
   */
  session(queue: ActionSessionQueue, branch?: BranchView): Promise<ActionSession<M>>;
  /**
   * Applies the actions the Workshop listed, in order: what `Gatekeeper.applyActions()` delegates
   * to. Each runs through `apply`'s own path, so its definition's handler, claim, fence and
   * failure classes behave exactly as there; naming a record still waiting for its
   * `submitAction()` reply confirms it. Stops at the first action that fails and reports it:
   * `retryable` is false when the record failed terminally (`ActionApplyError`, an unknown
   * outcome, a replaced connection, a kind no longer declared), which only a rejection clears.
   * `outcomeUnknown` marks the unknown outcome, which a later call reports again without
   * dispatching it.
   *
   * An action already applied, by an earlier call whose result was lost, is reported applied
   * again, without a second provider call. One this journal does not hold is left out of the
   * result. A record with no view, from before the gatekeeper adopted branches, is applied like
   * any other. Once it has applied something, a call stops starting actions after 30 seconds and
   * returns, and the Workshop calls again with what is left.
   * @param branch The view the Workshop applies through.
   * @param actions The actions to apply, in order.
   * @param context Apply-time context, as for `apply`.
   * @returns What the call applied, and the failure that stopped it.
   */
  applyList(branch: BranchView, actions: readonly number[], context?: ActionApplyContext):
    Promise<ApplyActionsResult>;
  /**
   * Stages the actions the Workshop listed, pending on `branch`'s branch: what
   * `Gatekeeper.stageActions()` delegates to, beside `applyList`. Each record this journal holds
   * among them is restaged (`ActionJournal.restage()`), so that every view sees it, ahead of
   * every branch's actions, and a later `applyList` takes it as a staged action; naming a record
   * still waiting for its `submitAction()` reply confirms it. One it does not hold, or that is
   * staged already, is passed over, so a repeated call changes nothing.
   * @param branch The view the actions were submitted under.
   * @param actions The actions to stage.
   */
  stageList(branch: BranchView, actions: readonly number[]): Promise<void>;
  /**
   * Rejects an action and reports what that did: what `Gatekeeper.rejectAction()` delegates to
   * once the gatekeeper implements `applyActions()`. Unlike `reject`, it also rejects every
   * pending or failed action that needed a reference only this one was to provide, transitively,
   * among those whose view could see it, running each one's `reject` hook as for a rejection of
   * its own; the Workshop marks them rejected from `rejected`. `restart` is true when a session
   * was shown the action and a pending action was built on it (see `pendingAfter`), so that
   * simulated work may have relied on it.
   * @param id Action ID to reject.
   * @returns Whether sessions built on it should restart, and the other actions rejected with it.
   */
  rejectAction(id: number): Promise<ActionRejection>;
  /** @returns Action kinds eligible for automatic approval. */
  autoApprovableKinds(): ActionKind[];
  /** The retention flag in force, which the facet base's revert-hook assert reads. */
  readonly retainsApplied: boolean;
  /**
   * Reports a resolution completed outside this action set.
   * @param outcome Resolution outcome.
   */
  resolved(outcome: ResolveOutcome): Promise<void>;
  /**
   * Runs work exclusively against apply and reject. Calling either from `hook` would deadlock on the
   * same queue.
   * @param hook Work to serialize.
   * @returns The hook result.
   */
  runExclusive<T>(hook: () => T | Promise<T>): Promise<T>;
};

/**
 * One session's use of a bound action set, scoped to the view it reads through. The only way
 * session code should reach pending actions once the gatekeeper adopts branches.
 */
export type ActionSession<M extends Record<string, unknown>> = {
  /** The view this session reads through and submits under, as the facet was handed it. */
  readonly view: BranchView;
  /**
   * Submits an action under this session's view, as `BoundActionSet.submit` does through this
   * session's queue. Its `dependsOn` may name only references a pending action visible here
   * provides, or ones already resolved.
   * @param kind Declared action kind.
   * @param payload Action payload.
   * @param options `fence`, as for `BoundActionSet.submit`.
   * @returns The allocated action ID.
   */
  submit<K extends keyof M>(kind: K, payload: M[K], options?: { fence?: ActionFence }):
    Promise<number>;
  /**
   * The pending actions this session simulates, in the order to replay them: those submitted
   * before the gatekeeper adopted branches, then staged ones, then this branch's and its
   * ancestors'. Read it afresh for every read: staging changes under every chat. Replay it in this
   * order, which is not ID order (`createSimulationView` keeps it with `keepOrder: true`).
   * @returns Projected pending actions visible in this view.
   */
  pending(): JournalEntry<TaggedAction<M>>[];
  /**
   * As `pending()`, without actions an apply has claimed.
   * @returns Undecided actions visible in this view, in its order.
   */
  undecided(): JournalEntry<TaggedAction<M>>[];
};

/** What `BoundActionSet.rejectAction()` did, in the shape `Gatekeeper.rejectAction()` returns. */
export type ActionRejection = {
  /** Whether simulated work may have been built on the rejected action. */
  restart: boolean;
  /** The other actions rejected along with it, because they could not apply without it. */
  rejected: number[];
};

/** Action declarations that can be bound to a resource journal and host. */
export type ActionSet<Host, M extends Record<string, unknown>> = {
  /**
   * Binds this set once per journal. Rebinding returns the original set; changing the host throws.
   * @param journal Resource action journal.
   * @param host Provider host.
   * @returns The bound action set.
   */
  bind(journal: ActionJournal<TaggedAction<M>>, host: Host): BoundActionSet<M>;
};

// Pending action references used to find stranded dependents, with the view each was submitted
// under.
type ActionRefs = {
  id: number; view?: BranchView; provides: readonly string[]; dependsOn: readonly string[];
};

// Find actions transitively stranded by unresolved provisional references, starting from those
// `origin` provides. `isDead` prunes the walk: a reference it clears still resolves for dependents,
// however its provider ended. A dependent is stranded only through a provider its view could see:
// a reference minted on one branch means nothing on another until it is bound.
function strandedBy(
  origin: Pick<ActionRefs, "id" | "view">,
  dead: readonly string[],
  pending: readonly ActionRefs[],
  isDead: (ref: string) => boolean = () => true,
): number[] {
  const dependents = new Map<string, ActionRefs[]>();
  for (const entry of pending) {
    for (const ref of entry.dependsOn) {
      const waiting = dependents.get(ref);
      if (waiting) waiting.push(entry);
      else dependents.set(ref, [entry]);
    }
  }

  const stranded = new Set<number>();
  // Appended to while it is walked, which is how the cascade reaches dependents of dependents.
  const unresolved = dead.map(ref => ({ ref, provider: origin }));
  for (const { ref, provider } of unresolved) {
    for (const entry of dependents.get(ref) ?? []) {
      if (stranded.has(entry.id) || !couldSee(entry, provider)) continue;
      stranded.add(entry.id);
      unresolved.push(...entry.provides.filter(isDead).map(next => ({ ref: next, provider: entry })));
    }
  }
  return [...stranded];
}

/**
 * Declares a resource's action handlers. Apply is at-least-once by default; irreversible calls use
 * `claimBeforeApply`, a failure known to have left no effect uses `ActionApplyError`, and one the
 * provider may have committed uses `ActionOutcomeUnknownError`.
 * @param definitions Action handlers keyed by kind.
 * @param options Set-wide fence, retention, and resolution policy.
 * @returns An action set ready to bind.
 *
 * @example
 * ```ts
 * const declared = defineActions<VendorApi, { createTask: CreateTask }>({
 *   createTask: {
 *     kind: { tag: "create-task", label: "Create a task" },
 *     autoApprovable: true,
 *     delivery: "continue-with-simulation",
 *     claimBeforeApply: true,
 *     describe: task => ({
 *       title: `Create task "${task.title}"`,
 *       description: `Creates the task in project ${task.projectId}.`,
 *       implementsRevert: false,
 *     }),
 *     apply: (task, api) => api.createTask(task),
 *   },
 * }, { fence: "authority" });
 *
 * // Staged inside the operation that produced the payload, so the fence is that operation's own
 * // read. A second `read()` taken here could land after a reconnect and pin the old connection's
 * // data to the new one, which is why the kit cannot capture the fence for you.
 * await this.#creds.run(async (creds, read) => {
 *   const task = await api.draftTask(creds, input);
 *   return declared.bind(journal, api)
 *     .submit(queue, "createTask", task, { fence: read });
 * });
 * ```
 */
export function defineActions<Host, M extends Record<string, unknown>>(
  definitions: { [K in keyof M]: ActionDefinition<M[K], Host> },
  options: ActionSetOptions<Host, M>,
): ActionSet<Host, M> {
  const labelByTag = new Map<string, string>();
  // One entry per tag: siblings sharing one are governed as a group, and the loop below rejects a
  // tag whose siblings disagree about the label.
  const autoApprovableByTag = new Map<string, ActionKind>();
  const declared = Object.entries(definitions) as [string, ActionDefinition<unknown, Host>][];
  // The cast above is the one place the payload type is erased: TypeScript cannot correlate a
  // tagged union's payload with its definition.
  const byName = new Map(declared);
  // Mapped like `byName`, and for the same reason: a kind named after an `Object.prototype` member
  // would otherwise resolve an inherited one, reading as a policy that is neither "authority" nor
  // "none" and silently skipping the fence. `Object.entries` yields own properties only.
  const fenceByKind = new Map(Object.entries(options.fenceOverrides ?? {}));
  const fencePolicyFor = (kind: keyof M): FencePolicy =>
    fenceByKind.get(String(kind)) ?? options.fence;
  for (const [name, definition] of declared) {
    // Without it apply passes provisional strings to the provider, and the cascade's `unbound`
    // predicate reads every reference as dead. One omission, wrong in both directions.
    if (definition.dependsOn && options.isResolvedReference === undefined) {
      throw new Error(
        `Action "${name}" declares dependsOn, so the set needs isResolvedReference.`);
    }
    // The catalog advertises one label per tag, so a second spelling would put a name in the
    // approval UI that does not cover everything enabling that tag authorizes.
    const { tag, label } = definition.kind;
    const declaredLabel = labelByTag.get(tag);
    if (declaredLabel === undefined) labelByTag.set(tag, label);
    else if (declaredLabel !== label) {
      throw new Error(
        `Action tag "${tag}" is declared with two labels, "${declaredLabel}" and "${label}".`);
    }
    if (definition.autoApprovable) autoApprovableByTag.set(tag, definition.kind);
  }

  const attributed = options.vendorId ? logger.with({ vendorId: options.vendorId }) : logger;

  // See `ActionSet.bind`: rebinds return the first bound set. Only a journal rebuilt per call
  // alongside the binding escapes this, which no memoization here could see.
  const bound = new WeakMap<object, { host: Host; set: BoundActionSet<M> }>();

  return {
    /**
     * Binds this set to a journal and host.
     * @param journal Resource action journal.
     * @param host Provider host.
     * @returns The bound action set.
     */
    bind(journal, host) {
      const prior = bound.get(journal);
      if (prior) {
        if (prior.host !== host) {
          throw new Error("This journal is already bound to a different host.");
        }
        return prior.set;
      }

      // Use a Map so stale stored kinds cannot resolve inherited object members.
      const definitionFor = (entry: TaggedAction<M>) => byName.get(String(entry.kind));
      const requireGeneration = (id: number, at?: { generation?: string }): string => {
        if (at?.generation === undefined) {
          throw new Error(`Action ${id} is fenced to a connection generation; pass the current `
            + "generation to apply().");
        }
        return at.generation;
      };

      // Claims missing here were orphaned by an earlier activation and have unknown outcomes.
      const claimedHere = new Set<number>();

      // Serialize every resolution and facet operation. Submission has its own per-journal lane.
      const resolutionQueue = new SerialTaskQueue();

      // Invalidation is advisory: log failures without changing the action's outcome.
      const resolved = async (outcome: ResolveOutcome) => {
        try {
          await options.afterResolve?.(host, outcome);
        } catch (error) {
          attributed.error("afterResolve hook failed", {
            event: "actions.afterResolve.failed",
            outcome,
            error,
          });
        }
      };

      // The outstanding actions, among those `include` keeps, that transitively need a reference
      // only `id` was to provide. A staged dependent can race the scan; `stage` fails it once
      // submitted.
      const strandedFrom = (
        id: number,
        record: { action: TaggedAction<M>; view?: BranchView },
        include: (candidate: { state: string }) => boolean,
      ): number[] => {
        // A reference the provider already bound is not dead, however this action ended: apply
        // consults the same oracle before dispatching a handler, and a cascade that ignored it
        // would retire dependents whose reference demonstrably exists.
        const unbound = (ref: string) => options.isResolvedReference?.(host, ref) !== true;
        const { action } = record;
        const dead = (definitionFor(action)?.provides?.(action.payload) ?? []).filter(unbound);
        if (dead.length === 0) return [];
        // The walk itself prunes through `unbound`, so a stranded action's bound references stop
        // the cascade.
        const candidates = journal.listOutstanding().filter(entry => include(entry.record))
          .map(({ id: candidate, record: { action: pending, view } }) => {
            const definition = definitionFor(pending);
            return {
              id: candidate,
              ...(view ? { view } : {}),
              provides: definition?.provides?.(pending.payload) ?? [],
              dependsOn: definition?.dependsOn?.(pending.payload) ?? [],
            };
          });
        return strandedBy({ id, ...(record.view ? { view: record.view } : {}) }, dead, candidates,
          unbound);
      };

      // Retire dependents whose provisional references can no longer resolve.
      const strandDependents = (
        id: number,
        record: { action: TaggedAction<M>; view?: BranchView },
      ): void => {
        try {
          const stranded = strandedFrom(id, record, ({ state }) => state === "pending");
          // Undispatched: a stranded dependent never reached its handler, so its rejection still
          // owes the cleanup. The reason states only what this scan established -- the reference
          // was never bound -- rather than asserting anything about the provider call.
          for (const strandedId of stranded) {
            journal.markFailed(
              strandedId, `This action needed action ${id}, which did not complete.`,
              { undispatched: true });
          }
          if (stranded.length > 0) {
            attributed.debug("retired actions left unresolvable by a decision", {
              event: "actions.dependents.stranded",
              action: id,
              stranded: stranded.length,
            });
          }
        } catch (error) {
          attributed.error("failed to retire stranded dependents", {
            event: "actions.dependents.stranded.failed",
            action: id,
            error,
          });
        }
      };

      // Preserve orphaned claims because the provider outcome is unknown.
      const failOrphanedClaim = async (id: number): Promise<never> => {
        journal.markFailed(id, APPLY_OUTCOME_UNKNOWN_MESSAGE, { outcome: "unknown" });
        await resolved("failed");
        throw new ActionOutcomeUnknownError(APPLY_OUTCOME_UNKNOWN_MESSAGE);
      };

      const applyRecord = async (id: number, context?: ActionApplyContext): Promise<void> => {
        const record = journal.get(id);
        // Idempotent for a retry of an applied id ("applied" exists only in the retained tier;
        // retired ids are remembered durably): erroring here reports an action that succeeded as
        // failed. A record still here alongside the memory is an interrupted retire, finished now
        // so no later reject can report the executed action as rejected -- and a cleanup that
        // fails again is logged, not raised: the effect landed, the id is tombstoned, and the
        // leftover record already falls out of every scan.
        if (journal.wasApplied(id)) {
          if (record !== undefined) {
            try {
              journal.retire(id);
            } catch (error) {
              attributed.warn("failed to clear an applied action's leftover record", {
                event: "actions.retire.heal.failed",
                action: id,
                error,
              });
            }
          }
          return;
        }
        if (record?.state === "applied") return;

        if (record === undefined) throw new Error(`Unknown pending action: ${id}`);
        // A callback naming the id proves the overseer holds it: promote a record stranded
        // "staged" by a lost reply, so it projects into reads and no rollback can take it.
        journal.markSubmitted(id);
        // A terminal failure answers every later attempt with the same message, no provider call.
        if (record.state === "failed") throw new Error(record.error);
        if (record.state === "claimed" && !claimedHere.has(id)) {
          return failOrphanedClaim(id);
        }

        const action = record.action;
        const definition = definitionFor(action);
        // A kind this deploy dropped. Failing terminally stops it projecting into reads and opens
        // the reject-a-failure path below, which needs no definition. No cascade: `provides` lives
        // on the definition that went with it, so the refs are unknowable (§4.8 obligations).
        if (definition === undefined) {
          const message =
            `Action ${id} has kind "${String(action.kind)}", which this gatekeeper no longer ` +
            "supports. Reject it to clear it.";
          journal.markFailed(id, message);
          await resolved("failed");
          throw new Error(message);
        }
        // `submit` refuses an unfenced authority kind, so an unfenced record under that policy is
        // a port's: `upgradeRecord` cannot know what staged one, and applying it would pin nothing.
        const unpinned = record.fence === undefined
          ? fencePolicyFor(action.kind) === "authority"
            && "This action was submitted before this gatekeeper pinned actions to an account."
          // The early gate against the common case. A reconnect landing after it is caught only by
          // a handler comparing `ctx.fence` against its own operation's read.
          : record.fence.generation !== requireGeneration(id, context)
            && "This action was approved under a connection that has since been replaced.";
        if (unpinned) {
          const message = `${unpinned} Reject it and submit it again.`;
          journal.markFailed(id, message, { undispatched: true });
          strandDependents(id, record);
          await resolved("failed");
          throw new Error(message);
        }
        // Retryable, never terminal, and no cascade: the providing action may still apply later,
        // and the cascade owns terminal marking when it cannot. A set declaring `dependsOn` is
        // refused without a resolver, so an absent one here can only mean an empty loop.
        for (const ref of definition.dependsOn?.(action.payload) ?? []) {
          if (options.isResolvedReference?.(host, ref) === true) continue;
          throw new Error(`Action ${id} depends on ${ref}, which is not applied yet. Apply its `
            + "providing action first, or reject this action.");
        }
        try {
          let result: void | { action?: unknown };
          try {
            if (definition.claimBeforeApply) {
              journal.markClaimed(id);
              claimedHere.add(id);
            }
            result = await definition.apply(action.payload, host, {
              id,
              ...(context?.gitCache ? { gitCache: context.gitCache } : {}),
              ...(record.fence ? { fence: record.fence } : {}),
            });
          } catch (error) {
            // Three outcomes, not two. A known-empty failure is terminal and cascades; an unknown
            // one is terminal and does not, since the reference it owed may exist at the provider;
            // anything else is retryable and restores the pending claim.
            if (error instanceof ActionApplyError) {
              journal.markFailed(id, error.message);
              strandDependents(id, record);
            } else if (error instanceof ActionOutcomeUnknownError) {
              journal.markFailed(id, error.message, { outcome: "unknown" });
              if (!definition.claimBeforeApply) {
                attributed.error("unknown outcome recorded without a pre-dispatch claim", {
                  event: "actions.outcome.unclaimed",
                  action: id,
                });
              }
            } else journal.restorePending(id);
            await resolved("failed");
            throw error;
          }

          // Persist apply artifacts outside the handler catch so a failed write cannot replay the effect.
          const applied = result?.action === undefined
            ? undefined
            : { kind: action.kind, payload: result.action } as TaggedAction<M>;
          if (options.retainApplied) journal.retain(id, applied);
          else journal.retire(id);
          await resolved("applied");
        } finally {
          claimedHere.delete(id);
        }
      };

      // Withdraws a record for good, releasing what its staging set up when its handler never
      // ran. Rejecting a terminal failure is the user clearing the record: its handler already ran
      // and owns whatever it left behind. One that never reached the handler is the exception --
      // its staging artifacts are still the rejection's to release. A claim orphaned by an earlier
      // activation reached its handler with an unknown outcome, so it is cleared alike.
      const withdraw = async (id: number, record: JournalRecord<TaggedAction<M>>) => {
        const { action } = record;
        const dispatched = record.state === "failed"
          ? !record.undispatched
          : record.state === "claimed" && !claimedHere.has(id);
        try {
          if (!dispatched) {
            await definitionFor(action)?.reject?.(action.payload, host, {
              id,
              ...(record.fence ? { fence: record.fence } : {}),
            });
          }
        } catch (error) {
          // Rejecting withdraws the action whatever the provider holds, so a refusal here would
          // leave it with no way out.
          attributed.warn("reject hook failed; removing the action anyway", {
            event: "actions.reject.hook.failed",
            action: id,
            error,
          });
        }
        journal.remove(id);
      };

      // `reportsConsequences` is `rejectAction`'s: the dependents are rejected and reported rather
      // than marked failed and left for the user, and `restart` is worked out.
      const rejectRecord = async (id: number, reportsConsequences: boolean)
        : Promise<ActionRejection> => {
        const record = journal.get(id);
        // A stray reject must not take the retained record a revert hook reads back ("applied"
        // exists only in that tier), nor report success for an applied id it cannot undo: unlike
        // apply, no idempotent reading exists.
        if (record?.state === "applied" || journal.wasApplied(id)) {
          throw new Error(`Action ${id} is no longer pending.`);
        }

        if (record === undefined) return { restart: false, rejected: [] };
        // The same proof of receipt apply takes.
        journal.markSubmitted(id);
        // A staged record was never shown to a session; any other may have been, a failed one
        // before it failed. Worked out before the record leaves the tier `pendingAfter` reads.
        const restart = reportsConsequences && record.state !== "staged"
          && journal.pendingAfter(id).length > 0;

        if (!reportsConsequences) {
          await withdraw(id, record);
          // A known failure stranded its dependents when it was recorded. An unknown outcome left
          // them waiting on a reference it might still bind, which nothing can once it is
          // withdrawn.
          if (record.state !== "failed" || record.outcome === "unknown") {
            strandDependents(id, record);
          }
          await resolved("rejected");
          return { restart: false, rejected: [] };
        }
        // Failed dependents too, those an earlier cascade or a refused apply already marked: the
        // Workshop still holds them pending, and would stop at each on the way to the rest. A
        // claim is an apply that reached its handler, whose references were therefore bound.
        const rejected = strandedFrom(id, record, ({ state }) => state !== "claimed")
          .filter(dependent => dependent !== id);
        const withdrawn = [[id, record] as const, ...rejected.flatMap(dependent => {
          const stranded = journal.get(dependent);
          return stranded === undefined ? [] : [[dependent, stranded] as const];
        })];
        // Out of every read before the first hook yields, so a submission meanwhile cannot take
        // one of them for a live provider. Each hook still sees the record as it was.
        for (const [member] of withdrawn) {
          journal.markFailed(member, "This action was rejected.", { undispatched: true });
        }
        for (const [member, stored] of withdrawn) await withdraw(member, stored);
        await resolved("rejected");
        return { restart, rejected };
      };

      // A provisional reference `action` depends on that nothing can still resolve: one no
      // pending action its view can see provides.
      const unmetOf = (action: TaggedAction<M>, view?: BranchView): string | undefined => {
        const unbound = (definitionFor(action)?.dependsOn?.(action.payload) ?? [])
          .filter(ref => options.isResolvedReference?.(host, ref) !== true);
        if (unbound.length === 0) return undefined;
        const visible = view ? journal.listPendingIn(view) : journal.listPendingAcrossBranches();
        const live = new Set(visible.flatMap(({ action: pending }) =>
          definitionFor(pending)?.provides?.(pending.payload) ?? []));
        return unbound.find(ref => !live.has(ref));
      };

      // Settles the submissions an earlier activation left unconfirmed (`listUnconfirmed`), once
      // per activation, through the first session's queue; see `BoundActionSet.session`. Run as a
      // resolution, so no apply or rejection naming one interleaves with its answer.
      let recovery: Promise<void> | undefined;
      let recovered = false;
      const settleUnconfirmed = (queue: ActionSessionQueue): Promise<void> => {
        if (recovered) return Promise.resolve();
        if (recovery) return recovery;
        const scan: Promise<void> = resolutionQueue.run(async () => {
          const inFlight = submitting.get(journal);
          const unconfirmed = journal.listUnconfirmed().filter(id => !inFlight?.has(id));
          const held = await Promise.all(unconfirmed.map(id => queue.holdsAction(id)));
          for (const [i, id] of unconfirmed.entries()) {
            const record = journal.get(id);
            if (record?.state !== "staged") continue;
            if (!held[i]) {
              await withdraw(id, record);
              continue;
            }
            journal.markSubmitted(id);
            // Its provider may have been rejected meanwhile, in a cascade that passed it over.
            const stranded = unmetOf(record.action, record.view);
            if (stranded !== undefined) markStranded(journal, id, stranded);
          }
          if (unconfirmed.length > 0) {
            attributed.info("settled submissions an earlier activation left unconfirmed", {
              event: "actions.unconfirmed.settled",
              settled: unconfirmed.length,
            });
          }
        }).then(() => {
          // Unless a submission was left unconfirmed meanwhile, which this scan did not cover.
          if (recovery === scan) recovered = true;
        }, (error: unknown) => {
          // Asked again by the next session: this one fails, as it may not read meanwhile.
          if (recovery === scan) recovery = undefined;
          throw error;
        });
        return recovery = scan;
      };

      // The batch that starts at `actions[start]`, or `[]` when no batch hook takes it: a run of
      // consecutive actions of the hook's kinds whose own handlers could each run now.
      const batchAt = (actions: readonly number[], start: number, context?: ActionApplyContext)
        : { id: number; record: JournalRecord<TaggedAction<M>> }[] => {
        const batch = options.batch;
        if (batch === undefined) return [];
        const kinds = new Set(batch.kinds.map(String));
        const run: { id: number; record: JournalRecord<TaggedAction<M>> }[] = [];
        for (const id of actions.slice(start)) {
          const record = journal.get(id);
          if (record === undefined || journal.wasApplied(id)) break;
          if (record.state !== "pending" && record.state !== "staged") break;
          const definition = definitionFor(record.action);
          if (definition === undefined || !kinds.has(String(record.action.kind))) break;
          const fenced = record.fence === undefined
            ? fencePolicyFor(record.action.kind) !== "authority"
            : record.fence.generation === context?.generation;
          if (!fenced) break;
          // An earlier member's references are bound only once it applies, so naming one ends the
          // run here too.
          if ((definition.dependsOn?.(record.action.payload) ?? [])
            .some(ref => options.isResolvedReference?.(host, ref) !== true)) break;
          run.push({ id, record });
        }
        return run.length >= 2 ? run : [];
      };

      // Applies a batch through the hook. "retry" means nothing landed and its actions are to be
      // applied one at a time.
      const applyBatch = async (
        run: readonly { id: number; record: JournalRecord<TaggedAction<M>> }[],
        context?: ActionApplyContext,
      ): Promise<"applied" | "retry" | { unknown: string }> => {
        const claims = run.some(({ record }) => definitionFor(record.action)?.claimBeforeApply);
        for (const { id } of run) {
          journal.markSubmitted(id);
          if (claims) {
            journal.markClaimed(id);
            claimedHere.add(id);
          }
        }
        try {
          try {
            await options.batch!.apply(run.map(({ id, record }) => ({
              id,
              action: record.action,
              ...(record.fence ? { fence: record.fence } : {}),
            })), host, context?.gitCache ? { gitCache: context.gitCache } : {});
          } catch (error) {
            if (error instanceof ActionOutcomeUnknownError) {
              for (const { id } of run) journal.markFailed(id, error.message, { outcome: "unknown" });
              if (!claims) {
                attributed.error("unknown outcome recorded without a pre-dispatch claim", {
                  event: "actions.outcome.unclaimed",
                  action: run[0]!.id,
                });
              }
              await resolved("failed");
              return { unknown: error.message };
            }
            if (claims) for (const { id } of run) journal.restorePending(id);
            attributed.debug("batch failed; applying its actions one at a time", {
              event: "actions.batch.retried",
              action: run[0]!.id,
              error,
            });
            return "retry";
          }
          for (const { id } of run) {
            if (options.retainApplied) journal.retain(id);
            else journal.retire(id);
          }
          await resolved("applied");
          return "applied";
        } finally {
          for (const { id } of run) claimedHere.delete(id);
        }
      };

      const applyList = async (actions: readonly number[], context?: ActionApplyContext)
        : Promise<ApplyActionsResult> => {
        const result: ApplyActionsResult = { applied: [] };
        const started = Date.now();
        // Naming a record proves the Workshop holds it, whether or not the list gets as far.
        for (const id of actions) journal.markSubmitted(id);
        // Past a batch that failed, its actions go one at a time up to here.
        let unbatchedUntil = 0;
        for (let i = 0; i < actions.length;) {
          if (result.applied.length > 0 && Date.now() - started >= APPLY_LIST_BUDGET_MS) break;
          const id = actions[i]!;
          const run = i < unbatchedUntil ? [] : batchAt(actions, i, context);
          if (run.length > 0) {
            const outcome = await applyBatch(run, context);
            if (outcome === "applied") {
              result.applied.push(...run.map(member => member.id));
              i += run.length;
              continue;
            }
            if (outcome !== "retry") {
              result.failed = {
                action: id,
                message: bounded(outcome.unknown),
                retryable: false,
                outcomeUnknown: true,
              };
              break;
            }
            unbatchedUntil = i + run.length;
          }
          // Not held: the Workshop settles it from the result. A remembered apply is reported.
          if (journal.get(id) === undefined && !journal.wasApplied(id)) {
            i += 1;
            continue;
          }
          try {
            await applyRecord(id, context);
          } catch (error) {
            const record = journal.get(id);
            result.failed = {
              action: id,
              message: bounded(error instanceof Error ? error.message : String(error)),
              // A terminal failure answers every later attempt the same way, an unknown outcome
              // included: it is never dispatched again.
              retryable: record?.state !== "failed",
              ...(record?.state === "failed" && record.outcome === "unknown"
                ? { outcomeUnknown: true as const } : {}),
            };
            break;
          }
          result.applied.push(id);
          i += 1;
        }
        return result;
      };

      // Submits under `view` when a session handle submits, and with none for `submit`.
      const submitThrough = async <K extends keyof M>(
        queue: ActionSubmitter,
        kind: K,
        payload: M[K],
        { fence }: { fence?: ActionFence } = {},
        view?: BranchView,
        holds?: (id: number) => Promise<boolean>,
      ): Promise<number> => {
        const definition = byName.get(String(kind));
        if (definition === undefined) throw new Error(`Unknown action kind "${String(kind)}".`);
        const policy = fencePolicyFor(kind);
        // Declared, not inferred from what the call site happened to pass: an omitted fence on a
        // connection-scoped kind is the silent failure this policy exists to prevent, and a
        // fence on an authority-independent one would pin an action nothing needed pinned.
        if (policy === "authority" && fence === undefined) {
          throw new Error(`Action kind "${String(kind)}" is authority-fenced; stage it with the `
            + "authority this operation ran under -- usually its `CredentialRead` -- as `fence`.");
        }
        if (policy === "none" && fence !== undefined) {
          throw new Error(`Action kind "${String(kind)}" is declared authority-independent; `
            + "remove the `fence`, or declare the kind \"authority\".");
        }
        // Snapshotted before the first await: the payload must be the one describe rendered, the
        // fence the connection this call staged under.
        const staged = structuredClone(payload);
        const pinned = fence && { generation: fence.generation };
        // Cloned for the same reason as the payload: staging serializes behind the journal's
        // lane, and `describe` may still own what it returned.
        const {
          title, description, fields, descriptionIsComplete, pushedCommits, implementsRevert,
        } = structuredClone(await definition.describe(staged, host));
        const action = { kind, payload: staged } as TaggedAction<M>;
        return stage(journal, queue, action, {
          // Destructured, not spread: a port returning a full `ActionDescription` here would
          // otherwise carry its own `awaitDecision` past the delivery the definition declares.
          title,
          description,
          implementsRevert,
          // Spread, so an action with no fields, no git, no awaited decision, or no claim of
          // completeness puts no key on the wire at all. A push is never complete, whatever the
          // hook claims: the approver sees commit ids, not the bytes they carry.
          ...(fields?.length ? { fields } : {}),
          ...(pushedCommits ? { pushedCommits } : {}),
          ...(descriptionIsComplete === true && !pushedCommits?.length
            ? { descriptionIsComplete: true }
            : {}),
          autoApprovable: definition.autoApprovable,
          actionKind: definition.kind,
          ...(definition.delivery === "await-decision" ? { awaitDecision: true } : {}),
        }, {
          ...(pinned ? { fence: pinned } : {}),
          ...(view ? { view } : {}),
          ...(holds ? { holds } : {}),
          // Only a provider this action's view can see counts: a reference minted on another
          // branch resolves here only once it is bound.
          unmet: () => unmetOf(action, view),
        });
      };

      const set: BoundActionSet<M> = {
        submit: (queue, kind, payload, submitOptions) =>
          submitThrough(queue, kind, payload, submitOptions),

        apply: (id, context) => resolutionQueue.run(() => applyRecord(id, context)),

        reject: async id => {
          await resolutionQueue.run(() => rejectRecord(id, false));
        },

        session: async (queue, branch = { branch: null }) => {
          const view = copyView(branch);
          await settleUnconfirmed(queue);
          const handle: ActionSession<M> = {
            view,
            submit: (kind, payload, submitOptions) =>
              submitThrough(queue, kind, payload, submitOptions, view, async id => {
                try {
                  return await queue.holdsAction(id);
                } catch (error) {
                  // Left unconfirmed, for the next session to settle.
                  recovered = false;
                  recovery = undefined;
                  throw error;
                }
              }),
            pending: () => journal.listPendingIn(view),
            undecided: () => journal.listUndecidedIn(view),
          };
          return Object.freeze(handle);
        },

        // The view is the Workshop's, for a batch hook that may one day want it; every record
        // already carries the view it was submitted under.
        applyList: (_branch, actions, context) =>
          resolutionQueue.run(() => applyList(actions, context)),

        stageList: (_branch, actions) =>
          resolutionQueue.run(() => {
            // Naming a record confirms it, one with no view to change included.
            for (const id of actions) { journal.markSubmitted(id); journal.restage(id); }
          }),

        rejectAction: id => resolutionQueue.run(() => rejectRecord(id, true)),

        autoApprovableKinds: () => [...autoApprovableByTag.values()],

        retainsApplied: options.retainApplied === true,

        resolved,

        runExclusive: hook => resolutionQueue.run(hook),
      };
      bound.set(journal, { host, set });
      return set;
    },
  };
}

/**
 * Bounds a failure message for the Workshop, which stores it on the action and shows it.
 * @param message The failure's message.
 * @returns It, cut to a bounded length.
 */
function bounded(message: string): string {
  return message.length > MAX_REPORTED_FAILURE
    ? `${message.slice(0, MAX_REPORTED_FAILURE)}\u2026`
    : message;
}
