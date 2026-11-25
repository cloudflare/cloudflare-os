import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PROPERTY_RUN_OPTIONS } from "@gadgets/scripts/property-runs";
import { createSimulationView, ProvisionalIds, type SimulationRecord } from "../src/simulation";
import {
  createSimulationStore,
  simulatedList,
  type EntityContext,
  type EntityFold,
  type EntityStep,
  type SimulationStoreOptions,
} from "../src/simulation-store";
import { SerialTaskQueue } from "../src/serial-queue";
import { fakeKv } from "./fake-kv";

// The fixture is a gatekeeper whose entities are pages of lines. Its reducer refuses what it
// cannot replay on a page and goes on, and the caller marks the refused records afterwards:
// a marked record carries the reason and is left out of the lists handed to `fold`.
type Action = {
  /** The pages the record changes. One with none targets page `a`. */
  readonly on?: readonly string[];
} & (
  | { kind: "add"; text: string }
  | { kind: "noop" }
  | { kind: "refuse"; why: string; closes?: true }
  | { kind: "needs"; text: string }
  | { kind: "gated"; text: string }
  | { kind: "create" }
  | { kind: "delete" }
  | { kind: "stop"; why: string; over?: number }
);
type Queued = SimulationRecord<Action> & { readonly invalid?: string };
type Base = { readonly seed: readonly string[] };
type Page = { readonly lines: readonly string[] };
/** `closes` is on a refusal after which a `gated` record of the same call is refused. */
type Refusal = { readonly reason: string; readonly closes?: true };
type Context = EntityContext<string, Base, Refusal>;
type Fold = EntityFold<Page, Queued, Refusal>;

const initial = (base: Base): Page => ({ lines: base.seed });
const wrote = (page: Page, text: string): EntityStep<Page, Refusal> =>
  ({ kind: "applied", value: { lines: [...page.lines, text] } });
const declined = (reason: string, closes?: true): EntityStep<Page, Refusal> =>
  ({ kind: "refused", refusal: closes ? { reason, closes } : { reason } });

/**
 * `needs` is applied or refused by the base, as a document's refusals are, and `gated` by the
 * page and by the refusals of the call, as a change to a document's tables is.
 */
function reduce(page: Page | undefined, record: Queued, context: Context): EntityStep<Page, Refusal> {
  const { action } = record;
  switch (action.kind) {
    case "add": return page === undefined ? declined("no page") : wrote(page, action.text);
    case "noop": return { kind: "known-no-effect" };
    case "refuse": return declined(action.why, action.closes);
    case "needs":
      if (page === undefined) return declined("no page");
      return context.base?.seed.includes(action.text)
        ? wrote(page, action.text)
        : declined(`no ${action.text}`);
    case "gated":
      if (page === undefined || page.lines.length % 4 === 3) return declined("no room", true);
      return context.refusals.some(({ closes }) => closes)
        ? declined("gate closed")
        : wrote(page, action.text);
    case "create":
      return page === undefined
        ? { kind: "applied", value: { lines: [`made by ${record.id}`] } }
        : { kind: "known-no-effect" };
    case "delete": return page === undefined ? { kind: "known-no-effect" } : { kind: "deleted" };
    case "stop":
      return action.over === undefined || (page?.lines.length ?? 0) > action.over
        ? { kind: "unsupported", reason: action.why }
        : { kind: "known-no-effect" };
  }
}

/** The oracle: one pass over the records with the reducer itself, through no store. */
function fresh(id: string, base: Base | undefined, records: readonly Queued[]): Fold {
  let entity = base === undefined ? undefined : initial(base);
  const refused: { record: Queued; refusal: Refusal }[] = [];
  for (const record of records) {
    const refusals = refused.map(({ refusal }) => refusal);
    const step = reduce(entity, record, { id, base, refusals });
    if (step.kind === "applied") entity = step.value;
    else if (step.kind === "deleted") entity = undefined;
    else if (step.kind === "refused") refused.push({ record, refusal: step.refusal });
    else if (step.kind === "unsupported") {
      return { entity, refused, stopped: { record, reason: step.reason } };
    }
  }
  return { entity, refused };
}

const targets = (action: Action): readonly string[] => action.on ?? ["a"];
const unmarked = (record: Queued): boolean => record.invalid === undefined;
/** The list with every record of `ids` marked, as a journal hands it back after the marks. */
const marked = (records: readonly Queued[], ids: Iterable<number>): Queued[] => {
  const which = new Set(ids);
  return records.map(record => (which.has(record.id) ? { ...record, invalid: "refused" } : record));
};
const refusedIds = (result: Fold): number[] => result.refused.map(({ record }) => record.id);

const on = (record: Queued, ...pages: string[]): Queued =>
  ({ ...record, action: { ...record.action, on: pages } });
const add = (id: number, text = `line ${id}`): Queued => ({ id, action: { kind: "add", text } });
const noop = (id: number): Queued => ({ id, action: { kind: "noop" } });
const refuse = (id: number, why: string, closes?: true): Queued =>
  ({ id, action: { kind: "refuse", why, ...(closes && { closes }) } });
const needs = (id: number, text: string): Queued => ({ id, action: { kind: "needs", text } });
const gated = (id: number, text = `line ${id}`): Queued =>
  ({ id, action: { kind: "gated", text } });
const create = (id: number): Queued => ({ id, action: { kind: "create" } });
const remove = (id: number): Queued => ({ id, action: { kind: "delete" } });
const stop = (id: number, why: string): Queued => ({ id, action: { kind: "stop", why } });

/** A store over the fixture that notes what `reduce` and `initial` were called with. */
function counting() {
  const calls: number[] = [];
  const contexts: Context[] = [];
  const initials: Base[] = [];
  const store = createSimulationStore<string, Base, Page, Queued, Refusal>({
    initial: base => {
      initials.push(base);
      return initial(base);
    },
    reduce: (page, record, context) => {
      calls.push(record.id);
      contexts.push({ ...context, refusals: [...context.refusals] });
      return reduce(page, record, context);
    },
  });
  const reset = () => {
    calls.length = 0;
    contexts.length = 0;
    initials.length = 0;
  };
  return { store, calls, contexts, initials, reset };
}

/** A page a reducer may write. */
type Draft = { lines: string[] };
/** The draft of a page: its own lines, never the base's. */
const draft = (base: Base): Draft => ({ lines: [...base.seed] });
/**
 * `reduce`, working in place: it decides as `reduce` does, then writes the page it was given
 * and returns it, where `reduce` returns another page. A created page is built here.
 */
function reduceInPlace(
  page: Draft | undefined, record: Queued, context: Context,
): EntityStep<Draft, Refusal> {
  const step = reduce(page, record, context);
  if (step.kind !== "applied") return step;
  if (page === undefined) return { kind: "applied", value: { lines: [...step.value.lines] } };
  page.lines.push(...step.value.lines.slice(page.lines.length));
  return { kind: "applied", value: page };
}

/** A base no reducer can write: a write to it, or to its seed, throws. */
const frozen = (seed: readonly string[]): Base => Object.freeze({ seed: Object.freeze([...seed]) });

