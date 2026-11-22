// Branches of pending actions (plans/forking-reality.md) as the kit carries them: the view each
// record stores, what a session handle sees and may build on, applying a list, what a denial
// reports, and settling a submission an earlier activation never saw answered. Everything here is
// additive, so the last block checks that the call sites written before it behave as they did.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BranchView } from "@gadgets/workshop-shared/gatekeeper";
import {
  ActionApplyError,
  ActionJournal,
  ActionOutcomeUnknownError,
  defineActions,
  type ActionBatch,
  type ActionSessionQueue,
  type TaggedAction,
} from "../src/actions";
import { fakeKv, type FakeKv } from "./fake-kv";

type Actions = {
  create: { ref: string; name: string };
  rename: { target: string; name: string };
  note: { text: string };
};

const presentation = { title: "Act", description: "…", implementsRevert: false };
const policy = { autoApprovable: true, delivery: "continue-with-simulation" } as const;

type Host = { bound: Map<string, string>; applied: string[]; rejected: string[] };

function newHost(): Host {
  return { bound: new Map(), applied: [], rejected: [] };
}

const nameOf = (action: TaggedAction<Actions>) =>
  action.kind === "note" ? action.payload.text : action.payload.name;

type Options = {
  batch?: ActionBatch<Host, Actions>;
  fail?: (name: string) => Error | undefined;
  /** Runs at the start of every reject hook. */
  beforeReject?: () => Promise<void>;
};

function declare(options: Options = {}) {
  const fail = options.fail ?? (() => undefined);
  return defineActions<Host, Actions>({
    create: {
      ...policy,
      kind: { tag: "create", label: "Create" },
      describe: () => presentation,
      provides: payload => [payload.ref],
      apply: async (payload, host) => {
        const error = fail(payload.name);
        if (error) throw error;
        host.applied.push(payload.name);
        host.bound.set(payload.ref, `real-${payload.name}`);
      },
      reject: async (payload, host) => {
        await options.beforeReject?.();
        host.rejected.push(payload.name);
      },
    },
    rename: {
      ...policy,
      kind: { tag: "rename", label: "Rename" },
      describe: () => presentation,
      dependsOn: payload => [payload.target],
      apply: async (payload, host) => {
        const error = fail(payload.name);
        if (error) throw error;
        host.applied.push(payload.name);
      },
      reject: async (payload, host) => void host.rejected.push(payload.name),
    },
    note: {
      ...policy,
      kind: { tag: "note", label: "Note" },
      describe: () => presentation,
      apply: async (payload, host) => {
        const error = fail(payload.text);
        if (error) throw error;
        host.applied.push(payload.text);
      },
      reject: async (payload, host) => void host.rejected.push(payload.text),
    },
  }, {
    fence: "none",
    isResolvedReference: (host, ref) => host.bound.has(ref),
    ...(options.batch ? { batch: options.batch } : {}),
  });
}

/** A queue that accepts every submission and holds what it was told to hold. */
function acceptingQueue(holds: (id: number) => boolean = () => true) {
  const submitted: number[] = [];
  const holdsAction = vi.fn(async (id: number) => holds(id));
  const queue: ActionSessionQueue = {
    submitAction: async id => void submitted.push(id),
    // A stub's boolean result is typed as a union of promises, which a plain function's is not.
    holdsAction: holdsAction as ActionSessionQueue["holdsAction"],
  };
  return { queue, submitted, holdsAction };
}

const A: BranchView = { branch: "chat:a" };
const B: BranchView = { branch: "chat:b" };
const STAGED: BranchView = { branch: null };

/** A fresh activation over `kv`: its own journal and its own bound set, as after a restart. */
function activation(kv: FakeKv, options?: Options & { maxPending?: number }) {
  const journal = new ActionJournal<TaggedAction<Actions>>(kv, {
    namespace: "things",
    ...(options?.maxPending ? { maxPending: options.maxPending } : {}),
  });
  const host = newHost();
  return { journal, host, set: declare(options).bind(journal, host) };
}

