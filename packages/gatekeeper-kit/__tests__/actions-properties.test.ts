// Property: an action set and its journal under an agent's turns and its approver, in the
// SharePoint shape. fast-check generates a sequence in which the agent creates items, some inside
// a folder it has only proposed, and edits items it has proposed, while the user approves and
// denies them in any order and the provider succeeds, fails retryably, refuses
// (`ActionApplyError`) or times out (`ActionOutcomeUnknownError`). Each sequence is replayed
// against `defineActions` over a fresh journal. After every step the journal's records, the
// `listPending` projection, the handler dispatches, the release hooks, the ids sent to the overseer
// and whether the call succeeded are checked against a model, and no pending action may wait on a
// reference nothing can still bind. A regression shows as an upload applied into a folder whose
// creation was denied, a dependent stuck in the queue, or a handler dispatched twice.
//
// The model follows USAGE.md's "Actions and files". An action is pending, failed, applied or gone.
// A submission is refused unless the reference it names is bound or a pending action will create
// it. Approving dispatches only a pending action whose reference is bound. Success binds what the
// action creates and a retryable failure leaves it pending. Either terminal failure fails it, and
// a refusal also retires every action waiting on what it was to create, transitively. Denying
// withdraws the action, retires those waiting on it, and runs the release hook unless the handler
// already ran. Nothing is retired over a reference that was bound: a call can fail `late`, after
// the provider created the item, as a SharePoint upload is bound before its workbook recalculates.
//
// A decision usually names an action awaiting one, but may name any submitted so far: the overseer
// can fail to record a decision that completed (`Gatekeeper.applyAction`), and the user then
// decides the action again. Scenarios a seed might miss are pinned as `examples`.

import * as fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { PROPERTY_RUN_OPTIONS } from "@gadgets/scripts/property-runs";
import {
  ActionApplyError, ActionJournal, ActionOutcomeUnknownError, defineActions, type ActionSubmitter,
  type TaggedAction,
} from "../src/actions";
import { fakeKv } from "./fake-kv";

/** What the provider does with a call that reaches it. */
type Provider = "ok" | "retry" | "refused" | "unknown";
type Actions = { create: { ref: string; parent?: string }; edit: { target: string } };
type Action = TaggedAction<Actions>;
type Host = {
  provider: Provider; late: boolean; bound: Set<string>; dispatched: number[]; released: number[];
};

// `parent` and `target` pick, modulo the count, among the provisional references the agent holds
// (`parent: null` is a folder that already exists). `pick` does among the actions the approver
// still has to decide, or among `any` submitted so far.
type Step =
  | { do: "create"; parent: number | null }
  | { do: "edit"; target: number }
  | { do: "apply"; pick: number; any: boolean; provider: Provider; late: boolean }
  | { do: "reject"; pick: number; any: boolean };

const created = (action: Action) => (action.kind === "create" ? action.payload.ref : undefined);
const needed = (action: Action) =>
  action.kind === "create" ? action.payload.parent : action.payload.target;
const pick = <T>(from: readonly T[], n: number): T | undefined => from[n % from.length];

function reach(host: Host, id: number, ref?: string) {
  host.dispatched.push(id);
  // A `late` failure follows the creation, so the handler has already bound what it made.
  if (ref !== undefined && (host.provider === "ok" || host.late)) host.bound.add(ref);
  if (host.provider === "retry") throw new Error("provider unreachable");
  if (host.provider === "refused") throw new ActionApplyError("the provider refused");
  if (host.provider === "unknown") throw new ActionOutcomeUnknownError("the request timed out");
}

