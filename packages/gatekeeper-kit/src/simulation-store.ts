/**
 * A fold of pending actions over one entity at a time, which holds nothing between two calls,
 * and the values a kit cursor takes for a listing folded that way.
 */

import type { SimulationRecord, SimulationStep, SimulationView } from "./simulation";

/**
 * What one record does to one entity: `applied` with the entity as it then is, `deleted`,
 * `refused` (the record cannot be replayed on this entity; the entity stays as it was),
 * `known-no-effect`, or `unsupported`, which ends the entity's fold at that record.
 */
export type EntityStep<Entity, Refusal = never> =
  | SimulationStep<Entity>
  | { kind: "deleted" }
  | { kind: "refused"; refusal: Refusal };

/** What a reducer is given beside the entity and the record. */
export type EntityContext<Id extends string, Base, Refusal> = {
  /** The entity being folded. */
  readonly id: Id;
  /** What the provider holds of the entity, or `undefined` for one it does not hold. */
  readonly base: Base | undefined;
  /**
   * The refusals this call of `fold` has recorded on the entity so far, oldest first. A record
   * that depends on an earlier one having applied reads them to REFUSE (a gate a refusal
   * closes), and for nothing else: a step that applies, deletes or has no effect must be the
   * same whatever they hold, because the caller leaves a refused record out of the lists it
   * folds afterwards, and a fold without the record must give the entity this one gave. Each
   * call starts with none.
   */
  readonly refusals: readonly Refusal[];
};

/** The reducer of a simulation store. */
export type SimulationStoreOptions<
  Id extends string,
  Base,
  Entity,
  R extends SimulationRecord<unknown>,
  Refusal = never,
> = {
  /**
   * The fold's draft of the entity with no record applied, made from what the provider holds
   * of it. Called once by every fold that is given a base. What it returns is that fold's:
   * `reduce` is given it and may change it in place. So a store whose `reduce` changes its
   * entity in place returns here a value of its own, copied as deep as `reduce` writes, and
   * never `base` or a part of it: the caller keeps `base` and may fold it again (a cursor folds
   * a row it holds each time it serves it), and the fold copies nothing itself. A store whose
   * `reduce` never changes its entity may return `base` itself or a part of it. Whoever writes
   * the reducer keeps this rule: the fold cannot check it. An equal value for the same base,
   * however often it is called, and `base` left as it was. Whatever else it does beyond what it
   * returns is held to the rule `reduce` gives for itself: safe to repeat, and changing no step.
   */
  readonly initial: (base: Base) => Entity;
  /**
   * Projects one record onto one entity. `entity` is the fold's draft: what `initial` returned,
   * or the value of the last `applied` step; `undefined` for an entity the provider does not
   * hold and no earlier record made, and after a `deleted` step.
   *
   * An `applied` step gives the entity as it then is: the draft itself, changed in place, or
   * another value, which is the draft from then on. A value given as `applied` is the fold's,
   * as what `initial` returns is: where a later step may change it in place, a record that
   * creates the entity builds it, and does not hand over an object the record or the caller
   * keeps. A `refused`, a `known-no-effect` and an `unsupported` step leave the draft exactly
   * as it was given, so a reducer that works in place decides before it writes, or puts back
   * what it wrote before it answers; the fold cannot check that either. A `deleted` step ends
   * the draft: the next record is given `undefined`, and one that creates the entity again
   * starts another draft, which holds nothing of the one deleted.
   *
   * The same step for the same record, context and entity, however often it is called: every
   * read folds again, and a cursor folds a row each time it serves it. No change to `record`,
   * to `context.base` or to `context.refusals`. Whatever else it does beyond the draft is
   * safe to repeat and changes no step: a count of the work done, or a result kept under the
   * content it was computed from, which a repeated call finds, or writes again the same.
   * `refused` leaves the entity as it was and the fold goes on; `unsupported` ends the fold at
   * that record. A throw passes through `fold`.
   */
  readonly reduce: (
    entity: Entity | undefined,
    record: R,
    context: EntityContext<Id, Base, Refusal>,
  ) => EntityStep<Entity, Refusal>;
};