const names = (entries: readonly { action: TaggedAction<Actions> }[]) =>
  entries.map(entry => nameOf(entry.action));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("views on records", () => {
  it("shows each view staged actions and its own branch's, records with no view first", async () => {
    const { journal, set } = activation(fakeKv());
    const { queue } = acceptingQueue();
    const [a, b, staged] = await Promise.all([A, B, STAGED].map(view => set.session(queue, view)));
    await a.submit("note", { text: "a1" });
    await staged.submit("note", { text: "s1" });
    await set.submit(queue, "note", { text: "legacy" });
    await b.submit("note", { text: "b1" });
    await a.submit("note", { text: "a2" });
    await staged.submit("note", { text: "s2" });

    expect(names(a.pending())).toEqual(["legacy", "s1", "s2", "a1", "a2"]);
    expect(names(b.pending())).toEqual(["legacy", "s1", "s2", "b1"]);
    expect(names(staged.pending())).toEqual(["legacy", "s1", "s2"]);
    // Crossing branches is still possible, under a name that says so.
    expect(names(journal.listPendingAcrossBranches()))
      .toEqual(["a1", "s1", "legacy", "b1", "a2", "s2"]);
  });

  it("shows a fork its ancestors' actions up to each boundary, however deep", async () => {
    const { journal, set } = activation(fakeKv());
    const { queue } = acceptingQueue();
    const a = await set.session(queue, A);
    const b = await set.session(queue, B);
    const a1 = await a.submit("note", { text: "a1" });
    const b1 = await b.submit("note", { text: "b1" });
    await a.submit("note", { text: "a2" });
    await b.submit("note", { text: "b2" });

    // C forked from B after b1, and B from A after a1: the kernel flattens the lineage.
    const c = await set.session(queue, {
      branch: "chat:c", ancestors: [{ branch: "chat:b", through: b1 }, { branch: "chat:a", through: a1 }],
    });
    await c.submit("note", { text: "c1" });
    expect(names(c.pending())).toEqual(["a1", "b1", "c1"]);
    expect(journal.listPendingIn({ branch: "chat:c" }).map(entry => nameOf(entry.action)))
      .toEqual(["c1"]);
  });

  it("stores the view a session submitted under, and keeps it through every transition", async () => {
    const kv = fakeKv();
    const { journal, set } = activation(kv);
    const { queue } = acceptingQueue();
    const session = await set.session(queue, { branch: "chat:a", ancestors: [] });
    const id = await session.submit("note", { text: "kept" });
    // An empty lineage is stored as none.
    expect(journal.get(id)).toEqual({
      state: "pending", action: { kind: "note", payload: { text: "kept" } }, view: { branch: "chat:a" },
    });
    journal.markClaimed(id);
    journal.restorePending(id);
    journal.markFailed(id, "no");
    expect(journal.get(id)?.view).toEqual({ branch: "chat:a" });
  });

  it("caps pending actions per branch, and a submission with no view against them all", async () => {
    const { set } = activation(fakeKv(), { maxPending: 2 });
    const { queue } = acceptingQueue();
    const a = await set.session(queue, A);
    const b = await set.session(queue, B);
    await a.submit("note", { text: "a1" });
    await a.submit("note", { text: "a2" });

    await expect(a.submit("note", { text: "a3" })).rejects.toThrow(/Too many pending actions/);
    await b.submit("note", { text: "b1" });
    await b.submit("note", { text: "b2" });
    await expect(set.submit(queue, "note", { text: "legacy" })).rejects.toThrow(/Too many/);
  });

  it("names what an action was built on, and what was built on it", async () => {
    const { journal, set } = activation(fakeKv());
    const { queue } = acceptingQueue();
    const a = await set.session(queue, A);
    const staged = await set.session(queue, STAGED);
    const b = await set.session(queue, B);
    const a1 = await a.submit("note", { text: "a1" });
    const s1 = await staged.submit("note", { text: "s1" });
    const b1 = await b.submit("note", { text: "b1" });
    const a2 = await a.submit("note", { text: "a2" });

    // A chat's action is replayed on top of everything staged, whatever its ID.
    expect(names(journal.pendingBefore(a1))).toEqual(["s1"]);
    expect(names(journal.pendingBefore(a2))).toEqual(["s1", "a1"]);
    expect(names(journal.pendingBefore(s1))).toEqual([]);
    // So a staged action has every branch built on it, and a chat's only its own.
    expect(names(journal.pendingAfter(s1))).toEqual(["a1", "b1", "a2"]);
    expect(names(journal.pendingAfter(a1))).toEqual(["a2"]);
    expect(journal.pendingAfter(b1)).toEqual([]);
  });
});