/** A store that notes the records `reduce` was given, as given, and how often `initial` ran. */
function noting<Entity>(options: SimulationStoreOptions<string, Base, Entity, Queued, Refusal>) {
  const seen: Queued[] = [];
  const noted = { drafts: 0 };
  const store = createSimulationStore<string, Base, Entity, Queued, Refusal>({
    initial: base => {
      noted.drafts++;
      return options.initial(base);
    },
    reduce: (entity, record, context) => {
      seen.push(record);
      return options.reduce(entity, record, context);
    },
  });
  const reset = () => {
    seen.length = 0;
    noted.drafts = 0;
  };
  return { store, seen, noted, reset };
}

const alphabet = ["a", "b", "c"];
const letter = fc.constantFrom(...alphabet);
const anyChange: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("add" as const), text: letter }) },
  { weight: 1, arbitrary: fc.constant({ kind: "noop" as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("refuse" as const), why: letter }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("refuse" as const), why: letter, closes: fc.constant(true as const),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("needs" as const), text: letter }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("gated" as const), text: letter }) },
  { weight: 1, arbitrary: fc.constant({ kind: "create" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "delete" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("stop" as const), why: letter, over: fc.constantFrom(2, 4),
    }),
  },
);

/** An entity as the whole-queue reference leaves it: what it refused and stopped at, by id. */
type Seen = { entity: Page | undefined; refused: number[]; refusals: Refusal[]; stopped?: number };
/** The whole-queue reference: every unmarked record once, for each entity it targets. */
const wholeQueue = (
  bases: ReadonlyMap<string, Base>,
  records: readonly Queued[],
  resolved: (action: Action) => readonly string[],
): Map<string, Seen> => {
  const seen = new Map<string, Seen>();
  for (const [id, base] of bases) {
    seen.set(id, { entity: initial(base), refused: [], refusals: [] });
  }
  for (const record of records) {
    if (!unmarked(record)) continue;
    for (const id of new Set(resolved(record.action))) {
      let state = seen.get(id);
      if (state === undefined) {
        state = { entity: undefined, refused: [], refusals: [] };
        seen.set(id, state);
      }
      if (state.stopped !== undefined) continue;
      const step = reduce(
        state.entity, record, { id, base: bases.get(id), refusals: [...state.refusals] });
      if (step.kind === "applied") state.entity = step.value;
      else if (step.kind === "deleted") state.entity = undefined;
      else if (step.kind === "refused") {
        state.refused.push(record.id);
        state.refusals.push(step.refusal);
      } else if (step.kind === "unsupported") state.stopped = record.id;
    }
  }
  return seen;
};

