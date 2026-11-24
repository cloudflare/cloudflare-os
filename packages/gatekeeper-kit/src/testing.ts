/**
 * A conformance harness for a gatekeeper that has adopted branches (`Gatekeeper.applyActions()`),
 * for its own tests. It plays the Workshop with queues of its own and drives the gatekeeper
 * through the cases an author can still get wrong once the kit carries the submission contract:
 * reads overlaying the pending actions of the wrong view, or state derived from an action the
 * Workshop does not hold. Workers only: its queues are `RpcTarget`s.
 */

import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription,
  ApplyActionsResult,
  ApprovalQueue,
  BranchView,
  GitCache,
  HookController,
  HookDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";

/**
 * The gatekeeper under test, and the two things only its author knows: how to submit an action a
 * read can see, and how to tell whether a read sees it.
 */
export type BranchHarnessSubject<Session> = {
  /**
   * Starts a session, as the Workshop does: usually the facet's own `startSession()`.
   * @param queue The session's approval queue, the harness's.
   * @param branch The view it reads through.
   */
  startSession(queue: RpcStub<ApprovalQueue>, branch: BranchView): Promise<Session>;
  /**
   * The facet's `applyActions()`.
   * @param branch The view to apply through.
   * @param actions The actions to apply, in order.
   * @param cache A git cache stub; the harness's refuses every call.
   */
  applyActions(branch: BranchView, actions: number[], cache: RpcStub<GitCache>):
    Promise<ApplyActionsResult>;
  /**
   * The facet's `stageActions()`, if it has one.
   * @param branch The view the actions were submitted under.
   * @param actions The actions to stage.
   */
  stageActions?(branch: BranchView, actions: number[]): Promise<void>;
  /**
   * True for a gatekeeper that offers creating its resource (`Gatekeeper.applyCreation()`), which
   * must then implement `stageActions()`: the harness fails without it.
   */
  offersCreation?: boolean;
  /**
   * Submits, through `session`, exactly one action whose effect `reads` can find by `marker`.
   * Must reject when the queue refuses the submission.
   * @param session A session `startSession` returned.
   * @param marker A string no other call is given.
   */
  submit(session: Session, marker: string): Promise<unknown>;
  /**
   * Whether `session` sees `marker`'s action: simulated, or applied at the provider.
   * @param session A session `startSession` returned.
   * @param marker The marker the action was submitted with.
   */
  reads(session: Session, marker: string): Promise<boolean>;
};

/** One case of the harness. */
export type BranchHarnessCase = {
  /** What the case checks. */
  readonly name: string;
  /** Runs it, throwing an `Error` that says what went wrong if the gatekeeper got it wrong. */
  run(): Promise<void>;
};

/** How the harness's queue answers a submission. */
type Behavior =
  | { kind: "accept" }
  | { kind: "refuse" }
  /** Records the action, then throws, as when only the reply is lost. */
  | { kind: "lose-reply" }
  | { kind: "pause"; release: Promise<void>; entered: () => void }
  | { kind: "apply-first"; applied: (result: ApplyActionsResult) => void };

/** What the harness, as the Workshop, holds: the actions it accepted and has not decided. */
type Ledger = { held: Set<number>; submitted: number[] };

/** Refuses everything: no case needs git. */
class RefusingGitCache extends RpcTarget {}

/** A session's end that never comes: the harness's sessions outlive their checks. */
class InertWatch extends RpcTarget {}

/** The approval queue the harness hands one session: its view, and one way to answer. */
class HarnessQueue extends RpcTarget implements ApprovalQueue {
  readonly #view: BranchView;
  readonly #ledger: Ledger;
  readonly #behavior: Behavior;
  readonly #apply: (actions: number[]) => Promise<ApplyActionsResult>;

  constructor(
    view: BranchView,
    ledger: Ledger,
    behavior: Behavior,
    apply: (actions: number[]) => Promise<ApplyActionsResult>,
  ) {
    super();
    this.#view = view;
    this.#ledger = ledger;
    this.#behavior = behavior;
    this.#apply = apply;
  }

  async authorizeObservation(_description: ObservationDescription): Promise<void> {}

  async getGitCache(): Promise<GitCache> {
    throw new Error("The branch harness offers no git cache.");
  }

  async requireLive(): Promise<void> {}

  async watchSession(_watcher: RpcStub<RpcTarget>): Promise<RpcStub<RpcTarget>> {
    return new RpcStub(new InertWatch());
  }

  async getExecutionId(): Promise<string | undefined> {
    return undefined;
  }

  // The harness drives no fetch through a caller's policy.
  async getFetcher(): Promise<Fetcher> {
    throw new Error("getFetcher() is not supported by the branch harness.");
  }

  async getBranch(): Promise<BranchView> {
    return this.#view;
  }

