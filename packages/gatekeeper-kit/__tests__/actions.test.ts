import { describe, expect, it, vi } from "vitest";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { RpcStub } from "cloudflare:workers";
import {
  ActionApplyError,
  ActionJournal,
  APPLY_OUTCOME_UNKNOWN_MESSAGE,
  defineActions,
  stageAction,
  type ActionDefinition,
  type ActionJournalKv,
  type ActionPresentation,
  type ActionSubmitter,
  type ResolveOutcome,
  type TaggedAction,
} from "../src/actions";
import { ObservationGate, openObservers } from "../src/observers";
import { fakeKv } from "./fake-kv";

function makeKv() {
  const kv = fakeKv();
  return kv satisfies ActionJournalKv;
}

type Sql = { sql: string; rows?: number };

const presentation = { title: "Run SQL", description: "…", implementsRevert: false };

// Keep recorded submissions typed to the real RPC signature.
function submitSpy() {
  return vi.fn<ApprovalQueue["submitAction"]>(async () => {});
}

function fakeQueue(submitAction = submitSpy()): ActionSubmitter {
  return { submitAction };
}

describe("ActionJournal", () => {
  it("allocates sequential ids and lists only submitted actions, ordered numerically", () => {
    const journal = new ActionJournal<Sql>(makeKv());

    const ids = Array.from({ length: 10 }, (_, index) => journal.allocate({ sql: `q${index}` }));
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(journal.listPending()).toEqual([]);

    // Submitting exactly 10 and 2 tests both halves at once. The eight left staged must not appear,
    // and the lexicographic key scan reaches `…:10` before `…:2` -- see `fake-kv.ts`, whose `list`
    // reproduces the real scan order instead of replaying insertion order. So without the numeric
    // sort in `listPending` this expectation is [10, 2].
    journal.markSubmitted(10);
    journal.markSubmitted(2);
    expect(journal.listPending().map(({ id }) => id)).toEqual([2, 10]);
  });

  it("refuses to stage over a live id, which a port of a last-issued counter would reissue", () => {
    const kv = makeKv();
    const journal = new ActionJournal<Sql>(kv);
    const id = journal.allocate({ sql: "live" });
    // A last-issued convention stores the id it just returned, not the next unused one.
    kv.put("pending:nextActionId", id);

    expect(() => journal.allocate({ sql: "clobber" })).toThrow(/next unused id/);
    expect(journal.get(id)).toEqual({ state: "staged", action: { sql: "live" } });
  });

  it("refuses to stage over a legacy row its upgrade hook cannot convert", () => {
    const kv = makeKv();
    kv.put("pending:action:1", "opaque legacy row");
    const journal = new ActionJournal<Sql>(kv);

    expect(() => journal.allocate({ sql: "clobber" })).toThrow(/next unused id/);
    expect(kv.get("pending:action:1")).toBe("opaque legacy row");
  });

  it("refuses to stage over a retired id, whose applied memory would swallow the new apply", () => {
    const kv = makeKv();
    const journal = new ActionJournal<Sql>(kv);
    const id = journal.allocate({ sql: "applied" });
    journal.markSubmitted(id);
    journal.retire(id);
    kv.put("pending:nextActionId", id);

    expect(() => journal.allocate({ sql: "clobber" })).toThrow(/next unused id/);
  });

  it("remembers retired ids within the prunable allowance, and forgets the oldest past it", () => {
    const journal = new ActionJournal<Sql>(makeKv(), { maxPending: 1 });
    const ids = ["a", "b", "c"].map(sql => {
      const id = journal.allocate({ sql });
      journal.markSubmitted(id);
      journal.retire(id);
      return id;
    });

    expect(journal.get(ids[2]!)).toBeUndefined();
    expect(ids.map(id => journal.wasApplied(id))).toEqual([false, true, true]);
  });

  it("resolves a staged record, and keeps its id counter out of the record keyspace", () => {
    const kv = makeKv();
    const journal = new ActionJournal<Sql>(kv);
    const id = journal.allocate({ sql: "staged" });

    expect(journal.get(id)).toEqual({ state: "staged", action: { sql: "staged" } });
    expect(journal.listPending()).toEqual([]);
    // Load-bearing literals: the defaults are the keys the ported gatekeepers already wrote, so a
    // port that passes no key options keeps reading its live records. `keys()` is sorted, so this
    // asserts the whole keyspace regardless of write order.
    expect(kv.keys()).toEqual([`pending:action:${id}`, "pending:nextActionId"]);
  });

  it("moves a retained record out of the pending scan while keeping it findable", () => {
    const kv = makeKv();
    const journal = new ActionJournal<Sql>(kv);
    const retained = journal.allocate({ sql: "applied" });
    const pending = journal.allocate({ sql: "waiting" });
    journal.markSubmitted(retained);
    journal.markSubmitted(pending);

    journal.retain(retained, { sql: "applied", rows: 3 });

    expect(journal.listPending()).toEqual([{ id: pending, action: { sql: "waiting" } }]);
    expect(journal.get(retained)).toEqual({ state: "applied", action: { sql: "applied", rows: 3 } });
    expect(journal.isRetained(retained)).toBe(true);
    expect(journal.isRetained(pending)).toBe(false);
    // The record left the scanned prefix entirely, so pending scans stay bounded.
    expect(kv.keys().filter(key => key.startsWith("pending:action:"))).toEqual([
      `pending:action:${pending}`,
    ]);

    journal.remove(retained);
    expect(journal.get(retained)).toBeUndefined();
  });

  it("keeps the applied record when the pending one cannot be deleted", () => {
    // A throw does not roll back the implicit transaction, so write order decides what an
    // interrupted retain leaves. Deleting first would lose the record for an applied action.
    const kv = makeKv();
    const failing: ActionJournalKv = {
      ...kv,
      delete: key => { throw new Error(`storage unavailable: ${key}`); },
    };
    const journal = new ActionJournal<Sql>(failing);
    const id = journal.allocate({ sql: "applied" });
    journal.markSubmitted(id);

    expect(() => journal.retain(id, { sql: "applied", rows: 3 })).toThrow("storage unavailable");

    // In both tiers, and every reader must resolve that in the retained tier's favour: the applied
    // record carries the artifacts a revert hook reads back, and simulating the stale pending copy
    // would project an effect the provider has already made real.
    expect(journal.isRetained(id)).toBe(true);
    expect(journal.get(id)).toEqual({ state: "applied", action: { sql: "applied", rows: 3 } });
    expect(journal.listPending()).toEqual([]);
    expect(kv.get(`retained:pending:action:${id}`)).toBeDefined();

    // Including the cap: the record is applied, so it must not hold a pending slot for good.
    const capped = new ActionJournal<Sql>(kv, { maxPending: 1 });
    expect(capped.allocate({ sql: "next" })).toBe(id + 1);
  });

  it("ignores a scanned key whose suffix is not the id it would coerce to", () => {
    const kv = makeKv();
    const journal = new ActionJournal<Sql>(kv, { maxPending: 2 });
    const id = journal.allocate({ sql: "one" });
    journal.markSubmitted(id);

    // A legacy keyspace a port pointed `recordPrefix` at. `Number("01")` is 1, so coercing would
    // alias the live record: the capacity scan would count it, and `remove(1)` would delete the
    // wrong key. `1e3` and a bare prefix are the same class of coercion.
    for (const suffix of ["01", "1e3", "", " 2", "0"]) {
      kv.put(`pending:action:${suffix}`, { v: 1, state: "pending", action: { sql: suffix } });
    }

    expect(journal.listPending()).toEqual([{ id, action: { sql: "one" } }]);
    // One real pending record against a cap of two, so the foreign keys were not counted.
    expect(journal.allocate({ sql: "two" })).toBe(id + 1);
  });

  it("never prunes a staged record whose applied copy is retained", () => {
    // An auto-approval can apply and retain while `submitAction` is still in flight, so the stale
    // source left by an interrupted `retain` is staged, not pending.
    const kv = makeKv();
    const failing: ActionJournalKv = {
      ...kv,
      delete: key => { throw new Error(`storage unavailable: ${key}`); },
    };
    const id = new ActionJournal<Sql>(failing).allocate({ sql: "applied" });
    expect(() => new ActionJournal<Sql>(failing).retain(id, { sql: "applied", rows: 3 }))
      .toThrow("storage unavailable");

    // Enough staged records to force pruning; the retained one must not be among the casualties.
    const journal = new ActionJournal<Sql>(kv, { maxPending: 1 });
    journal.allocate({ sql: "second" });
    journal.allocate({ sql: "third" });

    expect(journal.isRetained(id)).toBe(true);
    expect(journal.get(id)).toEqual({ state: "applied", action: { sql: "applied", rows: 3 } });
  });

  it("reads records written before the journal existed", () => {
    const kv = makeKv();
    // github's record shape exactly: indistinguishable from a current one by fields or by state
    // values, so only the absent version marker can route it to the upgrader.
    kv.put("pending:action:7", { action: { statement: "legacy" }, state: "pending" });
    const journal = new ActionJournal<Sql>(kv, {
      // The shape this gatekeeper wrote before it had a journal; unvalidatable by construction.
      upgradeRecord: raw => ({ sql: (raw as { action: { statement: string } }).action.statement }),
    });

    expect(journal.get(7)).toEqual({ state: "pending", action: { sql: "legacy" } });
    expect(journal.listPending()).toEqual([{ id: 7, action: { sql: "legacy" } }]);
  });

  it("leaves a record alone once it has been resolved mid-submission", () => {
    const journal = new ActionJournal<Sql>(makeKv());
    const id = journal.allocate({ sql: "one" });

    // An auto-approval can apply and retain the record while submitAction is still in flight.
    journal.retain(id);
    journal.markSubmitted(id);
    expect(journal.get(id)).toEqual({ state: "applied", action: { sql: "one" } });

    journal.rollbackSubmission(id);
    expect(journal.get(id)).toBeDefined();
  });

  it("refuses overlapping keyspaces a port could pass by hand", () => {
    expect(() => new ActionJournal(makeKv(), { recordPrefix: "" }))
      .toThrow(/must not be empty/);
    expect(() => new ActionJournal(makeKv(), { nextIdKey: "action:1", recordPrefix: "action:" }))
      .toThrow(/overlaps a record prefix/);
    expect(() => new ActionJournal(makeKv(), { nextIdKey: "retained:pending:action:1" }))
      .toThrow(/overlaps a record prefix/);
    expect(() => new ActionJournal(makeKv(), { recordPrefix: "retained:" }))
      .toThrow(/its own retained tier/);
  });

  it("refuses a pending cap that would disable itself", () => {
    // `NaN` fails every comparison the cap appears in, so it silently removes the bound; zero and
    // below refuse the first allocation instead of the last.
    for (const maxPending of [Number.NaN, Infinity, 0, -1, 1.5]) {
      expect(() => new ActionJournal(makeKv(), { maxPending }))
        .toThrow(/maxPending must be a positive integer/);
    }
  });

  it("projects a claimed record but stops projecting a failed one", () => {
    const journal = new ActionJournal<Sql>(makeKv());
    const [pending, claimed, failed] = [1, 2, 3].map(n => journal.allocate({ sql: `q${n}` }));
    for (const id of [pending, claimed, failed]) journal.markSubmitted(id);

    journal.markClaimed(claimed);
    journal.markFailed(failed, "the provider rejected the statement");

    // An in-flight dispatch is still part of the world a read simulates; a terminal failure is not.
    expect(journal.listPending().map(({ id }) => id)).toEqual([pending, claimed]);
    expect(journal.get(claimed)).toEqual({ state: "claimed", action: { sql: "q2" } });
    expect(journal.get(failed)).toEqual({
      state: "failed",
      action: { sql: "q3" },
      error: "the provider rejected the statement",
    });
  });

  it("excludes a claimed record from the decisions a resolution may still retire", () => {
    const journal = new ActionJournal<Sql>(makeKv());
    const staged = journal.allocate({ sql: "staged" });
    const pending = journal.allocate({ sql: "pending" });
    const claimed = journal.allocate({ sql: "claimed" });
    for (const id of [pending, claimed]) journal.markSubmitted(id);
    journal.markClaimed(claimed);

    // A claim's outcome is unknown, so it is simulated but never retired; a staged record is not
    // yet the overseer's, so it is neither -- while still being there to resolve.
    expect(journal.listPending().map(({ id }) => id)).toEqual([pending, claimed]);
    expect(journal.listUndecided().map(({ id }) => id)).toEqual([pending]);
    expect(journal.get(staged)?.state).toBe("staged");
  });

  it("never moves a record out of a state it has already settled in", () => {
    const journal = new ActionJournal<Sql>(makeKv());
    const applied = journal.allocate({ sql: "applied" });
    const failed = journal.allocate({ sql: "failed" });
    journal.retain(applied);
    journal.markFailed(failed, "first answer");

    journal.markClaimed(applied);
    journal.restorePending(failed);
    journal.markFailed(failed, "second answer");
    journal.markFailed(404, "no such record");

    expect(journal.get(applied)).toEqual({ state: "applied", action: { sql: "applied" } });
    // The stored answer is the one the user was already shown, not whatever arrived later.
    expect(journal.get(failed))
      .toEqual({ state: "failed", action: { sql: "failed" }, error: "first answer" });
    expect(journal.get(404)).toBeUndefined();
  });

  it("refuses to allocate past the pending cap, and lets a failure be cleared", () => {
    const kv = makeKv();
    const journal = new ActionJournal<Sql>(kv, { maxPending: 2 });
    const first = journal.allocate({ sql: "one" });
    const second = journal.allocate({ sql: "two" });
    journal.markSubmitted(first);
    journal.markSubmitted(second);

    expect(() => journal.allocate({ sql: "three" })).toThrow(/Too many pending actions/);
    // Nothing was written, so the refused allocation did not consume an id either.
    expect(kv.keys()).toEqual([`pending:action:${first}`, `pending:action:${second}`,
      "pending:nextActionId"]);

    // A failed record does not count: rejecting it is how it is cleared, so counting it would
    // wedge the queue for a user with nothing left to approve.
    journal.markFailed(second, "the provider rejected the statement");
    expect(journal.allocate({ sql: "three" })).toBe(3);
  });

  it("caps unresolved actions at 50 by default", () => {
    const journal = new ActionJournal<Sql>(makeKv());
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      journal.markSubmitted(journal.allocate({ sql: `q${attempt}` }));
    }

    expect(() => journal.allocate({ sql: "q51" })).toThrow(/Too many pending actions/);
  });

  it("neither counts nor keeps staged records a submission never delivered", () => {
    // A staged record never reached the overseer, so no approval queue entry can clear it; counted,
    // a crash between `allocate` and `submitAction` would wedge this resource for good.
    const kv = makeKv();
    const journal = new ActionJournal<Sql>(kv, { maxPending: 2 });
    for (const sql of ["one", "two", "three", "four", "five"]) journal.allocate({ sql });

    expect(journal.allocate({ sql: "six" })).toBe(6);
    // Bounded like the failures, since they share the scanned prefix: the oldest is dropped.
    expect(kv.keys().filter(key => key.startsWith("pending:action:")))
      .toEqual(["pending:action:2", "pending:action:3", "pending:action:4",
        "pending:action:5", "pending:action:6"]);
  });

  it("never lets terminal failures block a new action", () => {
    // Why they get their own bound: counted against the cap, a run of provider failures would stop
    // the agent staging anything until the user cleared them by hand.
    const journal = new ActionJournal<Sql>(makeKv(), { maxPending: 2 });
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      journal.markFailed(journal.allocate({ sql: `q${attempt}` }), "terminal");
    }

    expect(() => journal.allocate({ sql: "still works" })).not.toThrow();
  });

  it("bounds the terminal failures accumulating beside the pending records", () => {
    // Failures are excluded from the cap but live under the scanned prefix, so unbounded they would
    // make every later allocation and every simulation scan progressively more expensive.
    const kv = makeKv();
    const journal = new ActionJournal<Sql>(kv, { maxPending: 2 });
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      journal.markFailed(journal.allocate({ sql: `q${attempt}` }), "terminal");
    }

    // The newest survive: the oldest is the one the user is least likely to still be looking at.
    expect(kv.keys().filter(key => key.startsWith("pending:action:")))
      .toEqual(["pending:action:16", "pending:action:17", "pending:action:18",
        "pending:action:19", "pending:action:20"]);
    expect(journal.get(20)?.error).toBe("terminal");
    expect(journal.get(15)).toBeUndefined();
  });

  it("prunes nothing while the prunable records are under their bound", () => {
    // An unclamped excess drops records while the bound is not even reached, since a negative
    // `slice` end counts back from the array's own length.
    const kv = makeKv();
    const journal = new ActionJournal<Sql>(kv, { maxPending: 4 });
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      journal.markFailed(journal.allocate({ sql: `q${attempt}` }), "terminal");
    }
    journal.allocate({ sql: "the allocation that scans all seven" });

    expect([1, 2, 3, 4, 5, 6, 7].map(id => journal.get(id)?.error))
      .toEqual(Array.from({ length: 7 }, () => "terminal"));
  });

  it("drops a stranded staged record before a failure that explains itself", () => {
    const kv = makeKv();
    const journal = new ActionJournal<Sql>(kv, { maxPending: 1 });
    journal.markFailed(journal.allocate({ sql: "explained" }), "terminal");
    journal.allocate({ sql: "never submitted" });
    journal.allocate({ sql: "never submitted either" });
    journal.allocate({ sql: "the allocation that forces a prune" });

    // Oldest-first across the whole prefix would take the failure instead.
    expect(journal.get(1)?.error).toBe("terminal");
    expect(journal.get(2)).toBeUndefined();
  });

  it("answers for a failed record whose reason storage lost", () => {
    const kv = makeKv();
    const journal = new ActionJournal<Sql>(kv);
    const id = journal.allocate({ sql: "one" });
    kv.put(`pending:action:${id}`, { v: 1, state: "failed", action: { sql: "one" } });

    // The type promises a failed record carries its reason; the storage boundary keeps that true.
    expect(journal.get(id)?.error).toBe("This action failed, and the reason was not recorded.");
  });

  it("refuses to retain a terminal failure, which would drop the reason it answers with", () => {
    const journal = new ActionJournal<Sql>(makeKv());
    const id = journal.allocate({ sql: "one" });
    journal.markFailed(id, "the provider refused");

    journal.retain(id);

    expect(journal.isRetained(id)).toBe(false);
    expect(journal.get(id)).toEqual({
      state: "failed", action: { sql: "one" }, error: "the provider refused",
    });
  });

  it("bounds a stored failure reason, so the rewrite cannot outgrow the value limit", () => {
    const journal = new ActionJournal<Sql>(makeKv());
    const id = journal.allocate({ sql: "one" });

    journal.markFailed(id, "x".repeat(50_000));

    const { error } = journal.get(id) ?? {};
    expect(error).toHaveLength(1025);
    expect(error?.endsWith("\u2026")).toBe(true);
  });
});