/** A generator of numbers in [0, 1) that gives the same sequence for the same seed. */
const seeded = (seed: number) => {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
/** The changes a generated record is picked from. */
const changes = (text: string): Action[] => [
  { kind: "create" }, { kind: "delete" },
  { kind: "add", text }, { kind: "add", text }, { kind: "add", text },
  { kind: "gated", text }, { kind: "gated", text },
  { kind: "needs", text: "a" }, { kind: "refuse", why: text, closes: true },
  { kind: "noop" }, { kind: "stop", why: text, over: 3 },
];

describe("createSimulationStore", () => {
  const base: Base = { seed: ["seed"] };

  it("folds the records over the entity in order", () => {
    const complete = [add(1), noop(2), refuse(3, "no"), add(4)];
    expect(counting().store.fold("a", base, complete)).toEqual(fresh("a", base, complete));
    expect(fresh("a", base, complete)).toEqual({
      entity: { lines: ["seed", "line 1", "line 4"] },
      refused: [{ record: complete[2], refusal: { reason: "no" } }],
    });

    const stopping = [add(1), stop(2, "cannot"), add(3)];
    expect(counting().store.fold("a", base, stopping)).toEqual(fresh("a", base, stopping));
    expect(fresh("a", base, stopping).stopped).toEqual({ record: stopping[1], reason: "cannot" });
  });

  it("folds nothing for an entity with no base and no record", () => {
    const { store, calls, initials } = counting();

    expect(store.fold("a", undefined, [])).toEqual({ entity: undefined, refused: [] });
    expect(store.fold("a", undefined, [])).not.toHaveProperty("stopped");
    expect(calls).toEqual([]);
    expect(initials).toEqual([]);
  });

  it("gives every reduce call the id, the base and the refusals of the call so far", () => {
    const { store, contexts } = counting();
    store.fold("a", base, [add(1), refuse(2, "first"), noop(3), refuse(4, "second", true), add(5)]);

    expect(contexts).toHaveLength(5);
    for (const context of contexts) {
      expect(context.id).toBe("a");
      expect(context.base).toBe(base);
    }
    expect(contexts.map(({ refusals }) => refusals)).toEqual([
      [],
      [],
      [{ reason: "first" }],
      [{ reason: "first" }],
      [{ reason: "first" }, { reason: "second", closes: true }],
    ]);
  });

  it("reduces every record, up to the first unsupported one, at every call", () => {
    const { store, calls, initials, reset } = counting();
    const list = [add(1), noop(2), add(3)];
    const first = store.fold("a", base, list);
    const again = store.fold("a", base, list);
    expect(calls).toEqual([1, 2, 3, 1, 2, 3]);
    expect(initials).toHaveLength(2);
    expect(initials[0]).toBe(base);
    expect(initials[1]).toBe(base);
    expect(again).toEqual(first);
    expect(again.entity).not.toBe(first.entity);
    reset();

    const stopping = [add(1), stop(2, "x"), add(3)];
    expect(store.fold("a", base, stopping)).toEqual(store.fold("a", base, stopping));
    expect(calls).toEqual([1, 2, 1, 2]);
    reset();

    const made = [create(1), add(2)];
    expect(store.fold("a", undefined, made)).toEqual(store.fold("a", undefined, made));
    expect(initials).toEqual([]);
    expect(calls).toEqual([1, 2, 1, 2]);
  });

  it("folds a record as it reads at the call, whatever a record of its id read before", () => {
    const { store } = counting();
    expect(store.fold("a", base, [add(1, "old")]).entity?.lines).toEqual(["seed", "old"]);
    expect(store.fold("a", base, [add(1, "new")]).entity?.lines).toEqual(["seed", "new"]);
  });

  it("folds one base object under two ids apart, and two bases under one id apart", () => {
    const { store, contexts } = counting();
    const other: Base = { seed: ["other"] };
    const list = [add(1), needs(2, "other"), add(3)];

    const a = store.fold("a", base, list);
    const b = store.fold("b", base, [add(4)]);
    expect(a).toEqual(fresh("a", base, list));
    expect(b).toEqual(fresh("b", base, [add(4)]));
    expect(store.fold("a", base, list)).toEqual(a);
    expect(contexts.map(({ id }) => id)).toEqual(["a", "a", "a", "b", "a", "a", "a"]);

    const held = store.fold("a", other, list);
    expect(held).toEqual(fresh("a", other, list));
    expect(held.entity?.lines).toEqual(["other", "line 1", "other", "line 3"]);
    expect(store.fold("a", base, list)).toEqual(a);
    expect(store.fold("a", other, list)).toEqual(held);
  });

  it("goes on past a record with no effect", () => {
    const { store } = counting();
    expect(store.fold("a", base, [add(1), noop(2), add(3)])).toEqual({
      entity: { lines: ["seed", "line 1", "line 3"] },
      refused: [],
    });

    const longer = [add(1), noop(2), add(3), noop(4), add(5)];
    expect(store.fold("a", base, longer)).toEqual(fresh("a", base, longer));
  });

  it("makes an entity the provider does not hold from a record that creates it", () => {
    const { store, initials } = counting();
    expect(store.fold("p1", undefined, [add(1), create(2), add(3)])).toEqual({
      entity: { lines: ["made by 2", "line 3"] },
      refused: [{ record: add(1), refusal: { reason: "no page" } }],
    });
    expect(initials).toEqual([]);

    // The record refused before the create is left out.
    const longer = [create(2), add(3), add(4)];
    expect(store.fold("p1", undefined, longer)).toEqual(fresh("p1", undefined, longer));
    expect(store.fold("p2", undefined, longer)).toEqual(fresh("p2", undefined, longer));
  });

  it("re-creates an entity after a record deleted it", () => {
    const { store } = counting();
    const deleting = [add(1), remove(2)];
    expect(store.fold("a", base, deleting)).toEqual({ entity: undefined, refused: [] });

    const list = [...deleting, add(3), create(4), add(5)];
    expect(store.fold("a", base, list)).toEqual({
      entity: { lines: ["made by 4", "line 5"] },
      refused: [{ record: list[2], refusal: { reason: "no page" } }],
    });
  });

  it("stops at the first unsupported record", () => {
    const { store, calls } = counting();
    const list = [add(1), refuse(2, "no"), stop(3, "cannot"), add(4)];
    const result = store.fold("a", base, list);

    expect(result).toEqual({
      entity: { lines: ["seed", "line 1"] },
      refused: [{ record: list[1], refusal: { reason: "no" } }],
      stopped: { record: list[2], reason: "cannot" },
    });
    expect(result.stopped?.record).toBe(list[2]);
    expect(calls).toEqual([1, 2, 3]);
  });

  it("goes on past a refused record and reports it", () => {
    const { store } = counting();
    const list = [add(1), refuse(2, "not here"), add(3)];
    const result = store.fold("a", base, list);

    expect(result).toEqual({
      entity: { lines: ["seed", "line 1", "line 3"] },
      refused: [{ record: list[1], refusal: { reason: "not here" } }],
    });
    expect(result.refused[0].record).toBe(list[1]);
  });

  it("gives a record added after a refused one was left out none of its refusals", () => {
    const { store, calls, contexts, reset } = counting();
    const list = [add(1), refuse(2, "first", true)];
    store.fold("a", base, list);
    reset();

    const longer = [list[0], gated(3)];
    const result = store.fold("a", base, longer);
    expect(calls).toEqual([1, 3]);
    expect(contexts[0].refusals).toEqual([]);
    expect(contexts[1].refusals).toEqual([]);
    expect(result).toEqual(fresh("a", base, longer));
    expect(result.entity).toEqual({ lines: ["seed", "line 1", "line 3"] });
  });

  it("folds a record that targets several entities for each alone: refused on one, it still " +
    "applies to the other until it is left out", () => {
    const { store } = counting();
    const has: Base = { seed: ["x"] };
    const lacks: Base = { seed: [] };
    const pending = [add(1), on(needs(2, "x"), "a", "b"), on(add(3), "b")];
    const view = createSimulationView(pending, targets);
    expect(view.forTarget("a").map(({ id }) => id)).toEqual([1, 2]);
    expect(view.forTarget("b").map(({ id }) => id)).toEqual([2, 3]);

    const a = store.fold("a", lacks, view.forTarget("a"));
    expect(a).toEqual({
      entity: { lines: ["line 1"] },
      refused: [{ record: pending[1], refusal: { reason: "no x" } }],
    });
    // The other entity's fold knows nothing of that refusal.
    expect(store.fold("b", has, view.forTarget("b"))).toEqual({
      entity: { lines: ["x", "x", "line 3"] },
      refused: [],
    });

    // The caller marks what the fold of `a` refused and leaves it out of every list: `a` reads
    // as it did, and `b` without the record.
    const left = createSimulationView(marked(pending, refusedIds(a)).filter(unmarked), targets);
    expect(store.fold("a", lacks, left.forTarget("a"))).toEqual(
      { entity: { lines: ["line 1"] }, refused: [] });
    expect(store.fold("b", has, left.forTarget("b"))).toEqual(
      { entity: { lines: ["x", "line 3"] }, refused: [] });
  });

  it("lets a throw from initial or reduce pass, and folds from the beginning at the next call", () => {
    const calls: number[] = [];
    const broken: Base = { seed: ["broken"] };
    const store = createSimulationStore<string, Base, Page, Queued, Refusal>({
      initial: given => {
        if (given === broken) throw new Error("no initial entity");
        return initial(given);
      },
      reduce: (page, record, context) => {
        calls.push(record.id);
        if (record.action.kind === "add" && record.action.text === "boom") throw new Error("boom");
        return reduce(page, record, context);
      },
    });
    expect(() => store.fold("a", base, [add(1), add(2), add(3, "boom")])).toThrow("boom");
    calls.length = 0;
    const fixed = [add(1), add(2), add(4)];
    expect(store.fold("a", base, fixed)).toEqual(fresh("a", base, fixed));
    expect(calls).toEqual([1, 2, 4]);

    expect(() => store.fold("a", broken, fixed)).toThrow("no initial entity");
    const other: Base = { seed: ["other"] };
    expect(store.fold("a", other, fixed)).toEqual(fresh("a", other, fixed));
  });

  it("takes as applied the entity a reducer was given", () => {
    const inPlace = createSimulationStore<string, Base, string[], Queued>({
      initial: given => [...given.seed],
      reduce: (lines, record) => {
        lines?.push(`line ${record.id}`);
        return { kind: "applied", value: lines ?? [] };
      },
    });
    expect(inPlace.fold("a", base, [add(1)])).toEqual({ entity: ["seed", "line 1"], refused: [] });
    expect(base.seed).toEqual(["seed"]);

    const unchanged = createSimulationStore<string, Base, Base, Queued>({
      initial: given => given,
      reduce: () => ({ kind: "known-no-effect" }),
    });
    const left = unchanged.fold("a", base, [add(1), add(2)]);
    expect(left).toEqual({ entity: base, refused: [] });
    expect(left.entity).toBe(base);

    const primitive = createSimulationStore<string, Base, number, Queued>({
      initial: () => 0,
      reduce: count => ({ kind: "applied", value: count ?? 0 }),
    });
    expect(primitive.fold("a", base, [add(1), add(2)])).toEqual({ entity: 0, refused: [] });
  });

  it("returns a frozen object that holds nothing", () => {
    const { store } = counting();
    expect(Object.isFrozen(store)).toBe(true);
    expect(Object.keys(store)).toEqual(["fold"]);
    expect("forget" in store).toBe(false);
  });

  it("lets a reducer change the draft in place and return it as applied", () => {
    const held = frozen(["seed"]);
    const made: Draft[] = [];
    const store = createSimulationStore<string, Base, Draft, Queued, Refusal>({
      initial: given => {
        made.push(draft(given));
        return made[made.length - 1];
      },
      reduce: reduceInPlace,
    });
    const { entity } = store.fold("a", held, [add(1), add(2)]);

    expect(made).toHaveLength(1);
    expect(entity).toBe(made[0]);
    expect(entity?.lines).toEqual(["seed", "line 1", "line 2"]);
    expect(held.seed).toEqual(["seed"]);
  });

  // The fold hands `reduce` what `initial` returned and takes no copy of it. Which is why a
  // store whose reducer works in place makes its draft in `initial`.
  it("copies nothing itself: a reducer that writes a draft `initial` did not make writes the " +
    "caller's base", () => {
    const store = createSimulationStore<string, string[], string[], Queued>({
      initial: lines => lines,
      reduce: (lines, record) => {
        lines?.push(`line ${record.id}`);
        return { kind: "applied", value: lines ?? [] };
      },
    });
    const held = ["seed"];

    expect(store.fold("a", held, [add(1)]).entity).toBe(held);
    expect(held).toEqual(["seed", "line 1"]);
    expect(store.fold("a", held, [add(1)]).entity).toEqual(["seed", "line 1", "line 1"]);
  });

  it("leaves the draft as it was for a refused, a known-no-effect and an unsupported step", () => {
    const held = frozen(["seed"]);
    const made: Draft[] = [];
    const around = new Map<number, { before: Draft | undefined; after: Draft | undefined }>();
    const store = createSimulationStore<string, Base, Draft, Queued, Refusal>({
      initial: given => {
        made.push(draft(given));
        return made[made.length - 1];
      },
      reduce: (page, record, context) => {
        const before = structuredClone(page);
        const step = reduceInPlace(page, record, context);
        around.set(record.id, { before, after: structuredClone(page) });
        return step;
      },
    });
    const list =
      [add(1), refuse(2, "no"), noop(3), needs(4, "absent"), stop(5, "x"), add(6)];
    const result = store.fold("a", held, list);

    for (const id of [2, 3, 4, 5]) {
      expect(around.get(id)?.after, `record ${id}`).toEqual(around.get(id)?.before);
      expect(around.get(id)?.before, `record ${id}`).toEqual({ lines: ["seed", "line 1"] });
    }
    expect(around.has(6)).toBe(false);
    expect(result.entity).toBe(made[0]);
    expect(result.entity?.lines).toEqual(["seed", "line 1"]);
    expect(refusedIds(result)).toEqual([2, 4]);
    expect(result.stopped).toEqual({ record: list[4], reason: "x" });
  });

  it("starts another draft where a create follows a delete", () => {
    const made: Draft[] = [];
    const store = createSimulationStore<string, Base, Draft, Queued, Refusal>({
      initial: given => {
        made.push(draft(given));
        return made[made.length - 1];
      },
      reduce: reduceInPlace,
    });
    const { entity } = store.fold("a", frozen(["seed"]), [add(1), remove(2), create(3), add(4)]);

    expect(entity).toEqual({ lines: ["made by 3", "line 4"] });
    expect(made).toHaveLength(1);
    expect(entity).not.toBe(made[0]);
    expect(made[0].lines).toEqual(["seed", "line 1"]);

    expect(store.fold("a", frozen(["seed"]), [remove(1)])).toEqual(
      { entity: undefined, refused: [] });
  });

  describe("a base of any value", () => {
    /** A store whose base may be anything, which notes the bases its reducer was given. */
    const anyBase = () => {
      const initials: unknown[] = [];
      const bases: unknown[] = [];
      const store = createSimulationStore<string, unknown, { from: unknown; ids: number[] }, Queued>({
        initial: given => {
          initials.push(given);
          return { from: given, ids: [] };
        },
        reduce: (entity, record, context) => {
          bases.push(context.base);
          return {
            kind: "applied",
            value: entity === undefined
              ? { from: "no base", ids: [record.id] }
              : { ...entity, ids: [...entity.ids, record.id] },
          };
        },
      });
      return { store, initials, bases };
    };

    it.each([0, "", false, null, "text"])("takes %j for a base", value => {
      const { store, initials, bases } = anyBase();

      expect(store.fold("a", value, [add(1), add(2)])).toEqual(
        { entity: { from: value, ids: [1, 2] }, refused: [] });
      expect(initials).toHaveLength(1);
      expect(initials[0]).toBe(value);
      expect(bases).toHaveLength(2);
      for (const given of bases) expect(given).toBe(value);

      expect(store.fold("a", value, []).entity).toEqual({ from: value, ids: [] });
      expect(initials).toHaveLength(2);
      expect(initials[1]).toBe(value);
    });

    it("takes only undefined for no base", () => {
      const { store, initials, bases } = anyBase();

      expect(store.fold("a", undefined, [add(1)])).toEqual(
        { entity: { from: "no base", ids: [1] }, refused: [] });
      expect(initials).toEqual([]);
      expect(bases).toEqual([undefined]);
    });
  });

  // The fold reads nothing by an id, of the entity or of a record: the records are reduced as
  // the list has them.
  it("folds the records in the order given, whatever their ids", () => {
    const pure = createSimulationStore<string, Base, Page, Queued, Refusal>({ initial, reduce });
    const drafted = createSimulationStore<string, Base, Draft, Queued, Refusal>(
      { initial: draft, reduce: reduceInPlace });

    const unordered = [add(3, "x"), add(1, "y"), add(3, "z"), add(1, "y")];
    expect(pure.fold("a", base, unordered).entity?.lines).toEqual(["seed", "x", "y", "z", "y"]);
    expect(drafted.fold("a", base, unordered).entity?.lines).toEqual(["seed", "x", "y", "z", "y"]);

    const remade = [create(7), remove(2), create(7), add(1)];
    expect(pure.fold("a", undefined, remade).entity?.lines).toEqual(["made by 7", "line 1"]);
    expect(drafted.fold("a", undefined, remade).entity?.lines).toEqual(["made by 7", "line 1"]);

    const twice = [refuse(5, "no"), refuse(5, "no")];
    expect(refusedIds(pure.fold("a", base, twice))).toEqual([5, 5]);
    expect(drafted.fold("a", base, twice).refused.map(({ record }) => record.id)).toEqual([5, 5]);
  });

  // The fold cannot tell a step that wrote the draft first from one that left it alone, which
  // is why a reducer that works in place decides before it writes.
  it.each<[string, EntityStep<Draft, Refusal>]>([
    ["refused", { kind: "refused", refusal: { reason: "late" } }],
    ["known-no-effect", { kind: "known-no-effect" }],
    ["unsupported", { kind: "unsupported", reason: "late" }],
  ])("restores nothing of a draft a reducer wrote before a %s step", (_, step) => {
    const held = frozen(["seed"]);
    const made: Draft[] = [];
    const store = createSimulationStore<string, Base, Draft, Queued, Refusal>({
      initial: given => {
        made.push(draft(given));
        return made[made.length - 1];
      },
      reduce: page => {
        page?.lines.push("written first");
        return step;
      },
    });
    const record = add(1);
    const result = store.fold("a", held, [record]);

    expect(result.entity).toBe(made[0]);
    expect(result.entity?.lines).toEqual(["seed", "written first"]);
    expect(held.seed).toEqual(["seed"]);
    expect(result.refused).toEqual(
      step.kind === "refused" ? [{ record, refusal: { reason: "late" } }] : []);
    expect(result.stopped).toEqual(
      step.kind === "unsupported" ? { record, reason: "late" } : undefined);
  });

  // Property: a fold through a store equals one pass over the records with the reducer itself,
  // and reduces each record it is given once, in the order given, up to and including the first
  // unsupported one. The two stores are shared by every run, so a list is folded after whatever
  // lists were folded before it. A record's id is drawn apart from its place in the list, and
  // shows in the entity a create makes and in what is refused.
  it("a fold equals one pass with no store", () => {
    const pure = noting<Page>({ initial, reduce });
    const drafted = noting<Draft>({ initial: draft, reduce: reduceInPlace });
    fc.assert(
      fc.property(
        fc.option(fc.subarray(alphabet)),
        fc.array(fc.record({ id: fc.integer({ min: 1, max: 8 }), action: anyChange }), { maxLength: 30 }),
        (seed, records: Queued[]) => {
          const held = seed === null ? undefined : frozen(seed);
          const want = fresh("a", held, records);
          const reduced = want.stopped === undefined
            ? records
            : records.slice(0, records.indexOf(want.stopped.record) + 1);

          for (const { store, seen, noted, reset } of [pure, drafted]) {
            for (let time = 0; time < 2; time++) {
              reset();
              expect(store.fold("a", held, records)).toEqual(want);
              expect(seen).toHaveLength(reduced.length);
              seen.forEach((record, index) => expect(record).toBe(records[index]));
              expect(noted.drafts).toBe(held === undefined ? 0 : 1);
            }
          }
          if (seed !== null) expect(held).toEqual({ seed });
        },
      ),
      { ...PROPERTY_RUN_OPTIONS, numRuns: 1000 });
  }, 120_000);

  // Property: reading an entity through the view and a store equals one pass over the whole
  // queue. The reference (`wholeQueue`) has no index: it walks every pending record that is not
  // marked once, in id order, and gives each to every entity it targets. Each seed runs a
  // gatekeeper that submits records for one entity or two (provisional ids among them, bound
  // part way through the queue, when the create that made them leaves it), marks what its reads
  // refused and records they did not, removes records and replaces a base with another object,
  // and after each step reads some of the entities, each through a store whose reducer returns
  // another page and through one whose reducer writes its draft. A regression shows as an
  // entity read with another entity's change, without one of its own, or with a refusal
  // unreported.
  it("an entity read through the view equals one pass over the whole queue", () => {
    const SEEDS = 600;
    let reads = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = seeded(seed);
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
      // The provider holds `a`, `b` and `c`. `p1` and `p2` are entities pending creates will
      // make: once a create is applied the provider holds the entity as `x1` or `x2`.
      const ids = new ProvisionalIds<string>(fakeKv(), {
        namespace: "sim:",
        isProvisional: id => id.startsWith("p"),
      });
      const provisional = [ids.allocate(n => `p${n}`), ids.allocate(n => `p${n}`)];
      const resolved = (action: Action): readonly string[] =>
        targets(action).map(id => ids.resolve(id));
      const bases = new Map<string, Base>(
        [["a", { seed: ["a"] }], ["b", { seed: [] }], ["c", { seed: ["a", "b"] }]]);
      const store = createSimulationStore<string, Base, Page, Queued, Refusal>({ initial, reduce });
      const drafted = createSimulationStore<string, Base, Draft, Queued, Refusal>(
        { initial: draft, reduce: reduceInPlace });
      let pending: Queued[] = [];
      let nextId = 1;
      let lately = new Set<number>();

      for (let step = 0; step < 40; step++) {
        const roll = random();
        if (roll < 0.45 || pending.length === 0) {
          const first = pick(["a", "b", "c", ...provisional]);
          const where = random() < 0.25 ? [first, pick(["a", "b", "c", provisional[0]])] : [first];
          const id = nextId++;
          pending = [...pending, { id, action: { ...pick(changes(`line ${id}`)), on: where } }];
        } else if (roll < 0.53) {
          pending = marked(pending, lately);
          lately = new Set();
        } else if (roll < 0.6) {
          // A mark no read asked for: of a record a fold applied, as often as not.
          pending = marked(pending, [pick(pending).id]);
        } else if (roll < 0.75) {
          const removed = pick(pending).id;
          pending = pending.filter(({ id }) => id !== removed);
        } else if (roll < 0.85) {
          // Another base object, which holds the same as the earlier one half the time.
          const id = pick(["a", "b", "c"]);
          const held = bases.get(id)?.seed ?? [];
          bases.set(id, { seed: random() < 0.5 ? [...held] : [...held, "b"] });
        } else {
          // A create is applied: its records leave the queue, the provisional id is bound to the
          // provider's, and the provider holds the entity.
          const made = pick(provisional);
          if (!ids.isResolved(made)) {
            const real = `x${made.slice(1)}`;
            ids.bind(made, real);
            bases.set(real, { seed: ["a"] });
            pending = pending.filter(({ action }) =>
              !(action.kind === "create" && targets(action).includes(made)));
          }
        }

        const view = createSimulationView(pending, resolved);
        const expected = wholeQueue(bases, pending, resolved);
        const entities = new Set([...bases.keys(), ...pending.flatMap(r => resolved(r.action))]);
        for (const id of entities) {
          if (random() >= 0.6) continue;
          const own = view.forTarget(id).filter(unmarked);
          const want = expected.get(id) ?? { entity: undefined, refused: [], refusals: [] };
          const where = `seed ${seed}, step ${step}, entity ${id}`;
          const got = store.fold(id, bases.get(id), own);
          expect(got.entity, where).toEqual(want.entity);
          expect(refusedIds(got), where).toEqual(want.refused);
          expect(got.stopped?.record.id, where).toBe(want.stopped);
          const written = drafted.fold(id, bases.get(id), own);
          expect(written.entity, where).toEqual(want.entity);
          expect(written.refused.map(({ record }) => record.id), where).toEqual(want.refused);
          expect(written.stopped?.record.id, where).toBe(want.stopped);
          for (const refused of refusedIds(got)) lately.add(refused);
          reads++;
        }
      }
    }
    // Enough was compared for the property to mean something.
    expect(reads).toBeGreaterThan(60_000);
  }, 120_000);
});