function declare(retainApplied: boolean) {
  const common = {
    kind: { tag: "files", label: "Change files" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    // As SharePoint's creations declare, and what an unknown outcome is documented to pair with.
    claimBeforeApply: true,
    describe: () => ({ title: "Change a file", description: "…", implementsRevert: false }),
    reject: async (_payload: unknown, host: Host, { id }: { id: number }) =>
      void host.released.push(id),
  } as const;
  return defineActions<Host, Actions>({
    create: {
      ...common,
      provides: payload => [payload.ref],
      dependsOn: payload => (payload.parent === undefined ? [] : [payload.parent]),
      apply: async (payload, host, { id }) => reach(host, id, payload.ref),
    },
    edit: {
      ...common,
      dependsOn: payload => [payload.target],
      apply: async (_payload, host, { id }) => reach(host, id),
    },
  }, { fence: "none", retainApplied, isResolvedReference: (host, ref) => host.bound.has(ref) });
}

type Modeled = {
  action: Action;
  status: "pending" | "failed" | "applied" | "gone";
  /** Failed before its handler ran, so denying it still releases what staging set up. */
  undispatched?: boolean;
  /** Failed with the provider's answer unknown: what it creates may yet exist. */
  unknown?: boolean;
};

class ActionModel {
  /** Every accepted submission; an action's id is its index plus one. */
  actions: Modeled[] = [];
  bound = new Set<string>();
  dispatched: number[] = [];
  released: number[] = [];

  /** The id an accepted submission gets; undefined for one that is refused. */
  submit(action: Action): number | undefined {
    const ref = needed(action);
    const creatable = this.actions.some(a => a.status === "pending" && created(a.action) === ref);
    if (ref !== undefined && !this.bound.has(ref) && !creatable) return undefined;
    return this.actions.push({ action, status: "pending" });
  }

  /** Whether the approval succeeds. */
  apply(id: number, provider: Provider, late: boolean): boolean {
    const entry = this.actions[id - 1]!;
    const ref = needed(entry.action);
    if (entry.status === "applied") return true;
    if (entry.status !== "pending" || (ref !== undefined && !this.bound.has(ref))) return false;
    this.dispatched.push(id);
    const made = created(entry.action);
    if (made !== undefined && (provider === "ok" || late)) this.bound.add(made);
    if (provider === "retry") return false;
    entry.status = provider === "ok" ? "applied" : "failed";
    if (provider === "unknown") entry.unknown = true;
    if (provider === "refused") this.#strand(made);
    return provider === "ok";
  }

  /** Whether the denial succeeds. */
  reject(id: number): boolean {
    const entry = this.actions[id - 1]!;
    if (entry.status === "applied") return false;
    if (entry.status === "gone") return true;
    if (entry.status === "pending" || entry.undispatched) this.released.push(id);
    entry.status = "gone";
    this.#strand(created(entry.action));
    return true;
  }

  /** Retires every pending action waiting on a reference nothing will now create. */
  #strand(ref: string | undefined) {
    if (ref === undefined || this.bound.has(ref)) return;
    for (const waiting of this.actions) {
      if (waiting.status !== "pending" || needed(waiting.action) !== ref) continue;
      waiting.status = "failed";
      waiting.undispatched = true;
      this.#strand(created(waiting.action));
    }
  }

  /** The ids a decision may name: those awaiting one, or every one. */
  decidable(any: boolean): number[] {
    return this.actions.flatMap(({ status }, at) =>
      (any || status === "pending" || status === "failed" ? [at + 1] : []));
  }

  /** How the journal holds each action: its record's state, or how the record went away. */
  stored(retainApplied: boolean): string[] {
    return this.actions.map(({ status, undispatched, unknown }) => {
      if (status === "applied") return retainApplied ? "applied" : "retired";
      if (status !== "failed") return status;
      return `failed${undispatched ? " undispatched" : ""}${unknown ? " unknown" : ""}`;
    });
  }
}

const succeeds = (call: Promise<unknown>) => call.then(() => true, () => false);

function stored(journal: ActionJournal<Action>, id: number): string {
  const record = journal.get(id);
  if (record === undefined) return journal.wasApplied(id) ? "retired" : "gone";
  return `${record.state}${record.undispatched ? " undispatched" : ""}`
    + (record.outcome === "unknown" ? " unknown" : "");
}