describe("dependencies across branches", () => {
  it("resolves a reference only where its provider is visible, or once it is bound", async () => {
    const { set, host } = activation(fakeKv());
    const { queue } = acceptingQueue();
    const a = await set.session(queue, A);
    const b = await set.session(queue, B);
    const staged = await set.session(queue, STAGED);
    await a.submit("create", { ref: "~a", name: "made-on-a" });
    await staged.submit("create", { ref: "~s", name: "made-staged" });

    await a.submit("rename", { target: "~a", name: "a-builds-on-a" });
    await expect(b.submit("rename", { target: "~a", name: "b-builds-on-a" }))
      .rejects.toThrow(/depends on ~a/);
    // A staged action builds on nothing but staged actions; a chat may build on staging.
    await expect(staged.submit("rename", { target: "~a", name: "staged-builds-on-a" }))
      .rejects.toThrow(/depends on ~a/);
    await b.submit("rename", { target: "~s", name: "b-builds-on-staged" });

    host.bound.set("~a", "real-a");
    await b.submit("rename", { target: "~a", name: "b-after-bound" });
  });

  it("strands a dependent only through a provider its view could see", async () => {
    const { journal, set, host } = activation(fakeKv());
    const { queue } = acceptingQueue();
    const a = await set.session(queue, A);
    const maker = await a.submit("create", { ref: "~r", name: "maker" });
    const sameBranch = await a.submit("rename", { target: "~r", name: "same-branch" });
    // A record on another branch naming the same string, which `submit` would refuse: written
    // straight into the journal, as a store being ported might hold one.
    const elsewhere = journal.allocate(
      { kind: "rename", payload: { target: "~r", name: "elsewhere" } }, undefined, B);
    journal.markSubmitted(elsewhere);

    expect(await set.rejectAction(maker)).toEqual({ restart: true, rejected: [sameBranch] });
    expect(host.rejected).toEqual(["maker", "same-branch"]);
    expect(journal.get(elsewhere)?.state).toBe("pending");
  });
});