describe("stageAction", () => {
  it("submits the allocated id, then marks the action pending", async () => {
    const journal = new ActionJournal<Sql>(makeKv());
    const submitAction = submitSpy();

    const id = await stageAction(journal, fakeQueue(submitAction), { sql: "one" }, presentation);

    expect(submitAction).toHaveBeenCalledWith(id, presentation);
    expect(journal.listPending()).toEqual([{ id, action: { sql: "one" } }]);
  });

  it("rolls the record back when submission fails", async () => {
    const journal = new ActionJournal<Sql>(makeKv());
    const submitAction = vi.fn<ApprovalQueue["submitAction"]>(async () => {
      throw new Error("queue unavailable");
    });

    await expect(stageAction(journal, fakeQueue(submitAction), { sql: "one" }, presentation))
      .rejects.toThrow("queue unavailable");
    expect(journal.get(1)).toBeUndefined();
    expect(journal.listPending()).toEqual([]);
  });

  it("reports success when only the reply to an auto-approved submission was lost", async () => {
    // The overseer applied and retained the action inside submitAction, then the RPC rejected.
    const journal = new ActionJournal<Sql>(makeKv());
    const submitAction = vi.fn<ApprovalQueue["submitAction"]>(async submitted => {
      journal.retain(submitted);
      throw new Error("session torn down");
    });

    const id = await stageAction(journal, fakeQueue(submitAction), { sql: "one" }, presentation);
    expect(journal.get(id)).toEqual({ state: "applied", action: { sql: "one" } });
  });

  it("reports success when a non-retaining auto-approval consumed the record mid-submission", async () => {
    const journal = new ActionJournal<Sql>(makeKv());
    const submitAction = vi.fn<ApprovalQueue["submitAction"]>(async submitted => {
      journal.remove(submitted);
      throw new Error("session torn down");
    });

    // A gone record is a resolved one: nothing but a resolution removes it mid-submission.
    const id = await stageAction(journal, fakeQueue(submitAction), { sql: "one" }, presentation);
    expect(journal.get(id)).toBeUndefined();
    expect(journal.listPending()).toEqual([]);
  });

  it("serializes direct concurrent callers, so the prune cannot take a record mid-flight", async () => {
    // Unserialized, these stages would all hold staged records open at once and the last one's
    // capacity prune would delete the oldest -- an approval with no journal record behind it.
    const journal = new ActionJournal<Sql>(makeKv(), { maxPending: 1 });
    const submitAction = submitSpy();
    const queue = fakeQueue(submitAction);

    const results = await Promise.allSettled(
      ["a", "b", "c", "d"].map(sql => stageAction(journal, queue, { sql }, presentation)));

    // One staged and submitted; the rest refused at capacity. Nothing reported success for a
    // record that no longer exists.
    const staged = results.filter(result => result.status === "fulfilled");
    expect(staged).toHaveLength(1);
    for (const result of staged) expect(journal.get(result.value)).toBeDefined();
    expect(submitAction).toHaveBeenCalledTimes(1);
    for (const result of results.filter(result => result.status === "rejected")) {
      expect(String(result.reason)).toMatch(/Too many pending/);
    }
  });
});

