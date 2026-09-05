/** Approval-backed resource action declaration, submission, and resolution. */

import { createLogger } from "@gadgets/backend-utils/logger";
import type { RpcStub } from "cloudflare:workers";
import type {
  ActionDescription,
  ActionKind,
  ApprovalQueue,
  GitCache,
} from "@gadgets/workshop-shared/gatekeeper";
import { ActionJournal, type ActionFence } from "./action-journal";
import { SerialTaskQueue } from "./serial-queue";

export {
  ActionJournal,
  type ActionFence,
  type ActionJournalKv,
  type ActionJournalOptions,
  type JournalEntry,
  type JournalKeys,
  type JournalRecord,
} from "./action-journal";

/** The queue surface staging needs; `gate.actions` and a full stub both satisfy it. */
export type ActionSubmitter = Pick<RpcStub<ApprovalQueue>, "submitAction">;

type ActionLogFields =
  { outcome: ResolveOutcome; vendorId: string; action: number; stranded: number };

const logger = createLogger<ActionLogFields>({ component: "gatekeeper.actions" });

// Serialize submissions per journal so pruning cannot remove an in-flight staged record.
const submissions = new WeakMap<object, SerialTaskQueue>();

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
  let lane = submissions.get(journal);
  if (!lane) submissions.set(journal, lane = new SerialTaskQueue());
  return lane.run(async () => {
    const id = journal.allocate(action, fence);
    try {
      await queue.submitAction(id, description);
    } catch (error) {
      // Rolled back only while still staged: an auto-approval can resolve the action mid-flight,
      // and a record that left "staged" proves the overseer received it -- only the reply was lost.
      if (journal.get(id)?.state === "staged") {
        journal.rollbackSubmission(id);
        throw error;
      }
    }
    journal.markSubmitted(id);
    return id;
  });
}

/**
 * Marks an apply failure as terminal and safe to show. Ordinary apply errors remain retryable; in a
 * reject handler this class has no special meaning.
 */
export class ActionApplyError extends Error {}

/** Message stored when a dispatched action's outcome is unknown. */
export const APPLY_OUTCOME_UNKNOWN_MESSAGE = "This action was interrupted after it was dispatched, "
  + "so it may or may not have taken effect. Check the provider before submitting it again.";

/** The approver-facing text for one action; its policy fields come from the declaration. */
export type ActionPresentation =
  Pick<ActionDescription, "title" | "description" | "implementsRevert">;

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
  kind?: ActionKind;
  /** Whether this kind may be auto-applied when the submitted action also allows it. */
  autoApprovable?: boolean;
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
   * Lists provisional references consumed by a payload.
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
   * @param payload Stored action payload.
   * @param host Bound provider host.
   * @param ctx Durable action context.
   */
  reject?(payload: Payload, host: Host, ctx: ActionContext): Promise<void>;
};

/** How a resolution ended, for cache invalidation. */
export type ResolveOutcome = "applied" | "rejected" | "failed" | "reverted";

/** Cross-cutting policy for a whole action set, as opposed to one kind's behavior. */
export type ActionSetOptions<Host> = {
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
   * (e.g. `ref => provisionalIds.isResolved(ref)`). When set, apply refuses to run a handler whose
   * references are unresolved instead of passing provisional strings to the provider.
   * @param ref Provisional reference the action depends on.
   * @returns Whether the reference names a real provider id.
   */
  isResolvedReference?(ref: string): boolean;
  /** Vendor id for log attribution. */
  vendorId?: string;
};

/** A journal entry tagged with the kind that knows how to resolve it. */
export type TaggedAction<M> = { [K in keyof M]: { kind: K; payload: M[K] } }[keyof M];