describe("applyList", () => {
  it("applies in the order given, confirming a record still waiting for its reply", async () => {
    const { journal, set, host } = activation(fakeKv());
    const release = Promise.withResolvers<void>();
    const queue: ActionSessionQueue = {
      submitAction: () => release.promise,
      holdsAction: async () => true,
    };
    const staged = await set.session(queue, STAGED);
    const legacy = await set.submit({ submitAction: async () => {} }, "note", { text: "legacy" });
    const waiting = staged.submit("note", { text: "unconfirmed" });
    await vi.waitFor(() => expect(journal.get(2)?.state).toBe("staged"));
    expect(names(staged.pending())).toEqual(["legacy"]);

    // Staging applies at once, so the list can name an action before its submission returns.
    expect(await set.applyList(STAGED, [2, legacy])).toEqual({ applied: [2, legacy] });
    expect(host.applied).toEqual(["unconfirmed", "legacy"]);
    release.resolve();
    expect(await waiting).toBe(2);
    expect(journal.get(2)).toBeUndefined();
    expect(staged.pending()).toEqual([]);
  });

  it("stops at the first failure, retryable unless the record failed for good", async () => {
    let failures: Record<string, Error> = { second: new Error("try later") };
    const { set, host } = activation(fakeKv(), { fail: name => failures[name] });
    const { queue } = acceptingQueue();
    const a = await set.session(queue, A);
    const ids = [];
    for (const text of ["first", "second", "third"]) ids.push(await a.submit("note", { text }));

    expect(await set.applyList(A, ids)).toEqual({
      applied: [ids[0]], failed: { action: ids[1], message: "try later", retryable: true },
    });
    expect(host.applied).toEqual(["first"]);

    failures = { second: new ActionApplyError("gone for good") };
    expect(await set.applyList(A, ids.slice(1))).toEqual({
      applied: [], failed: { action: ids[1], message: "gone for good", retryable: false },
    });
    // A terminal failure answers again the same way, without the handler.
    failures = {};
    expect(await set.applyList(A, ids.slice(1))).toEqual({
      applied: [], failed: { action: ids[1], message: "gone for good", retryable: false },
    });
    expect(host.applied).toEqual(["first"]);
  });

  it("reports an unknown outcome as a failure only a rejection clears, and never redispatches it",
    async () => {
      let attempts = 0;
      const { set } = activation(fakeKv(), {
        fail: () => {
          attempts += 1;
          return new ActionOutcomeUnknownError("timed out");
        },
      });
      const { queue } = acceptingQueue();
      const id = await (await set.session(queue, A)).submit("note", { text: "lost" });
      const failed = { action: id, message: "timed out", retryable: false, outcomeUnknown: true };
      expect(await set.applyList(A, [id])).toEqual({ applied: [], failed });
      // Named again, as the Workshop's next apply on the connection names it: the same answer,
      // without the handler, which might apply it twice.
      expect(await set.applyList(A, [id])).toEqual({ applied: [], failed });
      expect(attempts).toBe(1);
    });

  it("leaves out what it does not hold, and reports again what it already applied", async () => {
    const { set, host } = activation(fakeKv());
    const { queue } = acceptingQueue();
    const a = await set.session(queue, A);
    const first = await a.submit("note", { text: "first" });
    const second = await a.submit("note", { text: "second" });
    expect(await set.applyList(A, [first])).toEqual({ applied: [first] });

    // As when the first call's result was lost: applied again in name only.
    expect(await set.applyList(A, [first, 99, second])).toEqual({ applied: [first, second] });
    expect(host.applied).toEqual(["first", "second"]);
    // Nothing held: the call applies nothing and reports no failure.
    expect(await set.applyList(A, [99])).toEqual({ applied: [] });
  });

  it("returns early once it has run long enough, having applied something", async () => {
    const { set, host } = activation(fakeKv());
    const { queue } = acceptingQueue();
    const a = await set.session(queue, A);
    const ids = [];
    for (const text of ["1", "2", "3"]) ids.push(await a.submit("note", { text }));
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    host.applied.push = (...items: string[]) => {
      now += 20_000;
      return Array.prototype.push.apply(host.applied, items);
    };

    expect(await set.applyList(A, ids)).toEqual({ applied: [ids[0], ids[1]] });
    expect(await set.applyList(A, ids.slice(2))).toEqual({ applied: [ids[2]] });
  });

  it("hands consecutive actions of the batch's kinds to one call", async () => {
    const batches: string[][] = [];
    const { set, host } = activation(fakeKv(), {
      batch: {
        kinds: ["note", "create"],
        apply: async actions => {
          batches.push(actions.map(({ action }) => nameOf(action)));
          for (const { action } of actions) {
            if (action.kind === "create") host.bound.set(action.payload.ref, "real");
          }
        },
      },
    });
    const { queue } = acceptingQueue();
    const a = await set.session(queue, A);
    const ids = [
      await a.submit("note", { text: "n1" }),
      await a.submit("create", { ref: "~x", name: "c1" }),
      // Names what the batch before it provides, so it waits for that batch to apply.
      await a.submit("rename", { target: "~x", name: "r1" }),
      await a.submit("note", { text: "n2" }),
    ];

    expect(await set.applyList(A, ids)).toEqual({ applied: ids });
    // `rename` has no batch kind, and `n2` alone is no batch: both run their own handlers.
    expect(batches).toEqual([["n1", "c1"]]);
    expect(host.applied).toEqual(["r1", "n2"]);
    expect(a.pending()).toEqual([]);
  });

  it("applies a failed batch one action at a time, and pins an unknown outcome on all of it",
    async () => {
      let batchError: Error = new Error("batch refused");
      const { journal, set, host } = activation(fakeKv(), {
        fail: name => (name === "n2" ? new Error("n2 is bad") : undefined),
        batch: { kinds: ["note"], apply: async () => { throw batchError; } },
      });
      const { queue } = acceptingQueue();
      const a = await set.session(queue, A);
      const ids = [];
      for (const text of ["n1", "n2", "n3"]) ids.push(await a.submit("note", { text }));

      expect(await set.applyList(A, ids)).toEqual({
        applied: [ids[0]], failed: { action: ids[1], message: "n2 is bad", retryable: true },
      });
      expect(host.applied).toEqual(["n1"]);

      batchError = new ActionOutcomeUnknownError("the batch timed out");
      expect(await set.applyList(A, ids.slice(1))).toEqual({
        applied: [],
        failed: {
          action: ids[1], message: "the batch timed out", retryable: false, outcomeUnknown: true,
        },
      });
      expect([journal.get(ids[1]!)?.state, journal.get(ids[2]!)?.state]).toEqual(["failed", "failed"]);
    });
});