/** One entity with its pending records folded over it. */
export type EntityFold<Entity, R, Refusal> = {
  /**
   * The entity as it stands, or `undefined` for one the provider does not hold and no record
   * made, and for one a record deleted. The fold keeps no reference to it. It shares with the
   * base whatever `initial` and `reduce` left shared, and is the base itself, or a part of it,
   * where `initial` returned that and no record replaced it: a caller may change only what its
   * reducer copied.
   */
  readonly entity: Entity | undefined;
  /** The records this call refused, in order, each with what `reduce` returned for it. */
  readonly refused: readonly { readonly record: R; readonly refusal: Refusal }[];
  /**
   * Set when `reduce` reported a record unsupported: that record and the reason. `entity` is
   * then the entity before it, and no later record was folded.
   */
  readonly stopped?: { readonly record: R; readonly reason: string };
};

/** A fold of pending records over entities, one entity at a time. It has no state. */
export type SimulationStore<
  Id extends string,
  Base,
  Entity,
  R extends SimulationRecord<unknown>,
  Refusal = never,
> = {
  /**
   * Folds the records that target one entity over what the provider holds of it, in the order
   * given: `initial(base)` where a base is given, then `reduce` for each record up to and
   * including the first `unsupported` one, each on what the one before it left. Synchronous.
   * Nothing is kept from one call to the next: every call reduces its records again from the
   * first, up to that same stop, on a draft of its own.
   *
   * `records` are the entity's own: `createSimulationView(pending, targets).forTarget(id)`,
   * where `targets` names every entity a record changes, each id already resolved through
   * `ProvisionalIds` where a pending create will make it. A record that targets several
   * entities is folded once for each, by the call that folds that entity, and each of those
   * folds stands alone: refused on one entity, the record still applies to the others, unless
   * the caller leaves it out or removes it before it folds them. A caller whose record must
   * take effect on all of its entities or none, where only one of them can refuse it, folds that
   * one first and leaves what that fold refused out of the lists it folds next, and where that
   * fold `stopped` before a shared record, which it then neither refused nor applied, reports
   * the conflict rather than serve the other folds; where more than one can, no order of folds
   * decides it, and the caller folds an entity that holds them all or
   * checks every target before the record is folded. A record that targets none
   * of the entities read is never reduced.
   *
   * A record the caller has marked as not to be replayed (a stored reason) is one it leaves
   * out of `records`: the store reads no mark, and reduces a marked record as any other. So
   * after a fold refuses a record, the caller marks it or removes it and leaves it out of the
   * lists it folds next; presented again, it is reduced, and refused, again.
   * @param id The entity, by the provider's own id (or the provisional id of a pending create).
   *   Given to `reduce`; the fold reads nothing by it.
   * @param base What the provider holds of it; `undefined` for none. Given to `initial` and to
   *   `reduce`, and not kept.
   * @param records The pending records to replay that target the entity, oldest first.
   * @returns The entity as it stands, what this call refused, and where the fold stopped.
   * @throws Whatever `initial` or `reduce` throws; the draft goes with the call.
   */
  readonly fold: (
    id: Id,
    base: Base | undefined,
    records: readonly R[],
  ) => EntityFold<Entity, R, Refusal>;
};