  async submitAction(action: number, _description: ActionDescription): Promise<void> {
    const behavior = this.#behavior;
    this.#ledger.submitted.push(action);
    if (behavior.kind === "refuse") throw new Error("The branch harness refused this action.");
    if (behavior.kind === "lose-reply") {
      this.#ledger.held.add(action);
      throw new Error("The branch harness lost this reply.");
    }
    if (behavior.kind === "pause") {
      behavior.entered();
      await behavior.release;
    }
    this.#ledger.held.add(action);
    if (behavior.kind === "apply-first") behavior.applied(await this.#apply([action]));
  }

  async holdsAction(action: number): Promise<boolean> {
    return this.#ledger.held.has(action);
  }

  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>,
    _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    throw new Error("The branch harness binds no hooks.");
  }
}

/**
 * The harness's cases, for a test to run one by one: two sessions on different branches each see
 * only their own pending action and each sees the other's once applied; a refused submission
 * leaves no trace; a submission awaiting its reply shows a concurrent read nothing; one the
 * Workshop applies before replying ends applied, not pending; and, for a gatekeeper with
 * `stageActions()` or that offers creation, a branch's action staged is seen by every view, once,
 * and applies as a staged action. Each case uses branches of its own, so they may share one facet,
 * in order; they cannot share one with an unrelated test's pending actions on the staging view.
 * @param subject The gatekeeper under test.
 * @returns The cases, in the order to run them.
 */