describe("defineActions", () => {
  type Actions = { execute: Sql; publish: { page: string } };
  type Host = { ran: string[] };

  function bind(overrides: {
    apply?: (payload: Sql, host: Host, ctx: { id: number }) => Promise<void | { action?: Sql }>;
    reject?: (payload: Sql, host: Host, ctx: { id: number }) => Promise<void>;
    describe?: (payload: Sql, host: Host) => ActionPresentation;
    retainApplied?: boolean;
    afterResolve?: (host: Host, outcome: ResolveOutcome) => void | Promise<void>;
    claimBeforeApply?: boolean;
    maxPending?: number;
    /** Share one journal between two binds, which is how a dead activation is simulated. */
    journal?: ActionJournal<TaggedAction<Actions>>;
  } = {}) {
    const host: Host = { ran: [] };
    const outcomes: ResolveOutcome[] = [];
    const journal = overrides.journal
      ?? new ActionJournal<TaggedAction<Actions>>(makeKv(), { maxPending: overrides.maxPending });
    const set = defineActions<Host, Actions>({
      execute: {
        kind: { tag: "sql", label: "Run SQL" },
        autoApprovable: true,
        delivery: "continue-with-simulation",
        claimBeforeApply: overrides.claimBeforeApply,
        describe: overrides.describe ?? (() => presentation),
        apply: overrides.apply ?? (async (payload, target) => void target.ran.push(payload.sql)),
        reject: overrides.reject
          ?? (async (payload, target) => void target.ran.push(`rejected ${payload.sql}`)),
      },
      publish: {
        // Same tag as `execute`, so necessarily the same label: one tag is one approval group.
        kind: { tag: "sql", label: "Run SQL" },
        delivery: "await-decision",
        describe: () => presentation,
        apply: async (payload, target) => void target.ran.push(payload.page),
      },
    }, {
      retainApplied: overrides.retainApplied,
      afterResolve: overrides.afterResolve
        ?? ((_host, outcome) => void outcomes.push(outcome)),
    });
    return { host, journal, outcomes, actions: set.bind(journal, host) };
  }

  it("submits the declaration's policy beside the text its describe hook returned", async () => {
    const { actions, journal } = bind();
    const submitAction = submitSpy();

    const id = await actions.submit(fakeQueue(submitAction), "execute", { sql: "one" });

    expect(submitAction).toHaveBeenCalledWith(id, {
      ...presentation,
      actionKind: { tag: "sql", label: "Run SQL" },
      autoApprovable: true,
    });
    expect(journal.listPending()).toEqual([
      { id, action: { kind: "execute", payload: { sql: "one" } } },
    ]);
  });

  it("stages through the gate's borrowed action surface", async () => {
    // The one-dup session shape: `gate.actions` must satisfy `ActionSubmitter` without a cast.
    const { actions, journal } = bind();
    const submitAction = submitSpy();
    const gate = new ObservationGate(
      { submitAction } as unknown as RpcStub<ApprovalQueue>, openObservers());

    const id = await actions.submit(gate.actions, "execute", { sql: "one" });

    expect(submitAction).toHaveBeenCalledWith(id, expect.objectContaining(presentation));
    expect(journal.listPending()).toEqual([
      { id, action: { kind: "execute", payload: { sql: "one" } } },
    ]);
  });

  it("journals the payload as submitted, not as the caller mutated it afterwards", async () => {
    // What the approver reads and what apply receives must be the same payload, so submit snapshots
    // it before its first await -- the caller's reference is live until the KV put otherwise.
    const { actions, journal } = bind({
      describe: payload => ({ ...presentation, description: payload.sql }),
    });
    const submitAction = submitSpy();

    const payload = { sql: "SELECT 1" };
    const submitting = actions.submit(fakeQueue(submitAction), "execute", payload);
    payload.sql = "DROP TABLE users";
    const id = await submitting;

    expect(submitAction).toHaveBeenCalledWith(
      id, expect.objectContaining({ description: "SELECT 1" }));
    expect(journal.get(id)?.action).toEqual({ kind: "execute", payload: { sql: "SELECT 1" } });
  });

  it("keeps a record an overseer callback proved delivered when the submission reply is lost", async () => {
    // An auto-approved apply can race the submitAction reply. The callback naming the id is proof
    // of receipt: it promotes the staged record, so a retryable failure leaves it pending -- and
    // the lost-reply rollback cannot take a record the overseer still holds.
    const { actions, journal } = bind({
      apply: async () => { throw new Error("provider unreachable"); },
    });
    const queue = fakeQueue(vi.fn<ApprovalQueue["submitAction"]>(async submitted => {
      await actions.apply(submitted).catch(() => {});
      throw new Error("session torn down");
    }));

    const id = await actions.submit(queue, "execute", { sql: "one" });
    expect(journal.get(id)?.state).toBe("pending");
    expect(journal.listPending().map(entry => entry.id)).toEqual([id]);
  });

  it("never prunes a record whose own submission is still in flight", async () => {
    // Staged records do not count against `maxPending`, so overlapping submissions pile up in the
    // prunable tier until the capacity scan drops the oldest -- one still awaiting its queue call.
    // `maxPending: 4` bounds that tier at 8, so the tenth concurrent stage is the first to prune.
    const { actions, journal } = bind({ maxPending: 4 });

    const settled = await Promise.allSettled(Array.from({ length: 12 }, (_, n) =>
      actions.submit(fakeQueue(), "execute", { sql: `q${n}` })));
    const accepted = settled.flatMap(r => (r.status === "fulfilled" ? [r.value] : []));

    expect(accepted.length).toBeGreaterThan(0);
    // A pruned record resolves as "Unknown pending action" despite the queue holding it.
    for (const id of accepted) expect(journal.get(id)).toBeDefined();
  });

  it("describes the payload the journal stores, so the text cannot drift from it", async () => {
    const { actions, journal } = bind({
      describe: payload => ({ ...presentation, description: `runs ${payload.sql}` }),
    });
    const submitAction = submitSpy();

    const id = await actions.submit(fakeQueue(submitAction), "execute", { sql: "select 1" });

    const [, sent] = submitAction.mock.calls[0]!;
    expect(sent.description).toBe("runs select 1");
    expect(journal.get(id)?.action).toEqual({ kind: "execute", payload: { sql: "select 1" } });
  });

  it("keeps a describe hook from overriding the delivery its definition declares", async () => {
    // `ActionPresentation` is a `Pick` of `ActionDescription`, so a port reusing a fully typed
    // description here type-checks -- and used to carry its `awaitDecision` past `execute`'s
    // declared `continue-with-simulation`.
    const { actions } = bind({
      describe: () => ({ ...presentation, awaitDecision: true, autoApprovable: false } as never),
    });
    const submitAction = submitSpy();

    const id = await actions.submit(fakeQueue(submitAction), "execute", { sql: "one" });

    expect(submitAction).toHaveBeenCalledWith(id, {
      ...presentation,
      actionKind: { tag: "sql", label: "Run SQL" },
      autoApprovable: true,
    });
  });

  it("declares the delivery hint the kind asked for, and no key when it did not", async () => {
    const { actions } = bind();
    const submitAction = submitSpy();
    const queue = fakeQueue(submitAction);

    // `publish` does not simulate its effect, so the agent must wait for the decision.
    await actions.submit(queue, "publish", { page: "p" });
    await actions.submit(queue, "execute", { sql: "one" });

    const [waiting, simulating] = submitAction.mock.calls.map(([, sent]) => sent);
    expect(waiting!.awaitDecision).toBe(true);
    // Absent, not `undefined`: the field is a hint the overseer reads as a declaration.
    expect(Object.hasOwn(simulating!, "awaitDecision")).toBe(false);
  });

  it("applies a record the overseer resolved before it was marked pending", async () => {
    const { actions, journal, host, outcomes } = bind();
    const id = journal.allocate({ kind: "execute", payload: { sql: "crash window" } });

    await actions.apply(id);
    expect(host.ran).toEqual(["crash window"]);
    expect(outcomes).toEqual(["applied"]);
  });

  it("refuses a definition that claims auto-approval without declaring a kind", () => {
    expect(() => defineActions<Host, { execute: Sql }>({
      execute: {
        autoApprovable: true,
        delivery: "continue-with-simulation",
        describe: () => presentation,
        apply: async () => {},
      },
    })).toThrow(/autoApprovable without a kind/);
  });

  it("refuses a tag whose siblings disagree about the label shown for it", () => {
    expect(() => defineActions<Host, { execute: Sql; publish: { page: string } }>({
      execute: {
        kind: { tag: "sql", label: "Run SQL" },
        delivery: "continue-with-simulation",
        describe: () => presentation,
        apply: async () => {},
      },
      publish: {
        kind: { tag: "sql", label: "Publish" },
        delivery: "continue-with-simulation",
        describe: () => presentation,
        apply: async () => {},
      },
    })).toThrow(/tag "sql" is declared with two labels, "Run SQL" and "Publish"/);
  });

  it("auto-approves only the kinds that declared it, not their tag siblings", async () => {
    const { actions } = bind();
    const submitAction = submitSpy();
    const queue = fakeQueue(submitAction);

    // `publish` shares `execute`'s tag and label but does not declare auto-approval, so an opt-in
    // the user granted the tag must not carry it.
    await actions.submit(queue, "execute", { sql: "one" });
    await actions.submit(queue, "publish", { page: "p" });

    expect(submitAction.mock.calls.map(([, sent]) => sent.autoApprovable)).toEqual([true, false]);
  });

  it("throws on an unknown id, and retains a record whose apply failed", async () => {
    const { actions, journal, outcomes } = bind({
      apply: async () => { throw new Error("syntax error"); },
    });
    await expect(actions.apply(99)).rejects.toThrow("Unknown pending action: 99");

    const id = journal.allocate({ kind: "execute", payload: { sql: "bad" } });
    await expect(actions.apply(id)).rejects.toThrow("syntax error");
    expect(journal.get(id)).toBeDefined();
    expect(outcomes).toEqual(["failed"]);
  });

  it("removes the record on apply by default", async () => {
    const { actions, journal } = bind();
    const id = journal.allocate({ kind: "execute", payload: { sql: "one" } });

    await actions.apply(id);
    expect(journal.get(id)).toBeUndefined();
  });

  it("retains the applied record carrying the artifacts the handler returned", async () => {
    const { actions, journal } = bind({
      retainApplied: true,
      apply: async payload => ({ action: { ...payload, rows: 7 } }),
    });
    const id = journal.allocate({ kind: "execute", payload: { sql: "one" } });

    await actions.apply(id);

    expect(journal.get(id)).toEqual({
      state: "applied",
      action: { kind: "execute", payload: { sql: "one", rows: 7 } },
    });
    expect(journal.listPending()).toEqual([]);
  });

  it("dispatches by kind rather than assuming the first definition", async () => {
    const { actions, journal, host } = bind();
    const id = journal.allocate({ kind: "publish", payload: { page: "home" } });

    await actions.apply(id);
    expect(host.ran).toEqual(["home"]);
  });

  it("settles a replayed apply of a retained record, but still refuses to reject it", async () => {
    const applied: string[] = [];
    const { actions, journal, host, outcomes } = bind({
      retainApplied: true,
      apply: async payload => void applied.push(payload.sql),
    });
    const id = journal.allocate({ kind: "execute", payload: { sql: "one" } });
    await actions.apply(id);

    // The overseer retries apply after crashing before its own state write. Nothing changed, so
    // the retry reports success without touching the provider or firing the invalidation hook.
    await expect(actions.apply(id)).resolves.toBeUndefined();
    expect(applied).toEqual(["one"]);
    expect(outcomes).toEqual(["applied"]);

    // The retained record is what a revert hook reads back, so a stray reject must not delete it.
    await expect(actions.reject(id)).rejects.toThrow(`Action ${id} is no longer pending.`);
    expect(host.ran).toEqual([]);
    expect(journal.get(id)).toBeDefined();
  });

  it("rejects a pending action once, and no-ops on an unknown id", async () => {
    const { actions, journal, host, outcomes } = bind();
    const id = journal.allocate({ kind: "execute", payload: { sql: "one" } });

    expect(await actions.reject(id)).toBeUndefined();
    expect(host.ran).toEqual(["rejected one"]);
    expect(journal.get(id)).toBeUndefined();

    expect(await actions.reject(id)).toBeUndefined();
    expect(outcomes).toEqual(["rejected"]);
  });

  it("reports an outcome the facet resolved itself", async () => {
    const { actions, outcomes } = bind();
    await actions.resolved("reverted");
    expect(outcomes).toEqual(["reverted"]);
  });

  it("reports a failed rejection for invalidation, keeping the record", async () => {
    const { actions, journal, outcomes } = bind({
      reject: async () => { throw new Error("cascade failed"); },
    });
    const id = journal.allocate({ kind: "execute", payload: { sql: "one" } });

    await expect(actions.reject(id)).rejects.toThrow("cascade failed");
    expect(outcomes).toEqual(["failed"]);
    expect(journal.get(id)).toBeDefined();
  });

  it("publishes the retention flag the facet's assert reads", () => {
    expect(bind().actions.retainsApplied).toBe(false);
    expect(bind({ retainApplied: true }).actions.retainsApplied).toBe(true);
  });

  it("never lets a failing invalidation hook mask or manufacture a result", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = { afterResolve: async () => { throw new Error("cache unreachable"); } };

      // A completed action stays completed: the hook cannot report success as failure.
      const applied = bind(failing);
      const first = applied.journal.allocate({ kind: "execute", payload: { sql: "one" } });
      await expect(applied.actions.apply(first)).resolves.toBeUndefined();
      expect(applied.host.ran).toEqual(["one"]);
      expect(applied.journal.get(first)).toBeUndefined();

      // A failed apply still reports the provider's own error, not the hook's.
      const failed = bind({ ...failing, apply: async () => { throw new Error("syntax error"); } });
      const second = failed.journal.allocate({ kind: "execute", payload: { sql: "bad" } });
      await expect(failed.actions.apply(second)).rejects.toThrow("syntax error");
      expect(failed.journal.get(second)).toBeDefined();

      // Dropped, but never silently: each failure is reported for someone to act on.
      expect(logged.mock.calls.map(([entry]) => (entry as { outcome: string }).outcome))
        .toEqual(["applied", "failed"]);
    } finally {
      logged.mockRestore();
    }
  });

  it("lists auto-approvable kinds only, deduped by tag", () => {
    const { actions } = bind();
    expect(actions.autoApprovableKinds()).toEqual([{ tag: "sql", label: "Run SQL" }]);
  });

  it("serializes concurrent resolutions of one id into a single provider effect", async () => {
    // The overseer validates that a record is still pending and then awaits before dispatching,
    // with the DO input gate open across that await, so two approvals of one id can both arrive.
    // Unserialized, both pass the journal check and both call the provider.
    const inFlight = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let started = 0;
    const { actions, host, journal } = bind({
      apply: async (payload, target) => {
        started += 1;
        entered.resolve();
        await inFlight.promise;
        target.ran.push(payload.sql);
      },
    });
    const id = journal.allocate({ kind: "execute", payload: { sql: "once" } });
    journal.markSubmitted(id);

    const first = actions.apply(id);
    const second = actions.apply(id);

    // Await the provider call itself rather than a delay: while the first is parked on `inFlight`,
    // the second cannot have started, because the gate only opens in the first's `finally`.
    await entered.promise;
    expect(started).toBe(1);

    inFlight.resolve();
    await first;
    // The first applied it; the second resolves as an idempotent retry, with no second effect.
    await expect(second).resolves.toBeUndefined();
    expect(host.ran).toEqual(["once"]);
    expect(started).toBe(1);
  });

  it("refuses a rejection racing the apply that already ran", async () => {
    // Same window, with the overseer's other callback: reporting success here would leave its
    // record "rejected" for an action the provider ran.
    const inFlight = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const { actions, host, journal } = bind({
      apply: async (payload, target) => {
        entered.resolve();
        await inFlight.promise;
        target.ran.push(payload.sql);
      },
    });
    const id = journal.allocate({ kind: "execute", payload: { sql: "once" } });
    journal.markSubmitted(id);

    const applied = actions.apply(id);
    const rejected = actions.reject(id);

    await entered.promise;
    inFlight.resolve();
    await applied;

    await expect(rejected).rejects.toThrow(`Action ${id} is no longer pending.`);
    // The reject handler never ran, so nothing contradicts the applied effect.
    expect(host.ran).toEqual(["once"]);
  });

  it("still no-ops a rejection replayed after the record is gone", async () => {
    // The overseer can crash before its own state write, and a later activation's retry has to be
    // able to settle the action: only ids the applied memory names are refused, and a rejected
    // removal leaves none.
    const { actions, journal, host, outcomes } = bind();
    const id = journal.allocate({ kind: "execute", payload: { sql: "one" } });
    journal.markSubmitted(id);

    await actions.reject(id);
    await expect(actions.reject(id)).resolves.toBeUndefined();

    expect(host.ran).toEqual(["rejected one"]);
    expect(outcomes).toEqual(["rejected"]);
  });

  it("settles a replayed resolution from a later activation after the applied record is gone", async () => {
    // The overseer offers retry-or-discard when the reply to a successful apply is lost. Durable
    // memory answers both: the retry resolves with no second provider call, and the discard is
    // refused rather than recorded as "rejected" for an action the provider ran.
    const dead = bind();
    const id = dead.journal.allocate({ kind: "execute", payload: { sql: "one" } });
    dead.journal.markSubmitted(id);
    await dead.actions.apply(id);
    expect(dead.journal.get(id)).toBeUndefined();

    const revived = bind({ journal: dead.journal });
    await expect(revived.actions.apply(id)).resolves.toBeUndefined();
    await expect(revived.actions.reject(id)).rejects.toThrow(`Action ${id} is no longer pending.`);
    expect(revived.host.ran).toEqual([]);
    expect(revived.outcomes).toEqual([]);
  });

  it("shares one queue with the facet's revert seam", async () => {
    // Revert lives outside this module, so a second queue beside `queue` would serialize
    // apply-vs-apply and revert-vs-revert while leaving apply-vs-revert interleaved.
    const applying = Promise.withResolvers<void>();
    const order: string[] = [];
    const { actions, journal } = bind({
      apply: async () => {
        order.push("apply:start");
        await applying.promise;
        order.push("apply:end");
      },
    });
    const id = journal.allocate({ kind: "execute", payload: { sql: "one" } });
    journal.markSubmitted(id);

    const applied = actions.apply(id);
    const reverted = actions.runExclusive(() => void order.push("revert"));

    applying.resolve();
    await Promise.all([applied, reverted]);
    expect(order).toEqual(["apply:start", "apply:end", "revert"]);
  });

  it("rolls a claim back when the handler leaves the action retryable", async () => {
    let attempts = 0;
    const { actions, journal, host, outcomes } = bind({
      claimBeforeApply: true,
      apply: async (payload, target) => {
        if (++attempts === 1) throw new Error("provider unreachable");
        target.ran.push(payload.sql);
      },
    });
    const id = journal.allocate({ kind: "execute", payload: { sql: "one" } });
    journal.markSubmitted(id);

    await expect(actions.apply(id)).rejects.toThrow("provider unreachable");
    // Back to pending rather than left claimed, or the retry below would read as an orphan.
    expect(journal.get(id)).toEqual({
      state: "pending",
      action: { kind: "execute", payload: { sql: "one" } },
    });

    await actions.apply(id);
    expect(host.ran).toEqual(["one"]);
    expect(outcomes).toEqual(["failed", "applied"]);
  });

  it("stores a terminal failure that no later attempt re-runs", async () => {
    let attempts = 0;
    const { actions, journal, outcomes } = bind({
      claimBeforeApply: true,
      apply: async () => {
        attempts += 1;
        throw new ActionApplyError("The provider already captured this payment.");
      },
    });
    const id = journal.allocate({ kind: "execute", payload: { sql: "one" } });
    journal.markSubmitted(id);

    await expect(actions.apply(id)).rejects.toThrow("already captured this payment");
    expect(journal.get(id)?.state).toBe("failed");
    // It must stop projecting: a read simulating this action would describe an effect that failed.
    expect(journal.listPending()).toEqual([]);

    // The stored message is the answer every replay gets, with no second provider call.
    await expect(actions.apply(id)).rejects.toThrow("The provider already captured this payment.");
    expect(attempts).toBe(1);

    // Only the user clearing it removes the record.
    await expect(actions.reject(id)).resolves.toBeUndefined();
    expect(journal.get(id)).toBeUndefined();
    expect(outcomes).toEqual(["failed", "rejected"]);
  });

  it("reports an unknown outcome for a claim whose activation died mid-dispatch", async () => {
    const entered = Promise.withResolvers<void>();
    // The first bind parks inside the provider call and never returns -- the activation is gone.
    const dead = bind({
      claimBeforeApply: true,
      apply: async () => {
        entered.resolve();
        await Promise.withResolvers<void>().promise;
      },
    });
    const applyId = dead.journal.allocate({ kind: "execute", payload: { sql: "apply" } });
    const rejectId = dead.journal.allocate({ kind: "execute", payload: { sql: "reject" } });
    void dead.actions.apply(applyId);
    await entered.promise;
    dead.journal.markClaimed(rejectId);

    const revived = bind({ journal: dead.journal, claimBeforeApply: true });

    // Neither verb may run a handler over it: the call went out and nothing here can say whether
    // the provider ran it, so the user is told exactly that.
    await expect(revived.actions.apply(applyId)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    await expect(revived.actions.reject(rejectId)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(revived.host.ran).toEqual([]);
    expect(revived.journal.get(applyId)?.error).toBe(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(revived.journal.get(rejectId)?.state).toBe("failed");
    expect(revived.outcomes).toEqual(["failed", "failed"]);
  });

  it("never rolls a claim back once the provider effect has landed", async () => {
    // The post-apply journal write is the one failure that must not read as retryable: the
    // provider already ran, so restoring `pending` would offer the user a second irreversible
    // apply. No invalidation hook fires either — the write that would have justified one failed.
    const kv = makeKv();
    const journal = new ActionJournal<TaggedAction<Actions>>({
      ...kv,
      delete: key => { throw new Error(`storage unavailable: ${key}`); },
    });
    const { actions, host, outcomes } = bind({ journal, claimBeforeApply: true });
    const id = journal.allocate({ kind: "execute", payload: { sql: "one" } });
    journal.markSubmitted(id);

    await expect(actions.apply(id)).rejects.toThrow("storage unavailable");
    expect(host.ran).toEqual(["one"]);
    expect(journal.get(id)?.state).toBe("claimed");
    expect(outcomes).toEqual([]);

    // The claim outlived the attempt that wrote it, so the next one reports the unknown outcome
    // rather than running the handler over an effect that already happened.
    await expect(actions.apply(id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(host.ran).toEqual(["one"]);
    expect(outcomes).toEqual(["failed"]);
  });

  it("refuses to submit past the pending cap, leaving nothing staged", async () => {
    const { actions, journal } = bind({ maxPending: 2 });
    const submitAction = submitSpy();
    const queue = fakeQueue(submitAction);

    await actions.submit(queue, "execute", { sql: "one" });
    await actions.submit(queue, "execute", { sql: "two" });

    await expect(actions.submit(queue, "execute", { sql: "three" }))
      .rejects.toThrow(/Too many pending actions/);
    expect(submitAction).toHaveBeenCalledTimes(2);
    expect(journal.listPending().map(({ id }) => id)).toEqual([1, 2]);
  });

  it("hands the handlers the journal id, which a provider idempotency key can be derived from", async () => {
    const seen: number[] = [];
    const { actions, journal } = bind({
      apply: async (_payload, _host, ctx) => void seen.push(ctx.id),
      reject: async (_payload, _host, ctx) => void seen.push(ctx.id),
    });
    const applied = journal.allocate({ kind: "execute", payload: { sql: "one" } });
    const rejected = journal.allocate({ kind: "execute", payload: { sql: "two" } });

    await actions.apply(applied);
    await actions.reject(rejected);
    expect(seen).toEqual([applied, rejected]);
  });

  /** A record deploy A staged under a kind deploy B has since renamed or removed. */
  function staleKind(kind = "archive") {
    const journal = new ActionJournal<TaggedAction<Actions>>(makeKv());
    const id = journal.allocate({ kind, payload: { sql: "one" } } as never);
    journal.markSubmitted(id);
    return { id, ...bind({ journal }) };
  }

  it("fails a dropped kind terminally instead of throwing a TypeError", async () => {
    const { id, actions, journal, outcomes } = staleKind();

    await expect(actions.apply(id)).rejects.toThrow(/no longer supports/);
    // Terminal, so it stops projecting into every later read.
    expect(journal.get(id)?.state).toBe("failed");
    expect(journal.listPending()).toEqual([]);
    expect(outcomes).toEqual(["failed"]);
  });

  // Indexing the declarations object resolves these to `Object`, whose `apply` is
  // `Function.prototype.apply`: it returns a truthy `{}`, so the record would be removed as applied
  // with no provider call.
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
    "treats the inherited name %s as a dropped kind, not a handler", async name => {
      const { id, actions, journal, host } = staleKind(name);

      await expect(actions.apply(id)).rejects.toThrow(/no longer supports/);
      expect(journal.get(id)?.state).toBe("failed");
      expect(host.ran).toEqual([]);
    });

  it("dispatches a numeric kind, which the declaration stringified", async () => {
    // `submit` reaches its definition by property access, which coerces `7` to `"7"`; a Map lookup
    // does not. Uncoerced, the set reports a kind unsupported that it had just accepted.
    const host: Host = { ran: [] };
    const journal = new ActionJournal<TaggedAction<{ 7: Sql }>>(makeKv());
    const actions = defineActions<Host, { 7: Sql }>({
      7: {
        delivery: "await-decision",
        describe: () => presentation,
        apply: async (payload, target) => void target.ran.push(payload.sql),
      },
    }).bind(journal, host);

    const id = journal.allocate({ kind: 7, payload: { sql: "one" } });
    journal.markSubmitted(id);

    await actions.apply(id);
    expect(host.ran).toEqual(["one"]);
  });

  it("rebinds a journal to the first bound set, so a per-call bind still shares one queue", () => {
    const host: Host = { ran: [] };
    const journal = new ActionJournal<TaggedAction<{ execute: Sql }>>(makeKv());
    const set = defineActions<Host, { execute: Sql }>({
      execute: {
        delivery: "await-decision",
        describe: () => presentation,
        apply: async (payload, target) => void target.ran.push(payload.sql),
      },
    });

    const actions = set.bind(journal, host);
    expect(set.bind(journal, host)).toBe(actions);
    expect(() => set.bind(journal, { ran: [] })).toThrow(/different host/);
  });

  it("retires a dropped kind on reject, which needs no definition", async () => {
    const { id, actions, journal, outcomes } = staleKind();

    await actions.reject(id);
    expect(journal.get(id)).toBeUndefined();
    expect(outcomes).toEqual(["rejected"]);
  });
});

describe("dependent actions", () => {
  type Actions = { create: { ref: string }; edit: { target: string } };
  type Host = { ran: string[] };

  function bind(overrides: { apply?: () => Promise<void> } = {}) {
    const host: Host = { ran: [] };
    const journal = new ActionJournal<TaggedAction<Actions>>(makeKv());
    const set = defineActions<Host, Actions>({
      create: {
        delivery: "continue-with-simulation",
        describe: () => presentation,
        // A creation both stands for the entity it will make and may target an earlier one.
        provides: payload => [payload.ref],
        dependsOn: payload => (payload.ref.startsWith("child-") ? [payload.ref.slice(6)] : []),
        apply: overrides.apply ?? (async () => {}),
      },
      edit: {
        delivery: "continue-with-simulation",
        describe: () => presentation,
        dependsOn: payload => [payload.target],
        apply: overrides.apply ?? (async () => {}),
      },
    });
    return { host, journal, actions: set.bind(journal, host) };
  }

  /** Allocate and mark submitted, which is the state the overseer decides on. */
  function queued(journal: ActionJournal<TaggedAction<Actions>>, action: TaggedAction<Actions>) {
    const id = journal.allocate(action);
    journal.markSubmitted(id);
    return id;
  }

  it("retires the actions a rejected creation strands, transitively", async () => {
    const { actions, journal } = bind();
    const create = queued(journal, { kind: "create", payload: { ref: "~1" } });
    const child = queued(journal, { kind: "create", payload: { ref: "child-~1" } });
    const grandchild = queued(journal, { kind: "edit", payload: { target: "child-~1" } });
    const edit = queued(journal, { kind: "edit", payload: { target: "~1" } });
    const unrelated = queued(journal, { kind: "edit", payload: { target: "~9" } });

    await actions.reject(create);

    // Each stranded record answers with a reason rather than vanishing, and stops projecting.
    for (const id of [child, grandchild, edit]) {
      expect(journal.get(id)?.state).toBe("failed");
      expect(journal.get(id)?.error)
        .toBe(`This action needed action ${create}, which was not applied.`);
    }
    expect(journal.listPending().map(({ id }) => id)).toEqual([unrelated]);
  });

  it("retires them for a terminal failure too, which no provider effect can resolve", async () => {
    const { actions, journal } = bind({
      apply: async () => { throw new ActionApplyError("the provider refused"); },
    });
    const create = queued(journal, { kind: "create", payload: { ref: "~1" } });
    const edit = queued(journal, { kind: "edit", payload: { target: "~1" } });

    await expect(actions.apply(create)).rejects.toThrow("the provider refused");
    expect(journal.get(edit)?.state).toBe("failed");
  });

  it("leaves dependents decidable when a claim's outcome is unknown", async () => {
    // The stored answer says the effect may have landed, so "was not applied" cannot be asserted
    // over the dependents -- the dispatch may have created the very entity they name.
    const { actions, journal } = bind();
    const create = queued(journal, { kind: "create", payload: { ref: "~1" } });
    const edit = queued(journal, { kind: "edit", payload: { target: "~1" } });
    // Claimed by an activation that died holding the dispatch.
    journal.markClaimed(create);

    await expect(actions.apply(create)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(journal.get(edit)?.state).toBe("pending");
  });

  it("leaves dependents alone while the creation can still be retried", async () => {
    const { actions, journal } = bind({
      apply: async () => { throw new Error("provider unreachable"); },
    });
    const create = queued(journal, { kind: "create", payload: { ref: "~1" } });
    const edit = queued(journal, { kind: "edit", payload: { target: "~1" } });

    await expect(actions.apply(create)).rejects.toThrow("provider unreachable");
    expect(journal.listPending().map(({ id }) => id)).toEqual([create, edit]);
  });

  it("keeps dependents when the creation applies, which is what resolves their reference", async () => {
    const { actions, journal } = bind();
    const create = queued(journal, { kind: "create", payload: { ref: "~1" } });
    const edit = queued(journal, { kind: "edit", payload: { target: "~1" } });

    await actions.apply(create);
    expect(journal.listPending().map(({ id }) => id)).toEqual([edit]);
  });

  it("refuses a bare reference string at the type level", () => {
    // The spelling every cascading gatekeeper's scalar reference invites. Under `Iterable<string>`
    // it compiled and cascaded over characters, stranding actions that shared one.
    type Refs = ActionDefinition<{ ref: string }, Host>;
    // @ts-expect-error - a bare string is not an array of references.
    const provides: Refs["provides"] = payload => payload.ref;
    // @ts-expect-error - and neither is a nullable one, the shape `actionPageId` returns.
    const dependsOn: Refs["dependsOn"] = payload => payload.ref || null;

    const ok: Refs["provides"] = payload => [payload.ref];
    expect(ok?.({ ref: "issue-12" })).toEqual(["issue-12"]);
    expect([provides, dependsOn].every(fn => typeof fn === "function")).toBe(true);
  });
});