describe("stageList", () => {
  it("stages a branch's records within the bound, for every view, in ID order", async () => {
    const { journal, set } = activation(fakeKv());
    const { queue } = acceptingQueue();
    const [a, b, staged] = await Promise.all([A, B, STAGED].map(view => set.session(queue, view)));
    const a1 = await a.submit("note", { text: "a1" });
    await staged.submit("note", { text: "s1" });
    const a2 = await a.submit("note", { text: "a2" });
    await set.submit(queue, "note", { text: "legacy" });
    await b.submit("note", { text: "b1" });
    const a3 = await a.submit("note", { text: "a3" });

    await set.stageList(A, [a1, a2]);
    expect(journal.get(a1)?.view).toEqual(STAGED);
    expect(names(b.pending())).toEqual(["legacy", "a1", "s1", "a2", "b1"]);
    expect(names(staged.pending())).toEqual(["legacy", "a1", "s1", "a2"]);
    expect(names(a.pending())).toEqual(["legacy", "a1", "s1", "a2", "a3"]);
    expect(journal.get(a3)?.view).toEqual(A);
  });

  it("changes nothing when called again, nor for records it does not hold or that are staged",
      async () => {
    const kv = fakeKv();
    const { journal, set } = activation(kv);
    const { queue } = acceptingQueue();
    const [a, staged] = await Promise.all([A, STAGED].map(view => set.session(queue, view)));
    const mine = await a.submit("note", { text: "mine" });
    const theirs = await staged.submit("note", { text: "theirs" });
    const legacy = await set.submit(queue, "note", { text: "legacy" });
    await set.stageList(A, [mine]);
    const before = kv.writes.length;
    await set.stageList(A, [mine, theirs, legacy, 99]);
    expect(kv.writes.length).toBe(before);
    expect(journal.get(legacy)?.view).toBeUndefined();
  });

  it("confirms a record still waiting for its reply, which applyList then takes as staged",
      async () => {
    const { journal, set, host } = activation(fakeKv());
    const release = Promise.withResolvers<void>();
    const a = await set.session({
      submitAction: () => release.promise, holdsAction: async () => true,
    }, A);
    const waiting = a.submit("note", { text: "unconfirmed" });
    await vi.waitFor(() => expect(journal.get(1)?.state).toBe("staged"));

    await set.stageList(A, [1]);
    expect(journal.get(1)).toMatchObject({ state: "pending", view: STAGED });
    const onlooker = await set.session(acceptingQueue().queue, B);
    expect(names(onlooker.pending())).toEqual(["unconfirmed"]);
    expect(await set.applyList(STAGED, [1])).toEqual({ applied: [1] });
    expect(host.applied).toEqual(["unconfirmed"]);
    release.resolve();
    expect(await waiting).toBe(1);
    expect(onlooker.pending()).toEqual([]);
  });
});