// The fixture is a listing of tasks, newest first, that leaves finished tasks out. A pending
// `open` makes a task under a temporary id, which later records may name.
type Task = {
  readonly id: string;
  readonly at: number;
  readonly title: string;
  readonly done?: true;
};
type Change =
  | { kind: "open"; ref: string; title: string; at: number }
  | { kind: "retitle"; tasks: readonly string[]; title: string }
  | { kind: "finish"; task: string }
  | { kind: "discard"; task: string };
type Staged = SimulationRecord<Change>;

const task = (id: string, at: number, title = `task ${id}`): Task => ({ id, at, title });
const opens = (id: number, ref: string, at: number, title = `task ${ref}`): Staged =>
  ({ id, action: { kind: "open", ref, title, at } });
const retitles = (id: number, title: string, ...tasks: string[]): Staged =>
  ({ id, action: { kind: "retitle", tasks, title } });
const finishes = (id: number, target: string): Staged =>
  ({ id, action: { kind: "finish", task: target } });
const discards = (id: number, target: string): Staged =>
  ({ id, action: { kind: "discard", task: target } });

const taskIds = (action: Change): readonly string[] =>
  action.kind === "open" ? [action.ref] : action.kind === "retitle" ? action.tasks : [action.task];
const newestFirst = (a: Task, b: Task): number => b.at - a.at;
const unfinished = (row: Task): boolean => !row.done;