async function replay(retainApplied: boolean, steps: Step[]) {
  const host: Host = { provider: "ok", late: false, bound: new Set(), dispatched: [], released: [] };
  const journal = new ActionJournal<Action>(fakeKv(), { namespace: "pending" });
  const actions = declare(retainApplied).bind(journal, host);
  const model = new ActionModel();
  const submitAction = vi.fn<ApprovalQueue["submitAction"]>(async () => {});
  const queue: ActionSubmitter = { submitAction };
  /** The provisional references the agent was handed, one per accepted creation. */
  const refs: string[] = [];

  for (const [index, step] of steps.entries()) {
    const label = `step ${index} (${JSON.stringify(step)})`;
    const id = "pick" in step ? pick(model.decidable(step.any), step.pick) : undefined;
    if (step.do === "create") {
      const ref = `~${refs.length + 1}`;
      const parent = step.parent === null ? undefined : pick(refs, step.parent);
      const payload = parent === undefined ? { ref } : { ref, parent };
      const accepted = await actions.submit(queue, "create", payload).catch(() => undefined);
      expect(accepted, `${label}: id`).toBe(model.submit({ kind: "create", payload }));
      if (accepted !== undefined) refs.push(ref);
    } else if (step.do === "edit") {
      const target = pick(refs, step.target);
      if (target === undefined) continue;
      const accepted = await actions.submit(queue, "edit", { target }).catch(() => undefined);
      expect(accepted, `${label}: id`).toBe(model.submit({ kind: "edit", payload: { target } }));
    } else if (id === undefined) {
      continue;
    } else if (step.do === "apply") {
      host.provider = step.provider;
      host.late = step.late;
      expect(await succeeds(actions.apply(id)), `${label}: approving ${id} succeeds`)
        .toBe(model.apply(id, step.provider, step.late));
    } else {
      expect(await succeeds(actions.reject(id)), `${label}: denying ${id} succeeds`)
        .toBe(model.reject(id));
    }

    const ids = model.actions.map((_, at) => at + 1);
    expect(submitAction.mock.calls.map(([sent]) => sent), `${label}: sent to the overseer`)
      .toEqual(ids);
    expect(ids.map(each => stored(journal, each)), `${label}: journal records`)
      .toEqual(model.stored(retainApplied));
    expect(journal.listPending(), `${label}: pending projection`).toEqual(model.actions.flatMap(
      ({ action, status }, at) => (status === "pending" ? [{ id: at + 1, action }] : [])));
    expect(host.dispatched, `${label}: handler dispatches`).toEqual(model.dispatched);
    expect(host.released, `${label}: release hooks`).toEqual(model.released);

    // Read off the journal alone, so it holds even where the model shares a mistake with the kit:
    // a reference can still be bound only by a pending creation or one whose outcome is unknown.
    const bindable = new Set<string | undefined>(host.bound);
    for (const record of ids.map(each => journal.get(each))) {
      if (record?.state === "pending" || record?.outcome === "unknown") {
        bindable.add(created(record.action));
      }
    }
    for (const { id: waiting, action } of journal.listPending()) {
      const ref = needed(action);
      expect(ref === undefined || bindable.has(ref), `${label}: ${waiting} can still apply`)
        .toBe(true);
    }
  }
}

const choice = fc.nat({ max: 11 });
// Most decisions are on an action still awaiting one.
const seldom = fc.constantFrom(false, false, false, true);
// Submissions outweigh decisions, so a decision usually lands on an action others wait on.
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ do: fc.constant("create" as const), parent: fc.option(choice) }) },
  { weight: 3, arbitrary: fc.record({ do: fc.constant("edit" as const), target: choice }) },
  {
    weight: 4,
    arbitrary: fc.record({
      do: fc.constant("apply" as const), pick: choice, any: seldom,
      provider: fc.constantFrom<Provider>("ok", "ok", "ok", "ok", "retry", "refused", "unknown"),
      late: fc.constantFrom(false, false, true),
    }),
  },
  { weight: 2, arbitrary: fc.record({ do: fc.constant("reject" as const), pick: choice, any: seldom }) },
);

// Examples name an action by its id, and a reference by its creation's place, from 0, among the
// creations accepted so far.
const create = (parent: number | null = null): Step => ({ do: "create", parent });
const edit = (target: number): Step => ({ do: "edit", target });
const approve = (id: number, provider: Provider = "ok", late = false): Step =>
  ({ do: "apply", pick: id - 1, any: true, provider, late });
const deny = (id: number): Step => ({ do: "reject", pick: id - 1, any: true });

const examples: [boolean, Step[]][] = [
  // A folder (1), an upload into it (2) and an edit of the upload (3). Denying the folder retires
  // both: approving the upload reaches no handler, another upload into the folder is refused, and
  // denying each retired action releases what its staging set up.
  [true, [create(), create(0), edit(1), deny(1), approve(2), create(0), deny(2), deny(3)]],
  // A creation that timed out keeps its dependent waiting, though no new one is accepted, and
  // retires it once the user clears the failure -- without running the creation's release hook.
  [false, [create(), edit(0), approve(1, "unknown"), approve(2), edit(0), deny(1), deny(2)]],
  // Approved out of order, retried after an outage, then approved and denied again by a user whose
  // approval the overseer never recorded: neither reaches the handler nor undoes the applied
  // folder. The provider then refuses the upload into it, which retires the edit of that upload.
  [true, [
    create(), create(0), edit(1), approve(2), approve(1, "retry"), approve(1), approve(1), deny(1),
    approve(2, "refused"), edit(1),
  ]],
  // An upload the provider created before the call failed stays pending, and denying it leaves the
  // edit of the file that now exists to apply.
  [false, [create(), edit(0), approve(1, "retry", true), deny(1), edit(0), approve(2), approve(3)]],
];

it("matches a model of the queue after every submission, approval and denial", async () => {
  // The kit logs each retirement at debug, thousands of lines over the runs.
  const logged = vi.spyOn(console, "debug").mockImplementation(() => {});
  try {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.array(step, { maxLength: 40, size: "max" }), replay),
      { ...PROPERTY_RUN_OPTIONS, numRuns: 1000, examples });
  } finally {
    logged.mockRestore();
  }
});