export function branchHarnessCases<Session>(subject: BranchHarnessSubject<Session>)
  : BranchHarnessCase[] {
  const ledger: Ledger = { held: new Set(), submitted: [] };
  let markers = 0;
  const marker = (label: string) => `harness-${label}-${++markers}-${crypto.randomUUID()}`;
  let branches = 0;
  const branch = (label: string): BranchView => ({ branch: `harness:${label}:${++branches}` });

  const apply = async (view: BranchView, actions: number[]) => {
    using cache = new RpcStub(new RefusingGitCache()) as unknown as RpcStub<GitCache>;
    const result = await subject.applyActions(view, actions, cache);
    for (const id of result.applied) ledger.held.delete(id);
    return result;
  };

  const sessions: { [Symbol.dispose]?(): void }[] = [];
  const open = async (view: BranchView, behavior: Behavior = { kind: "accept" }) => {
    using queue = new RpcStub(new HarnessQueue(view, ledger, behavior, actions => apply(view, actions)));
    const session = await subject.startSession(queue, view);
    sessions.push(session as { [Symbol.dispose]?(): void });
    return session;
  };
  const closeSessions = () => {
    for (const session of sessions.splice(0)) session[Symbol.dispose]?.();
  };

  // Submits through `session` and returns the one ID its queue saw.
  const submitOne = async (session: Session, mark: string): Promise<number> => {
    const before = ledger.submitted.length;
    await subject.submit(session, mark);
    const ids = ledger.submitted.slice(before);
    if (ids.length !== 1) {
      throw new Error(`Submitting "${mark}" made ${ids.length} submitAction() calls, not one.`);
    }
    return ids[0]!;
  };

  const expectReads = async (session: Session, mark: string, expected: boolean, where: string) => {
    if (await subject.reads(session, mark) !== expected) {
      throw new Error(`${where} ${expected ? "does not see" : "sees"} "${mark}".`);
    }
  };

  const expectApplied = async (view: BranchView, id: number) => {
    const result = await apply(view, [id]);
    if (result.failed || !result.applied.includes(id)) {
      throw new Error(`applyActions() did not apply action ${id}: ${JSON.stringify(result)}.`);
    }
  };

  const guarded = (name: string, run: () => Promise<void>): BranchHarnessCase => ({
    name,
    run: async () => {
      try {
        await run();
      } finally {
        closeSessions();
      }
    },
  });

  return [
    guarded("two branches do not see each other's pending actions, and see them once applied",
      async () => {
        const [viewA, viewB] = [branch("a"), branch("b")];
        const [a, b, staged] = await Promise.all([open(viewA), open(viewB), open({ branch: null })]);
        const [onA, onB] = [marker("a"), marker("b")];
        const idA = await submitOne(a, onA);
        const idB = await submitOne(b, onB);

        await expectReads(a, onA, true, "The session that submitted it");
        await expectReads(a, onB, false, "A session on another branch");
        await expectReads(b, onB, true, "The session that submitted it");
        await expectReads(b, onA, false, "A session on another branch");
        await expectReads(staged, onA, false, "A session outside any chat");
        await expectReads(staged, onB, false, "A session outside any chat");

        // Applied, each is real, so a session with nothing pending of its own sees it.
        await expectApplied(viewB, idB);
        await expectReads(await open({ branch: null }), onB, true,
          "After it applied, a session outside any chat");
        // Only what was named applied, whatever the result reported.
        await expectReads(await open({ branch: null }), onA, false,
          "After another branch applied, a session outside any chat");
        await expectApplied(viewA, idA);
        await expectReads(await open(viewB), onA, true, "After it applied, the other branch");
      }),

    guarded("a refused submission leaves no trace", async () => {
      const view = branch("refused");
      const refusing = await open(view, { kind: "refuse" });
      const refused = marker("refused");
      const before = ledger.submitted.length;
      const outcome = await subject.submit(refusing, refused).then(() => "resolved", () => "rejected");
      if (outcome !== "rejected") {
        throw new Error("Submitting through a queue that refused the action did not reject.");
      }
      await expectReads(await open(view), refused, false, "After the refusal, a session");
      // A record the refusal left behind would apply when named.
      for (const id of ledger.submitted.slice(before)) {
        const result = await apply(view, [id]);
        if (result.applied.length > 0) {
          throw new Error(`applyActions() applied refused action ${id}.`);
        }
      }
      await expectReads(await open(view), refused, false, "After an apply named it, a session");
    }),

    guarded("a submission the Workshop recorded is kept when its reply is lost", async () => {
      const view = branch("lost");
      const losing = await open(view, { kind: "lose-reply" });
      const mark = marker("lost");
      const before = ledger.submitted.length;
      // Whether the caller is told it failed is the gatekeeper's to choose.
      await subject.submit(losing, mark).catch(() => {});
      const ids = ledger.submitted.slice(before);
      if (ids.length !== 1) {
        throw new Error(`Submitting "${mark}" made ${ids.length} submitAction() calls, not one.`);
      }
      await expectReads(await open(view), mark, true,
        "After the reply to its submission was lost, a session on its branch");
      await expectApplied(view, ids[0]!);
    }),

    guarded("a submission awaiting its reply shows a concurrent read nothing", async () => {
      const view = branch("paused");
      const release = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const paused = await open(view, {
        kind: "pause", release: release.promise, entered: entered.resolve,
      });
      const mark = marker("paused");
      const before = ledger.submitted.length;
      const submitting = subject.submit(paused, mark);
      const failedEarly = submitting.then(() => false, () => true);
      await Promise.race([entered.promise, failedEarly]);
      try {
        await expectReads(await open(view), mark, false, "While its submission awaits a reply, a session");
        await expectReads(paused, mark, false, "While its submission awaits a reply, its own session");
      } finally {
        release.resolve();
      }
      await submitting;
      await expectReads(await open(view), mark, true, "Once its submission returned, a session");
      await expectApplied(view, ledger.submitted[before]!);
    }),

    guarded("an action the Workshop applies before replying is left applied, not pending",
      async () => {
        const view = branch("early");
        let early: ApplyActionsResult | undefined;
        const session = await open(view, { kind: "apply-first", applied: result => early = result });
        const mark = marker("early");
        const id = await submitOne(session, mark);
        if (early?.failed || !early?.applied.includes(id)) {
          throw new Error(`Applying action ${id} before its submission returned did not apply it: `
            + `${JSON.stringify(early)}.`);
        }
        await expectReads(await open(branch("elsewhere")), mark, true,
          "Once applied, a session on another branch");

        // Were it simulated again on its own branch, a later change applied elsewhere would read
        // as overwritten there by an action that already happened.
        const later = marker("later");
        const elsewhere = branch("later");
        await expectApplied(elsewhere, await submitOne(await open(elsewhere), later));
        await expectReads(await open(view), later, true,
          "After a later action applied, the branch that applied the first one early");
      }),

    ...subject.stageActions || subject.offersCreation ? [guarded(
      "a branch's actions, once staged, are seen by every view and apply as staged actions",
      async () => {
        if (!subject.stageActions) {
          throw new Error("A gatekeeper that offers creation must implement stageActions().");
        }
        const stage = (branchView: BranchView, actions: number[]) =>
          subject.stageActions!(branchView, actions);
        const [view, other] = [branch("staging"), branch("onlooker")];
        const session = await open(view);
        const [first, second] = [marker("first"), marker("second")];
        const ids = [await submitOne(session, first), await submitOne(session, second)];
        await expectReads(await open(other), second, false, "Before the move, another branch");

        // Only the first: a move is a prefix of the branch, and the second stays on it.
        await stage(view, ids.slice(0, 1));
        await stage(view, ids.slice(0, 1));
        await expectReads(await open(other), first, true, "Once it was staged, another branch");
        await expectReads(await open({ branch: null }), first, true,
          "Once it was staged, a session outside any chat");
        await expectReads(await open(other), second, false,
          "The action left on its branch, another branch");
        await expectReads(await open(view), second, true, "Its own branch, after the move");

        const staged = await apply({ branch: null }, ids.slice(0, 1));
        if (staged.failed || !staged.applied.includes(ids[0]!)) {
          throw new Error(`applyActions() did not apply staged action ${ids[0]}: `
            + `${JSON.stringify(staged)}.`);
        }
        await expectReads(await open(other), second, false,
          "After the staged action applied, the action left on its branch, another branch");
        await expectApplied(view, ids[1]!);
      })] : [],
  ];
}

/**
 * Runs every case of `branchHarnessCases()` in order, throwing at the first that fails.
 * @param subject The gatekeeper under test.
 */
export async function runBranchHarness<Session>(subject: BranchHarnessSubject<Session>)
  : Promise<void> {
  for (const harnessCase of branchHarnessCases(subject)) {
    try {
      await harnessCase.run();
    } catch (error) {
      throw new Error(`Branch harness, "${harnessCase.name}": ${
        error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}