/**
 * A listing over a `journal` the test changes as a gatekeeper's would change: the view is built
 * on each call from `journal.staged`, and `journal.created` is read as it then is.
 */
function listing(staged: Staged[], created: string[] = []) {
  const journal = { staged, created };
  const reduced: number[] = [];
  let views = 0;
  const store = createSimulationStore<string, Task, Task, Staged>({
    initial: row => row,
    reduce: (row, { id, action }) => {
      reduced.push(id);
      if (action.kind === "open") {
        return row === undefined
          ? { kind: "applied", value: task(action.ref, action.at, action.title) }
          : { kind: "known-no-effect" };
      }
      if (row === undefined) return { kind: "known-no-effect" };
      if (action.kind === "discard") return { kind: "deleted" };
      return {
        kind: "applied",
        value: action.kind === "finish" ? { ...row, done: true } : { ...row, title: action.title },
      };
    },
  });
  const list = simulatedList({
    store,
    view: () => {
      views++;
      return createSimulationView(journal.staged, taskIds);
    },
    id: row => row.id,
    compare: newestFirst,
    keeps: unfinished,
    created: () => journal.created,
  });
  return { journal, list, reduced, views: () => views };
}

/** A task a reducer may write. */
type DraftTask = { id: string; at: number; title: string; done?: true };