/**
 * Creates a fold of pending journal records over one entity at a time with a gatekeeper's own
 * reducer, which reports what could not be replayed. What it returns holds the reducer and
 * nothing else, so no fold leaves anything for the next: the gatekeeper keeps the reducer, the
 * listing and whatever it wants kept between two reads. It keeps no storage and runs no
 * callback but `initial`, on each base it is given, and the reducer. Make one where the reducer
 * is known: once for a module or a Durable Object, or with a listing where the reducer reads
 * what only that call knows (who is asking, the folder listed).
 * @param options The reducer and the entity with nothing applied.
 * @returns A frozen object whose one member is `fold`.
 *
 * @example
 * ```ts
 * // An editor whose state is one thing folds it as its one entity.
 * #replay = createSimulationStore<"deck", Deck, Deck, QueuedChange>({
 *   initial: deck => deck,
 *   reduce: (deck, change) => step(deck!, change.action),
 * });
 *
 * const deck = this.#replay.fold("deck", fetched, this.#journal.listPending());
 * return deck.stopped
 *   ? { deck: deck.entity, conflict: conflictReason(deck.stopped.record, deck.stopped.reason) }
 *   : { deck: deck.entity };
 *
 * // A document read one tab at a time folds the records of the tab it reads.
 * const view = createSimulationView(pending, action => [action.tabId]);
 * const { entity, refused } = store.fold(tabId, tab, view.forTarget(tabId));
 * ```
 */
export function createSimulationStore<
  Id extends string,
  Base,
  Entity,
  R extends SimulationRecord<unknown>,
  Refusal = never,
>(
  options: SimulationStoreOptions<Id, Base, Entity, R, Refusal>,
): SimulationStore<Id, Base, Entity, R, Refusal> {
  const fold = (
    id: Id,
    base: Base | undefined,
    records: readonly R[],
  ): EntityFold<Entity, R, Refusal> => {
    let entity = base === undefined ? undefined : options.initial(base);
    const refused: { record: R; refusal: Refusal }[] = [];
    const refusals: Refusal[] = [];
    let stopped: { record: R; reason: string } | undefined;
    for (const record of records) {
      const step = options.reduce(entity, record, { id, base, refusals });
      if (step.kind === "applied") {
        entity = step.value;
      } else if (step.kind === "deleted") {
        entity = undefined;
      } else if (step.kind === "refused") {
        refused.push({ record, refusal: step.refusal });
        refusals.push(step.refusal);
      } else if (step.kind === "unsupported") {
        stopped = { record, reason: step.reason };
        break;
      }
    }
    return { entity, refused, ...(stopped && { stopped }) };
  };
  return Object.freeze({ fold });
}

/** What `simulatedList` needs of a listing whose rows are entities of a simulation store. */
export type SimulatedListOptions<
  Id extends string,
  Row extends object,
  R extends SimulationRecord<unknown>,
> = {
  /**
   * The store that folds a row: its base and its entity are both the listing's row. A record
   * its reducer refuses leaves the row as it was, and the hooks mark nothing: a gatekeeper that
   * marks refusals does so where it folds outside the listing. A row whose fold stops at an
   * `unsupported` step is not shown, provider row or stand-in, since it would show some of its
   * records only; nothing of the stop is thrown, since the hooks run before the page they serve
   * is authorized, and the gatekeeper reports a stop where it folds outside the listing. Where its
   * reducer reads what only this listing knows (who is asking, the folder listed, names read
   * ahead of the walk), build the store with the listing. A row given to `overlay` is folded
   * each time it is given: a cursor holds a provider row until its page is served and may
   * serve it more than once, and a gatekeeper keeps the rows it reads itself. So a store whose
   * reducer changes its entity in place makes its draft in `initial`, a copy of the row, as
   * `SimulationStoreOptions.initial` asks, and the row is folded the same every time.
   */
  readonly store: SimulationStore<Id, Row, Row, R, unknown>;
  /**
   * The index of the pending records by the entity each targets, ids resolved. Read each time
   * a row is folded (every `overlay`, every stand-in) and never kept. A gatekeeper whose
   * targets cannot change between two refreshes answers a view it keeps and rebuilds in its
   * own refresh. One whose targets resolve provisional ids that a create applied mid-walk
   * binds answers a view built on the call, so a pending record on a provisional id reaches
   * the provider's row as soon as the id is bound.
   */
  readonly view: () => SimulationView<R, Id>;
  /** The entity a row is. A folded row is the entity its provider row was. */
  readonly id: (row: Row) => Id;
  /**
   * The provider's sort order, as `CursorInjection.compare` takes it. The cursor places a row
   * by the row as the provider listed it, or a stand-in as the hooks were made, before it folds
   * it, and a fold never moves it: what the reducer changes must leave a row's place under
   * `compare` where it was, for as long as the walk lasts (a title-sorted listing whose pending
   * rename changes the title still serves the row where the old title stood). A listing whose
   * pending changes reorder its rows sorts by a key they do not change, or is not built on
   * these hooks.
   */
  readonly compare: (a: Row, b: Row) => number;
  /**
   * Whether the listing shows a row as folded: the gatekeeper's own filter. Asked of a provider
   * row as `overlay` folds it, of each stand-in when the hooks make `inject.items` and again as
   * it is served, never at `refresh()`, so it may close over state the gatekeeper refreshes or
   * that changes while a page is fetched. Absent, every row is shown.
   */
  readonly keeps?: (row: Row) => boolean;
  /**
   * The entities pending creates will make that this listing may show, by their provisional
   * ids, oldest first. Read when the hooks are made, at every `refresh()`, and each time a
   * stand-in is served; the gatekeeper leaves out an id whose create has applied
   * (`ProvisionalIds.isResolved`). So a create bound before its stand-in is served drops the
   * stand-in, and the provider's row is served where a page lists it. Once the stand-in has
   * been served, the cursor's `identity` keeps the provider's row out of the walk: a create
   * bound between two fetches of one `next()` leaves the stand-in that page already holds.
   */
  readonly created?: () => readonly Id[];
};