describe("rejectAction", () => {
  it("rejects what could not apply without the action, across every branch for a staged one",
    async () => {
      const { journal, set, host } = activation(fakeKv());
      const { queue } = acceptingQueue();
      const staged = await set.session(queue, STAGED);
      const a = await set.session(queue, A);
      const b = await set.session(queue, B);
      const maker = await staged.submit("create", { ref: "~s", name: "maker" });
      const onA = await a.submit("rename", { target: "~s", name: "on-a" });
      const onB = await b.submit("rename", { target: "~s", name: "on-b" });
      const unrelated = await b.submit("note", { text: "unrelated" });

      expect(await set.rejectAction(maker)).toEqual({ restart: true, rejected: [onA, onB] });
      expect(host.rejected).toEqual(["maker", "on-a", "on-b"]);
      expect(journal.listPendingAcrossBranches().map(({ id }) => id)).toEqual([unrelated]);
      // Already gone: a later rejection of a dependent is a no-op.
      expect(await set.rejectAction(onA)).toEqual({ restart: false, rejected: [] });
    });

  it("asks for a restart only when something shown was built on", async () => {
    const { set } = activation(fakeKv());
    const { queue } = acceptingQueue();
    const a = await set.session(queue, A);
    const b = await set.session(queue, B);
    const first = await a.submit("note", { text: "first" });
    await b.submit("note", { text: "other branch" });
    const last = await a.submit("note", { text: "last" });

    expect(await set.rejectAction(last)).toEqual({ restart: false, rejected: [] });
    await a.submit("note", { text: "after" });
    expect(await set.rejectAction(first)).toEqual({ restart: true, rejected: [] });
  });

  it("asks for a restart for a failed action that something was built on while it showed",
    async () => {
      const { set } = activation(fakeKv(), {
        fail: name => (name === "first" ? new ActionApplyError("cannot") : undefined),
      });
      const { queue } = acceptingQueue();
      const a = await set.session(queue, A);
      const first = await a.submit("note", { text: "first" });
      await a.submit("note", { text: "built on it" });
      await set.applyList(A, [first]);
      expect(await set.rejectAction(first)).toEqual({ restart: true, rejected: [] });
    });

  it("takes what it rejects out of every read before a reject hook can yield", async () => {
    const parked = Promise.withResolvers<void>();
    const { set } = activation(fakeKv(), { beforeReject: () => parked.promise });
    const { queue } = acceptingQueue();
    const a = await set.session(queue, A);
    const maker = await a.submit("create", { ref: "~m", name: "maker" });
    const dependent = await a.submit("rename", { target: "~m", name: "dependent" });

    const rejecting = set.rejectAction(maker);
    await vi.waitFor(() => expect(a.pending()).toEqual([]));
    await expect(a.submit("rename", { target: "~m", name: "racing" }))
      .rejects.toThrow(/depends on ~m/);
    parked.resolve();
    expect((await rejecting).rejected).toEqual([dependent]);
  });

  it("reports the dependents an earlier failure already stranded", async () => {
    const { journal, set } = activation(fakeKv(), {
      fail: name => (name === "maker" ? new ActionApplyError("cannot create") : undefined),
    });
    const { queue } = acceptingQueue();
    const a = await set.session(queue, A);
    const maker = await a.submit("create", { ref: "~m", name: "maker" });
    const dependent = await a.submit("rename", { target: "~m", name: "dependent" });
    await set.applyList(A, [maker, dependent]);
    expect(journal.get(dependent)?.state).toBe("failed");

    // The Workshop still holds the dependent pending, so the denial says it went too.
    expect((await set.rejectAction(maker)).rejected).toEqual([dependent]);
    expect(journal.get(dependent)).toBeUndefined();
  });
});

// The record a crash left: allocated under a view, its submitAction() reply never seen.
function crashedSubmission(kv: FakeKv, view: BranchView = A): number {
  const journal = new ActionJournal<TaggedAction<Actions>>(kv, { namespace: "things" });
  return journal.allocate({ kind: "note", payload: { text: "unconfirmed" } }, undefined, view);
}