/** Approval-time context the overseer hands `Gatekeeper.applyAction`. */
export type ActionApplyContext = {
  /** The action-scoped git cache stub, for handlers that touch git. */
  gitCache?: RpcStub<GitCache>;
  /** The account's current connection generation, from `CredentialSource.read()`. */
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
   * @param options `fence` pins the action to a connection generation, so apply refuses a record
   * approved under a connection that has since been replaced. Capture it from the `CredentialRead`
   * the staging operation ran under — structurally an `ActionFence`, so `{ fence: read }` works
   * verbatim — never from a shared accessor a concurrent fetch can move. `CredentialCoordinator`
   * rotates the generation on `connect()` and `clear()` only, never on refresh, so a same-account
   * re-authorization mismatches too; fence the kinds whose payload means nothing under another
   * connection and leave the rest unfenced.
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
   * Rejects an action, including one whose definition was removed after submission.
   * @param id Action ID to reject.
   */
  reject(id: number): Promise<void>;
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

// Pending action references used to find stranded dependents.
type ActionRefs = { id: number; provides: readonly string[]; dependsOn: readonly string[] };

// Find actions transitively stranded by unresolved provisional references.
function strandedBy(dead: readonly string[], pending: readonly ActionRefs[]): number[] {
  const dependents = new Map<string, number[]>();
  const provides = new Map<number, readonly string[]>();
  for (const entry of pending) {
    provides.set(entry.id, entry.provides);
    for (const ref of entry.dependsOn) {
      const waiting = dependents.get(ref);
      if (waiting) waiting.push(entry.id);
      else dependents.set(ref, [entry.id]);
    }
  }

  const stranded = new Set<number>();
  // Appended to while it is walked, which is how the cascade reaches dependents of dependents.
  const unresolved = [...dead];
  for (const ref of unresolved) {
    for (const id of dependents.get(ref) ?? []) {
      if (stranded.has(id)) continue;
      stranded.add(id);
      unresolved.push(...(provides.get(id) ?? []));
    }
  }
  return [...stranded];
}

/**
 * Declares a resource's action handlers. Apply is at-least-once by default; irreversible calls use
 * `claimBeforeApply`, and uncertain non-replayable failures use `ActionApplyError`.
 * @param definitions Action handlers keyed by kind.
 * @param options Set-wide retention and resolution policy.
 * @returns An action set ready to bind.
 *
 * @example
 * ```ts
 * const declared = defineActions<VendorApi, { createTask: CreateTask }>({
 *   createTask: {
 *     delivery: "continue-with-simulation",
 *     claimBeforeApply: true,
 *     describe: task => ({
 *       title: `Create task "${task.title}"`,
 *       description: `Creates the task in project ${task.projectId}.`,
 *     }),
 *     apply: (task, api) => api.createTask(task),
 *   },
 * });
 * await declared.bind(journal, api).submit(gate.actions, "createTask", task);
 * ```
 */
export function defineActions<Host, M extends Record<string, unknown>>(
  definitions: { [K in keyof M]: ActionDefinition<M[K], Host> },
  options: ActionSetOptions<Host> = {},
): ActionSet<Host, M> {
  const labelByTag = new Map<string, string>();
  // One entry per tag: siblings sharing one are governed as a group, and the loop below rejects a
  // tag whose siblings disagree about the label.
  const autoApprovableByTag = new Map<string, ActionKind>();
  const declared = Object.entries(definitions) as [string, ActionDefinition<unknown, Host>][];
  // The cast above is the one place the payload type is erased: TypeScript cannot correlate a
  // tagged union's payload with its definition.
  const byName = new Map(declared);
  for (const [name, definition] of declared) {
    // Auto-approval rules key on the tag, so without a kind the flag could never take effect.
    if (definition.autoApprovable === true && !definition.kind) {
      throw new Error(`Action "${name}" declares autoApprovable without a kind.`);
    }
    if (definition.kind === undefined) continue;

    // The catalog advertises one label per tag, so a second spelling would put a name in the
    // approval UI that does not cover everything enabling that tag authorizes.
    const { tag, label } = definition.kind;
    const declaredLabel = labelByTag.get(tag);
    if (declaredLabel === undefined) labelByTag.set(tag, label);
    else if (declaredLabel !== label) {
      throw new Error(
        `Action tag "${tag}" is declared with two labels, "${declaredLabel}" and "${label}".`);
    }
    if (definition.autoApprovable === true) autoApprovableByTag.set(tag, definition.kind);
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

      // Retire dependents whose provisional references can no longer resolve.
      const strandDependents = (id: number, action: TaggedAction<M>): void => {
        try {
          const dead = definitionFor(action)?.provides?.(action.payload) ?? [];
          if (dead.length === 0) return;

          // A staged dependent can race this scan; apply rejects its unresolved reference later.
          const stranded = strandedBy(dead, journal.listUndecided().map(record => {
            const definition = definitionFor(record.action);
            return {
              id: record.id,
              provides: definition?.provides?.(record.action.payload) ?? [],
              dependsOn: definition?.dependsOn?.(record.action.payload) ?? [],
            };
          }));
          // Undispatched: a stranded dependent never reached its handler, so its rejection still
          // owes the cleanup.
          for (const strandedId of stranded) {
            journal.markFailed(
              strandedId, `This action needed action ${id}, which was not applied.`,
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
        journal.markFailed(id, APPLY_OUTCOME_UNKNOWN_MESSAGE);
        await resolved("failed");
        throw new Error(APPLY_OUTCOME_UNKNOWN_MESSAGE);
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
        if (record.fence !== undefined) {
          // The early gate against the common case. A reconnect landing after it is caught only by
          // a handler comparing `ctx.fence` against its own operation's read.
          if (context?.generation === undefined) {
            throw new Error(`Action ${id} is fenced to a connection generation; pass the current `
              + "generation to apply().");
          }
          if (record.fence.generation !== context.generation) {
            const message = "This action was approved under a connection that has since been "
              + "replaced. Reject it and submit it again.";
            journal.markFailed(id, message, { undispatched: true });
            strandDependents(id, action);
            await resolved("failed");
            throw new Error(message);
          }
        }
        // Retryable, never terminal, and no cascade: the providing action may still apply later,
        // and the cascade owns terminal marking when it cannot.
        if (options.isResolvedReference) {
          for (const ref of definition.dependsOn?.(action.payload) ?? []) {
            if (options.isResolvedReference(ref) === true) continue;
            throw new Error(`Action ${id} depends on ${ref}, which is not applied yet. Apply its `
              + "providing action first, or reject this action.");
          }
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
            // Terminal handler failures stop retry; ordinary failures restore the pending claim.
            if (error instanceof ActionApplyError) {
              journal.markFailed(id, error.message);
              strandDependents(id, action);
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

      const rejectRecord = async (id: number): Promise<void> => {
        const record = journal.get(id);
        // A stray reject must not take the retained record a revert hook reads back ("applied"
        // exists only in that tier), nor report success for an applied id it cannot undo: unlike
        // apply, no idempotent reading exists.
        if (record?.state === "applied" || journal.wasApplied(id)) {
          throw new Error(`Action ${id} is no longer pending.`);
        }

        if (record === undefined) return;
        // The same proof of receipt apply takes.
        journal.markSubmitted(id);
        if (record.state === "claimed" && !claimedHere.has(id)) {
          return failOrphanedClaim(id);
        }

        const action = record.action;
        // Rejecting a terminal failure is the user clearing the record: its handler already ran
        // and owns whatever it left behind. One that never reached the handler is the exception —
        // its staging artifacts are still the rejection's to release.
        const failed = record.state === "failed";
        try {
          if (!failed || record.undispatched) {
            await definitionFor(action)?.reject?.(action.payload, host, {
              id,
              ...(record.fence ? { fence: record.fence } : {}),
            });
          }
        } catch (error) {
          // Same reasoning as a failed apply: the handler may have half-changed simulation state.
          await resolved("failed");
          throw error;
        }
        journal.remove(id);
        // A failure stranded its dependents when it was recorded.
        if (!failed) strandDependents(id, action);
        await resolved("rejected");
      };

      const set: BoundActionSet<M> = {
        submit: async (queue, kind, payload, { fence } = {}) => {
          const definition = definitions[kind];
          // Snapshotted before the first await: the stored payload must be the one describe rendered.
          payload = structuredClone(payload);
          const { title, description, implementsRevert } = await definition.describe(payload, host);
          const action = { kind, payload } as TaggedAction<M>;
          return stageAction(journal, queue, action, {
            // Projected, not spread: a port returning a full `ActionDescription` here would
            // otherwise carry its own `awaitDecision` past the delivery the definition declares.
            title,
            description,
            implementsRevert,
            autoApprovable: definition.autoApprovable === true,
            // Spread, so a kindless or simulating action puts no key on the wire at all.
            ...(definition.kind ? { actionKind: definition.kind } : {}),
            ...(definition.delivery === "await-decision" ? { awaitDecision: true } : {}),
          }, fence);
        },

        apply: (id, context) => resolutionQueue.run(() => applyRecord(id, context)),

        reject: id => resolutionQueue.run(() => rejectRecord(id)),

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