/**
 * `listing()` with a reducer that works in place: `initial` copies the row, and `reduce` writes
 * the row it is given and returns it.
 */
function draftListing(staged: Staged[], created: string[] = []) {
  const journal = { staged, created };
  const store = createSimulationStore<string, DraftTask, DraftTask, Staged>({
    initial: row => ({ ...row }),
    reduce: (row, { action }) => {
      if (action.kind === "open") {
        return row === undefined
          ? { kind: "applied", value: task(action.ref, action.at, action.title) }
          : { kind: "known-no-effect" };
      }
      if (row === undefined) return { kind: "known-no-effect" };
      if (action.kind === "discard") return { kind: "deleted" };
      if (action.kind === "finish") row.done = true;
      else row.title = action.title;
      return { kind: "applied", value: row };
    },
  });
  const list = simulatedList({
    store,
    view: () => createSimulationView(journal.staged, taskIds),
    id: row => row.id,
    compare: newestFirst,
    keeps: unfinished,
    created: () => journal.created,
  });
  return { journal, list };
}

describe("simulatedList", () => {
  it("does not show a row whose fold stopped, provider row or stand-in, and throws nothing", () => {
    const stuck = (stuckOn: string) => {
      const store = createSimulationStore<string, Task, Task, Staged>({
        initial: row => row,
        reduce: (row, { action }) => {
          if (action.kind === "finish" && action.task === stuckOn) {
            return { kind: "unsupported", reason: "it cannot be replayed" };
          }
          if (action.kind === "open") return { kind: "applied", value: task(action.ref, action.at) };
          return action.kind === "discard" ? { kind: "deleted" } : { kind: "known-no-effect" };
        },
      });
      // The record after the stop deletes the row: showing the fold's entity would show it.
      const staged = [opens(1, "~1", 5), finishes(2, stuckOn), discards(3, stuckOn)];
      return () => simulatedList({
        store,
        view: () => createSimulationView(staged, taskIds),
        id: row => row.id,
        compare: newestFirst,
        created: () => ["~1"],
      });
    };

    const onRow = stuck("a")();
    expect(onRow.overlay(task("a", 1))).toEqual([]);
    expect(onRow.overlay(task("b", 2))).toEqual([task("b", 2)]);
    // A stand-in is folded when the hooks are made and at every refresh.
    const onStandIn = stuck("~1")();
    expect(onStandIn.inject.items).toEqual([]);
    onStandIn.refresh();
    expect(onStandIn.inject.revalidate(task("~1", 5))).toBeNull();

    // A stand-in shown until a record its fold cannot replay is staged is hidden from the next
    // refresh on.
    const store = createSimulationStore<string, Task, Task, Staged>({
      initial: row => row,
      reduce: (row, { action }) => {
        if (action.kind === "finish") return { kind: "unsupported", reason: "it cannot be replayed" };
        if (action.kind === "open") return { kind: "applied", value: task(action.ref, action.at) };
        return { kind: "known-no-effect" };
      },
    });
    let staged = [opens(1, "~1", 5)];
    const later = simulatedList({
      store,
      view: () => createSimulationView(staged, taskIds),
      id: row => row.id,
      compare: newestFirst,
      created: () => ["~1"],
    });
    expect(later.inject.items).toEqual([task("~1", 5)]);
    expect(later.inject.revalidate(task("~1", 5))).toEqual(task("~1", 5));
    staged = [...staged, finishes(2, "~1")];
    later.refresh();
    expect(later.inject.revalidate(task("~1", 5))).toBeNull();
  });

  it("folds a provider row and drops one its records delete or the listing no longer keeps", () => {
    const { list } = listing([retitles(1, "renamed", "a"), discards(2, "b"), finishes(3, "c")]);
    const untouched = task("d", 4);

    expect(list.overlay(task("a", 1))).toEqual([task("a", 1, "renamed")]);
    expect(list.overlay(task("b", 2))).toEqual([]);
    expect(list.overlay(task("c", 3))).toEqual([]);
    // A row no record targets is served as the provider gave it.
    expect(list.overlay(untouched)[0]).toBe(untouched);
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list.inject)).toBe(true);
    expect(Object.isFrozen(list.inject.items)).toBe(true);
  });

  it("shows every row when the listing has no filter", () => {
    const store = createSimulationStore<string, Task, Task, Staged>({
      initial: row => row,
      reduce: row => ({ kind: "applied", value: { ...row!, done: true } }),
    });
    const list = simulatedList({
      store,
      view: () => createSimulationView([finishes(1, "a")], taskIds),
      id: row => row.id,
      compare: newestFirst,
    });

    expect(list.overlay(task("a", 1))).toEqual([{ ...task("a", 1), done: true }]);
    expect(list.inject.items).toEqual([]);
  });

  it("lists a stand-in for a pending create, with the later records on it folded in", () => {
    const { list } = listing([opens(1, "~1", 5, "draft"), retitles(2, "final", "~1")], ["~1"]);

    expect(list.inject.items).toEqual([task("~1", 5, "final")]);
    expect(list.inject.revalidate(list.inject.items[0])).toEqual(task("~1", 5, "final"));
  });

  it("sorts the stand-ins with the caller's compare", () => {
    const staged = [opens(1, "~1", 5), opens(2, "~2", 9), opens(3, "~3", 7)];
    const { list } = listing(staged, ["~1", "~2", "~3"]);

    expect(list.inject.items.map(({ id }) => id)).toEqual(["~2", "~3", "~1"]);
    expect(list.inject.compare).toBe(newestFirst);
  });

  it("revalidates a stand-in to null once its create is no longer pending", () => {
    const { journal, list } = listing([opens(1, "~1", 5)], ["~1"]);
    const [standIn] = list.inject.items;

    // A later record on it: the stand-in served is what the last refresh folded.
    journal.staged = [...journal.staged, retitles(2, "later", "~1")];
    expect(list.inject.revalidate(standIn)).toEqual(task("~1", 5));

    // The create applied: its id left the pending creates. The stand-in goes at once, before
    // the next refresh, so a create bound while a page is fetched serves the provider's row.
    journal.created = [];
    expect(list.inject.revalidate(standIn)).toBeNull();
    list.refresh();
    expect(list.inject.revalidate(standIn)).toBeNull();
  });

  it("revalidates a stand-in to null once a later record deletes it", () => {
    const { journal, list } = listing([opens(1, "~1", 5)], ["~1"]);
    const [standIn] = list.inject.items;

    journal.staged = [...journal.staged, discards(2, "~1")];
    list.refresh();
    expect(list.inject.revalidate(standIn)).toBeNull();
  });

  it("revalidates a stand-in to null once the listing no longer keeps it", () => {
    const { journal, list } = listing([opens(1, "~1", 5)], ["~1"]);
    const [standIn] = list.inject.items;

    journal.staged = [...journal.staged, finishes(2, "~1")];
    list.refresh();
    expect(list.inject.revalidate(standIn)).toBeNull();
  });

  it("asks the listing's filter of a stand-in as it is served, not only at a refresh", () => {
    let shown = true;
    const store = createSimulationStore<string, Task, Task, Staged>({
      initial: row => row,
      reduce: (row, { action }) => action.kind === "open" && row === undefined
        ? { kind: "applied", value: task(action.ref, action.at) }
        : { kind: "known-no-effect" },
    });
    const list = simulatedList({
      store,
      view: () => createSimulationView([opens(1, "~1", 5)], taskIds),
      id: row => row.id,
      compare: newestFirst,
      keeps: () => shown,
      created: () => ["~1"],
    });
    const [standIn] = list.inject.items;
    expect(list.inject.revalidate(standIn)).toEqual(task("~1", 5));
    // The filter changes while a page is fetched, after the cursor's refresh.
    shown = false;
    expect(list.inject.revalidate(standIn)).toBeNull();

    // A refresh the filter leaves it out of still folds it, so a filter that holds again by the
    // time it is served serves it.
    list.refresh();
    expect(list.inject.revalidate(standIn)).toBeNull();
    shown = true;
    expect(list.inject.revalidate(standIn)).toEqual(task("~1", 5));
  });

  it("revalidates a stand-in as the records staged since leave it", () => {
    const { journal, list } = listing([opens(1, "~1", 5)], ["~1"]);
    const [standIn] = list.inject.items;

    journal.staged = [...journal.staged, retitles(2, "renamed", "~1")];
    list.refresh();
    expect(list.inject.revalidate(standIn)).toEqual(task("~1", 5, "renamed"));
    // What a cursor read when it was built stays as it was.
    expect(list.inject.items).toEqual([task("~1", 5)]);
  });

  it("revalidates any row that is not a stand-in to null", () => {
    const { list } = listing([opens(1, "~1", 5), retitles(2, "renamed", "a")], ["~1"]);

    expect(list.inject.revalidate(task("a", 1))).toBeNull();
    expect(list.inject.revalidate(task("b", 2))).toBeNull();
  });

  it("folds the stand-ins again at every refresh", () => {
    const { journal, list, reduced } = listing(
      [opens(1, "~1", 5), retitles(2, "final", "~1", "a"), opens(3, "~2", 7)], ["~1", "~2"]);
    // The two stand-ins, then the provider's row.
    expect(reduced).toEqual([1, 2, 3]);
    expect(list.overlay(task("a", 1))).toEqual([task("a", 1, "final")]);
    expect(reduced).toEqual([1, 2, 3, 2]);

    list.refresh();
    expect(reduced).toEqual([1, 2, 3, 2, 1, 2, 3]);

    // One create leaves: its stand-in is neither folded nor served.
    journal.created = ["~2"];
    list.refresh();
    expect(reduced).toEqual([1, 2, 3, 2, 1, 2, 3, 3]);
    expect(list.inject.revalidate(task("~1", 5))).toBeNull();
    expect(list.inject.revalidate(task("~2", 7))).toEqual(task("~2", 7));
  });

  it("folds a row the same each time it is given, with a reducer that works in place", () => {
    const { list } = draftListing([retitles(1, "final", "a")]);
    const provided = Object.freeze(task("a", 1));

    const served = [list.overlay(provided), list.overlay(provided), list.overlay(provided)];
    for (const rows of served) expect(rows).toEqual([task("a", 1, "final")]);
    expect(new Set([provided, ...served.map(([row]) => row)]).size).toBe(4);
    expect(provided).toEqual(task("a", 1));
  });

  it("leaves a stand-in it served as it was when a refresh folds it again, with a reducer that " +
    "works in place", () => {
    const { journal, list } = draftListing([opens(1, "~1", 5)], ["~1"]);
    const first = list.inject.items[0];
    const asServed = structuredClone(first);

    journal.staged = [...journal.staged, retitles(2, "later", "~1")];
    list.refresh();
    expect(first).toEqual(asServed);
    expect(list.inject.revalidate(first)).toEqual(task("~1", 5, "later"));
    expect(list.inject.revalidate(first)).not.toBe(first);
  });

  it("reads the view at every fold, and the pending creates only at refresh", () => {
    const { journal, list, views } = listing([opens(1, "~1", 5)], ["~1"]);
    // One fold made the stand-in.
    expect(views()).toBe(1);

    // A view that answers other records is seen by the next fold, with no refresh.
    journal.staged = [...journal.staged, retitles(2, "renamed", "a")];
    expect(list.overlay(task("a", 1))).toEqual([task("a", 1, "renamed")]);
    expect(list.overlay(task("b", 2))).toEqual([task("b", 2)]);
    expect(views()).toBe(3);

    // A create staged since is listed once the gatekeeper refreshes.
    journal.staged = [...journal.staged, opens(3, "~2", 8)];
    journal.created = ["~1", "~2"];
    expect(list.inject.revalidate(task("~2", 8))).toBeNull();
    expect(views()).toBe(3);
    list.refresh();
    expect(list.inject.revalidate(task("~2", 8))).toEqual(task("~2", 8));
    // One fold for each stand-in.
    expect(views()).toBe(5);
  });

  it("folds a record that targets several rows into each", () => {
    const staged = [opens(1, "~1", 5), retitles(2, "shared", "a", "b", "~1")];
    const { list } = listing(staged, ["~1"]);

    expect(list.overlay(task("a", 1))).toEqual([task("a", 1, "shared")]);
    expect(list.overlay(task("b", 2))).toEqual([task("b", 2, "shared")]);
    expect(list.overlay(task("c", 3))).toEqual([task("c", 3)]);
    expect(list.inject.items).toEqual([task("~1", 5, "shared")]);
  });

  it("folds a stand-in once where the pending creates name its id twice", () => {
    const { list, reduced } = listing([opens(1, "~1", 5)], ["~1", "~1"]);
    expect(reduced).toEqual([1]);
    expect(list.inject.items).toEqual([task("~1", 5)]);

    list.refresh();
    expect(reduced).toEqual([1, 1]);
  });

  it("makes no stand-in and folds nothing at a refresh where the listing has no pending creates", () => {
    let reduced = 0;
    const store = createSimulationStore<string, Task, Task, Staged>({
      initial: row => row,
      reduce: () => {
        reduced++;
        return { kind: "known-no-effect" };
      },
    });
    const list = simulatedList({
      store,
      view: () => createSimulationView([opens(1, "~1", 5)], taskIds),
      id: row => row.id,
      compare: newestFirst,
    });

    list.refresh();
    expect(list.inject.items).toEqual([]);
    expect(list.inject.revalidate(task("~1", 5))).toBeNull();
    expect(reduced).toBe(0);
  });
});

