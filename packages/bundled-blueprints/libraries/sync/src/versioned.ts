/**
 * Optimistic concurrency over a set of items, each carrying its own `version`.
 *
 * A client sends, per item, the version it last saw (`baseVersion`); the server applies the batch
 * in order against its current items:
 *
 * - an item whose `baseVersion` no longer matches is *rejected* as `stale` and the authoritative
 *   item is returned, so the client can rebase its draft onto it rather than lose it;
 * - an item that is gone -- deleted by someone else since the client saw it -- is rejected as
 *   `missing`, and the client may re-create it from its draft (a writer's text wins over a
 *   deleter's absence) by sending it again with `baseVersion` 0;
 * - an accepted item takes the next version after the one it replaced (1 for a new one);
 * - an item identical to what is stored is neither a change nor a conflict;
 * - a deletion is version-checked the same way, so a delete never destroys what it has not seen,
 *   and deleting what is already gone is nothing at all.
 *
 * Nothing here knows what an item holds beyond its `id` and `version`: a page's block, a sheet's
 * cell and a deck's slide are all versioned this way, and the gadget keeps its own rules for
 * everything else (ordering, titles, structure), which are typically last-writer-wins.
 */

/** What every item under version control has: a stable id and the version of its content. */
export interface Versioned {
  id: string;
  version: number;
}

/** An item as a client sends it: its new content, and the version the client based it on (0 for one it created). */
export type VersionedUpsert<Item extends Versioned> = Omit<Item, "version"> & { baseVersion: number };

/** A version-checked deletion. */
export interface VersionedDeletion {
  id: string;
  baseVersion: number;
}

/** Why an upsert or a deletion was not applied. */
export type VersionConflict<Item extends Versioned> =
  | { id: string; reason: "stale"; current: Item }
  | { id: string; reason: "missing" };

/** One client's batch: the items that changed and the ones it removed. */
export interface VersionedBatch<Item extends Versioned> {
  upserts?: ReadonlyArray<VersionedUpsert<Item>>;
  deletes?: ReadonlyArray<VersionedDeletion>;
}

/** How {@link applyVersioned} reads a batch. */
export interface VersionedOptions<Item extends Versioned> {
  /**
   * Whether `incoming` would store the same content `current` already holds, so that re-sending
   * an unchanged item is not a change. The default compares the two field by field with `===`,
   * which is exact for flat items; an item holding nested objects supplies its own.
   */
  isUnchanged?(current: Item, incoming: Omit<Item, "version">): boolean;
}

/** What a batch did. */
export interface VersionedOutcome<Item extends Versioned> {
  /** Every item after the batch, by id, in the order of the input with accepted new items last. */
  items: Map<string, Item>;
  /** The upserts that were applied, with their new versions: what to store and to broadcast. */
  accepted: Item[];
  /** The deletions that were applied. */
  deletedIds: string[];
  /** What was rejected, in batch order. */
  conflicts: VersionConflict<Item>[];
  /** Whether anything was accepted or deleted. */
  changed: boolean;
  /** {@link operationStatus} of this outcome alone; a gadget with more in its batch recomputes it. */
  status: OperationStatus;
}

/** The reply a client reads first: `applied` if anything changed, `conflict` if anything was rejected (both may hold). */
export type OperationStatus = "applied" | "conflict" | "unchanged";

/** The status of a reply: rejected anything -> `conflict`; changed anything -> `applied`; else `unchanged`. */
export function operationStatus(changed: boolean, conflicts: ReadonlyArray<unknown>): OperationStatus {
  if (conflicts.length) return "conflict";
  return changed ? "applied" : "unchanged";
}

/**
 * A `baseVersion` as sent over RPC. An absent one is 0 (the version of an item the client created);
 * a value that is not a non-negative integer is read as -1, which matches no stored version and is
 * not 0, so what it guards is rejected as `stale` or `missing` rather than applied against a version
 * the client never saw.
 */
export function normalizeBaseVersion(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const version = Number(value);
  return Number.isInteger(version) && version >= 0 ? version : -1;
}

/**
 * Apply one batch to `current` under the rules in the module comment. The input is not modified;
 * the outcome's `items` is what the gadget stores next. Upserts are applied in order against the
 * items as the batch leaves them, so two upserts of one id in one batch see each other -- the
 * gadget's sanitizer is where duplicates are dropped, when that is not what it wants.
 */
export function applyVersioned<Item extends Versioned>(
  current: Iterable<Item>,
  batch: VersionedBatch<Item>,
  options: VersionedOptions<Item> = {},
): VersionedOutcome<Item> {
  const isUnchanged = options.isUnchanged ?? sameFields;
  const items = new Map<string, Item>();
  for (const item of current) items.set(item.id, item);
  const accepted: Item[] = [];
  const conflicts: VersionConflict<Item>[] = [];

  for (const incoming of batch.upserts ?? []) {
    // The rest of a spread over a type parameter is opaque to the compiler, hence the two casts:
    // the content is the upsert without its base version, and the item is that content versioned.
    const { baseVersion, ...rest } = incoming;
    const content = rest as unknown as Omit<Item, "version">;
    const existing = items.get(incoming.id);
    if (existing) {
      if (baseVersion !== existing.version) {
        conflicts.push({ id: incoming.id, reason: "stale", current: existing });
        continue;
      }
      if (isUnchanged(existing, content)) continue;
    } else if (baseVersion !== 0) {
      conflicts.push({ id: incoming.id, reason: "missing" });
      continue;
    }
    const next = { ...content, version: (existing?.version ?? 0) + 1 } as unknown as Item;
    items.set(next.id, next);
    accepted.push(next);
  }

  const deletedIds: string[] = [];
  for (const deletion of batch.deletes ?? []) {
    const existing = items.get(deletion.id);
    if (!existing) continue;
    if (deletion.baseVersion !== existing.version) {
      conflicts.push({ id: deletion.id, reason: "stale", current: existing });
      continue;
    }
    items.delete(deletion.id);
    deletedIds.push(deletion.id);
  }

  const changed = accepted.length > 0 || deletedIds.length > 0;
  return { items, accepted, deletedIds, conflicts, changed, status: operationStatus(changed, conflicts) };
}

/** Whether two flat items hold the same content: the same fields (`version` aside) with `===` values. */
function sameFields(current: Versioned, incoming: object): boolean {
  const left = Object.keys(current).filter((key) => key !== "version");
  const right = Object.keys(incoming);
  if (left.length !== right.length) return false;
  return right.every((key) => key in current && Reflect.get(current, key) === Reflect.get(incoming, key));
}