/** The values a kit cursor takes for a listing with pending changes. */
export type SimulatedList<Row> = {
  /**
   * For `overlay`: a provider row with its pending records folded in, none when a record
   * deleted it or `keeps` no longer holds. A gatekeeper also passes it the provider rows it
   * read itself because a pending change moves them into the listing. The row given is left
   * as it was, by the store's `initial` where its reducer works in place.
   */
  readonly overlay: (row: Row) => readonly Row[];
  /** For `inject`. The caller adds `authorize` and `identity`, which are its own to decide. */
  readonly inject: {
    /**
     * The stand-ins of the pending creates as the hooks were made: each folded from nothing
     * with the records that target it, kept when `keeps` holds, sorted by `compare`. The cursor
     * injects only these, so a stand-in `keeps` left out here, or a create staged after, is not
     * served in this walk though it holds by then.
     */
    readonly items: readonly Row[];
    /** The caller's `compare`. */
    readonly compare: (a: Row, b: Row) => number;
    /**
     * A stand-in as the last `refresh()` folded it, or `null` where its create is no longer
     * pending, a record deleted it, its fold stopped, or `keeps` does not hold of it. `created`
     * and `keeps` are asked as the stand-in is served, not as that refresh answered them: a
     * stand-in that refresh's filter left out is served if the filter holds of it by then.
     * `null` for any other row: a gatekeeper that injects rows of its own revalidates those
     * itself.
     */
    readonly revalidate: (row: Row) => Row | null;
  };
  /**
   * Reads the pending creates again and folds their stand-ins again, each from nothing, and
   * keeps each fold that neither deleted nor stopped, whatever `keeps` answers of it now. Call
   * it from the cursor's `refresh`, after whatever the gatekeeper refreshes itself (what
   * `view`, `keeps` and `created` read).
   */
  readonly refresh: () => void;
};