// The document recipe of USAGE.md's "Replaying pending actions", run as it is written there: a
// resource that reads a document one tab at a time and marks what a fold refused, on the queue
// apply and reject run on. An edit is positional: it replaces the text it expects at an offset.
describe("the usage recipe's document reads", () => {
  type Edit = { tabId: string; at: number; expected: string; text: string };
  type Tab = { id: string; text: string };
  type Change = { tabId: string; edit: Edit; invalidatedReason?: string };
  type Queued = { id: number; action: Change };

  const applyEdit = (tab: Tab, edit: Edit): { ok: true; tab: Tab } | { ok: false; reason: string } =>
    tab.text.slice(edit.at, edit.at + edit.expected.length) === edit.expected
      ? { ok: true, tab: { ...tab, text: write(tab.text, edit) } }
      : { ok: false, reason: `The tab no longer reads "${edit.expected}" there.` };
  const write = (text: string, edit: Edit): string =>
    text.slice(0, edit.at) + edit.text + text.slice(edit.at + edit.expected.length);

  class Document {
    readonly provider = { tabs: [{ id: "t1", text: "hello world" }] as Tab[] };
    readonly #records = new Map<number, Queued>();
    readonly #journal = {
      listPending: (): Queued[] => [...this.#records.values()],
      markInvalid: (id: number, reason: string): void => {
        const record = this.#records.get(id);
        if (record) record.action.invalidatedReason = reason;
      },
    };
    readonly #queue = new SerialTaskQueue();
    readonly #actions = { runExclusive: <T>(hook: () => Promise<T>) => this.#queue.run(hook) };
    /** Run while the document is being fetched, after its tabs are read: a submission meanwhile. */
    duringFetch: (() => void) | undefined;
    readonly #api = {
      get: async () => {
        let tabs = this.provider.tabs.map(tab => ({ ...tab }));
        this.duringFetch?.();
        this.duringFetch = undefined;
        return { tabs };
      },
    };
    #replay = createSimulationStore<string, Tab, Tab, Queued, string>({
      initial: tab => tab,
      reduce: (tab, { action }, { refusals }) => {
        if (tab === undefined) return { kind: "refused", refusal: "The tab is not in the document." };
        if (refusals.length > 0) {
          return { kind: "refused", refusal: "An earlier edit of the tab was refused." };
        }
        const edited = applyEdit(tab, action.edit);
        return edited.ok
          ? { kind: "applied", value: edited.tab }
          : { kind: "refused", refusal: edited.reason };
      },
    });

    stage(id: number, edit: Edit): void {
      this.#records.set(id, { id, action: { tabId: edit.tabId, edit } });
    }

    marked(id: number): string | undefined {
      return this.#records.get(id)?.action.invalidatedReason;
    }

    read(tabId: string): Promise<string | undefined> {
      return this.#actions.runExclusive(async () => {
        const pending = this.#journal.listPending();
        const doc = await this.#api.get();
        const tab = doc.tabs.find(tab => tab.id === tabId);
        return this.#fold(tabId, tab, pending)?.text;
      });
    }

    #fold(tabId: string, tab: Tab | undefined, pending: readonly Queued[]): Tab | undefined {
      const view = createSimulationView(pending, action => [action.tabId]);
      const { entity, refused } = this.#replay.fold(
        tabId, tab, view.forTarget(tabId).filter(record => !record.action.invalidatedReason));
      for (const { record, refusal } of refused) this.#journal.markInvalid(record.id, refusal);
      return entity;
    }
  }

  it("shows the edits pending over the provider's tab", async () => {
    const doc = new Document();
    doc.stage(1, { tabId: "t1", at: 0, expected: "", text: "New " });
    doc.stage(2, { tabId: "t1", at: 4, expected: "hello", text: "hi" });

    expect(await doc.read("t1")).toBe("New hi world");
    expect([doc.marked(1), doc.marked(2)]).toEqual([undefined, undefined]);
  });

  it("marks an edit a read refuses, and leaves it out of the reads after", async () => {
    const doc = new Document();
    doc.stage(1, { tabId: "t1", at: 0, expected: "hello", text: "howdy" });
    // The text the edit expects changed at the provider; its offset is still in the tab.
    doc.provider.tabs = [{ id: "t1", text: "jello world" }];

    expect(await doc.read("t1")).toBe("jello world");
    expect(doc.marked(1)).toBe('The tab no longer reads "hello" there.');
    // Its text back, the edit stays marked: a mark outlives the read.
    doc.provider.tabs = [{ id: "t1", text: "hello world" }];
    expect(await doc.read("t1")).toBe("hello world");
  });

  it("leaves an edit submitted while the document is fetched to the next read", async () => {
    const doc = new Document();
    // The provider changes the text, and an edit of the new text is submitted, while the read
    // has the document before the change in hand.
    doc.duringFetch = () => {
      doc.provider.tabs = [{ id: "t1", text: "jello world" }];
      doc.stage(1, { tabId: "t1", at: 0, expected: "jello", text: "hello" });
    };
    expect(await doc.read("t1")).toBe("hello world");
    expect(doc.marked(1)).toBeUndefined();
    expect(await doc.read("t1")).toBe("hello world");
    expect(doc.marked(1)).toBeUndefined();
  });

  it("refuses, in the fold that refuses an edit, the edits of the tab after it", async () => {
    const doc = new Document();
    doc.provider.tabs = [{ id: "t1", text: "abbc" }];
    doc.stage(1, { tabId: "t1", at: 0, expected: "a", text: "aa" });
    // The first `b` of what the first edit leaves.
    doc.stage(2, { tabId: "t1", at: 2, expected: "b", text: "X" });
    expect(await doc.read("t1")).toBe("aaXbc");
    // Its expected text now stands at its offset as the second `b`.
    doc.provider.tabs = [{ id: "t1", text: "xbbc" }];

    expect(await doc.read("t1")).toBe("xbbc");
    expect(doc.marked(2)).toBe("An earlier edit of the tab was refused.");
  });
});