describe("a submission an earlier activation never saw answered", () => {
  it("keeps one the Workshop holds, visible from the first session's first read", async () => {
    const kv = fakeKv();
    const id = crashedSubmission(kv);
    const { set } = activation(kv);
    const { queue, holdsAction } = acceptingQueue(() => true);
    const session = await set.session(queue, A);
    expect(holdsAction.mock.calls).toEqual([[id]]);
    expect(names(session.pending())).toEqual(["unconfirmed"]);
  });

  it("deletes one the Workshop does not hold, releasing what its staging set up", async () => {
    const kv = fakeKv();
    const id = crashedSubmission(kv);
    const { journal, set, host } = activation(kv);
    const session = await set.session(acceptingQueue(() => false).queue, B);
    expect(journal.get(id)).toBeUndefined();
    expect(host.rejected).toEqual(["unconfirmed"]);
    expect(session.pending()).toEqual([]);
  });

  it("lets no session read or submit until the answer is in, and asks once for all of them",
    async () => {
      const kv = fakeKv();
      crashedSubmission(kv);
      const { set } = activation(kv);
      const answer = Promise.withResolvers<boolean>();
      const holdsAction = vi.fn(() => answer.promise);
      const queue: ActionSessionQueue = {
        submitAction: async () => {},
        holdsAction: holdsAction as ActionSessionQueue["holdsAction"],
      };
      let started = 0;
      const sessions = [A, B].map(view => set.session(queue, view).then(session => {
        started += 1;
        return session;
      }));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(started).toBe(0);
      answer.resolve(true);
      const [a, b] = await Promise.all(sessions);
      expect(holdsAction).toHaveBeenCalledTimes(1);
      expect(names(a!.pending())).toEqual(["unconfirmed"]);
      expect(b!.pending()).toEqual([]);
      // Settled for this activation: a later session asks nothing.
      await set.session(queue, A);
      expect(holdsAction).toHaveBeenCalledTimes(1);
    });

  it("fails the session when the question fails, and asks again for the next", async () => {
    const kv = fakeKv();
    crashedSubmission(kv);
    const { set } = activation(kv);
    const failing: ActionSessionQueue = {
      submitAction: async () => {},
      holdsAction: async () => { throw new Error("queue gone"); },
    };
    await expect(set.session(failing, A)).rejects.toThrow("queue gone");
    const { queue, holdsAction } = acceptingQueue(() => true);
    expect(names((await set.session(queue, A)).pending())).toEqual(["unconfirmed"]);
    expect(holdsAction).toHaveBeenCalledTimes(1);
  });

  it("settles one an apply names first without asking about it", async () => {
    const kv = fakeKv();
    const id = crashedSubmission(kv, STAGED);
    const { set, host } = activation(kv);
    expect(await set.applyList(STAGED, [id])).toEqual({ applied: [id] });
    const { queue, holdsAction } = acceptingQueue();
    await set.session(queue, STAGED);
    expect(holdsAction).not.toHaveBeenCalled();
    expect(host.applied).toEqual(["unconfirmed"]);
  });

  it("leaves a staged record with no view to the callback that names it, as before", async () => {
    const kv = fakeKv();
    const journal = new ActionJournal<TaggedAction<Actions>>(kv, { namespace: "things" });
    const id = journal.allocate({ kind: "note", payload: { text: "legacy" } });
    const { set } = activation(kv);
    const { queue, holdsAction } = acceptingQueue();
    const session = await set.session(queue, A);
    expect(holdsAction).not.toHaveBeenCalled();
    expect(session.pending()).toEqual([]);
    await set.apply(id);
  });
});

describe("call sites written before views", () => {
  it("stores no view, simulates to every session first, and applies when a list names it",
    async () => {
      const { journal, set, host } = activation(fakeKv());
      const { queue } = acceptingQueue();
      const a = await set.session(queue, A);
      const mine = await a.submit("note", { text: "mine" });
      const legacy = await set.submit(queue, "note", { text: "legacy" });
      expect(journal.get(legacy)).toEqual({
        state: "pending", action: { kind: "note", payload: { text: "legacy" } },
      });
      expect(names(a.pending())).toEqual(["legacy", "mine"]);
      expect(await set.applyList(A, [legacy, mine])).toEqual({ applied: [legacy, mine] });
      expect(host.applied).toEqual(["legacy", "mine"]);
    });

  it("pins the fence as it was when submit was called, not once describe returns", async () => {
    const described = Promise.withResolvers<void>();
    const journal = new ActionJournal<TaggedAction<{ note: { text: string } }>>(fakeKv(),
      { namespace: "fenced" });
    const set = defineActions<object, { note: { text: string } }>({
      note: {
        ...policy,
        kind: { tag: "note", label: "Note" },
        describe: async () => {
          await described.promise;
          return presentation;
        },
        apply: async () => {},
      },
    }, { fence: "authority" }).bind(journal, {});
    const read = { generation: "before" };
    const { queue } = acceptingQueue();
    const session = await set.session(queue, A);
    const submitted = [
      set.submit(queue, "note", { text: "legacy" }, { fence: read }),
      session.submit("note", { text: "session" }, { fence: read }),
    ];
    read.generation = "after";
    described.resolve();
    const ids = await Promise.all(submitted);
    expect(ids.map(id => journal.get(id)?.fence)).toEqual(
      [{ generation: "before" }, { generation: "before" }]);
  });

  it("keeps reject marking stranded dependents failed and reporting nothing", async () => {
    const { journal, set, host } = activation(fakeKv());
    const queue = { submitAction: async () => {} };
    const maker = await set.submit(queue, "create", { ref: "~m", name: "maker" });
    const dependent = await set.submit(queue, "rename", { target: "~m", name: "dependent" });
    await expect(set.reject(maker)).resolves.toBeUndefined();
    expect(journal.get(dependent)?.state).toBe("failed");
    expect(host.rejected).toEqual(["maker"]);
  });
});