/**
 * The stand-in, per-row fold and hide mechanics of a listing over a simulation store, as the
 * values a kit cursor's `inject`, `overlay` and `refresh` take. It holds no filter, order or
 * paging of its own: `keeps` and `compare` are the gatekeeper's, and so is every decision
 * about which provider rows to read.
 *
 * Between two calls the hooks hold one thing, and it is the listing's own: the stand-in rows
 * the last `refresh()` folded, which `inject.revalidate` answers from, for as long as the
 * gatekeeper keeps the hooks (a walk). No fold of a provider row is kept, and the store holds
 * nothing.
 *
 * The pending records a fold reads are those the gatekeeper last read, and the rows those its
 * cursor fetched; the two are not read together, nor against apply. A record that applies in
 * between is folded again over a row that already holds it, or no longer over one fetched before
 * it, and a create that landed before its id bound shows as its stand-in and the provider's row.
 * For the rows a page fetches, a listing that must not show these runs the fetch and journal read
 * together against apply (`runExclusive`), which settles no write whose outcome is unknown (one
 * left `claimed`, or one failed retryably after a lost reply, needs evidence from the provider),
 * or tells from a row what it holds; a row buffered
 * before a record applied is made current only by reading it again or starting the walk again.
 * See USAGE.md, "A listing over a simulation store".
 * @param options The store, the index of the pending records, and the listing's own id,
 *   order, filter and pending creates.
 * @returns The frozen hooks.
 *
 * @example
 * ```ts
 * // Built with the listing: the reducer assigns an acknowledged incident to whoever is asking.
 * const store = createSimulationStore<string, Incident, Incident, Queued>({
 *   initial: row => row,
 *   reduce: (incident, { action }) => step(incident, action, me),
 * });
 * // A pending create targets its temporary id until the provider's takes its place.
 * const targets = (action: IncidentAction) => action.kind === "createIncident"
 *   ? ids.isResolved(action.ref) ? [] : [action.ref]
 *   : [ids.resolve(action.incident.id)];
 * let pending = journal.listPending();
 * const list = simulatedList({
 *   store,
 *   // Built on the call, so a record on a temporary id follows it once it is bound.
 *   view: () => createSimulationView(pending, targets),
 *   id: row => row.id,
 *   compare: newestFirst,
 *   keeps: row => matchesFilter(row, filter),
 *   // The journal as it is now: a create rejected or applied before its stand-in is admitted to
 *   // a page drops it.
 *   created: () => journal.listPending().flatMap(({ action }) =>
 *     action.kind === "createIncident" && !ids.isResolved(action.ref) ? [action.ref] : []),
 * });
 * return new OffsetCursor<Incident>({
 *   pageSize,
 *   fetchPage,
 *   authorizePage,
 *   overlay: list.overlay,
 *   inject: { ...list.inject, authorize: true, identity: row => ids.resolve(row.id) },
 *   refresh: async () => {
 *     pending = journal.listPending();
 *     list.refresh();
 *   },
 * });
 * ```
 */
export function simulatedList<
  Id extends string,
  Row extends object,
  R extends SimulationRecord<unknown>,
>(options: SimulatedListOptions<Id, Row, R>): SimulatedList<Row> {
  const { store, view, id, compare, keeps, created } = options;

  // A row as its pending records leave it, or none where a record deleted it. A fold that
  // stopped would show the row with only the records before the stop, so it gives none.
  const folded = (entity: Id, base: Row | undefined): Row | undefined => {
    const { entity: row, stopped } = store.fold(entity, base, view().forTarget(entity));
    return stopped ? undefined : row;
  };
  const kept = (row: Row): boolean => keeps?.(row) ?? true;

  // The stand-ins of the pending creates as last folded, whatever the filter answered then:
  // it is asked as each is served.
  let standIns = new Map<Id, Row>();
  const refresh = (): void => {
    standIns = new Map(
      [...new Set(created?.() ?? [])].flatMap((entity): [Id, Row][] => {
        const row = folded(entity, undefined);
        return row === undefined ? [] : [[entity, row]];
      }),
    );
  };
  refresh();

  return Object.freeze({
    overlay: (row: Row) => {
      const shown = folded(id(row), row);
      return shown !== undefined && kept(shown) ? [shown] : [];
    },
    inject: Object.freeze({
      items: Object.freeze([...standIns.values()].filter(kept).toSorted(compare)),
      compare,
      revalidate: (row: Row) => {
        const entity = id(row);
        const standIn = standIns.get(entity);
        // `created` and `keeps` are asked as the stand-in is served, not as it was folded.
        if (standIn === undefined || !(created?.() ?? []).includes(entity)) return null;
        return kept(standIn) ? standIn : null;
      },
    }),
    refresh,
  });
}
