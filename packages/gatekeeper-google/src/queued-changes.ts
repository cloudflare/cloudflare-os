/**
 * What a connection does around one file's queued changes, the editor's own definitions apart:
 * showing them to reads, preparing one at a time, holding each to the size of one stored value,
 * applying them in the order they were queued, and saying when a rejection undoes what later ones
 * were built on.
 */

import type { ActionJournal, JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import { ReadGate } from "./read-gate";

/** The most a queued change may hold: one Durable Object KV value holds at most 128 KiB. */
export const MAX_CHANGE_BYTES = 100 * 1024;

/** Throws if `value` would not fit in the one storage value a queued change is. */
export function checkQueuedSize(value: unknown, maxBytes = MAX_CHANGE_BYTES): void {
  // Storage serializes a string holding any non-Latin-1 character at two bytes a unit.
  let bytes = JSON.stringify(value).length * 2;
  if (bytes > maxBytes) {
    throw new Error(`This change is too large to queue (${bytes} bytes, limit ${maxBytes}). ` +
      "Split it up.");
  }
}

/** How one file's changes are found in a journal, and how a refusal names them. */
export type QueuedChangesOptions<A, C> = {
  /** The connection's journal, which this only reads. */
  journal: Pick<ActionJournal<A>, "get" | "listPending" | "listUndecided">;
  /**
   * The file's change a record holds, as its editor sees it, or `undefined` for a record that is
   * not one of the file's changes.
   */
  select(action: A): C | undefined;
  /** The refusal of an approval while change `earlier` of the same file still waits before it. */
  outOfOrder(earlier: number): string;
  /** The most one change may hold, by {@link checkQueuedSize}'s estimate. */
  maxChangeBytes?: number;
};

/**
 * One file's queued changes, kept by its connection for as long as the connection is active: a
 * second object for the same file would not share its gate or its lane.
 *
 * Reads replay the changes still awaiting a decision over what the provider returns, and may
 * overlap each other but not a change being applied or rejected, or a change committed mid-read
 * would show twice. One change is prepared at a time, since each is checked against the
 * simulation it extends; a change takes its turn in the call, before its first await, and keeps
 * it until its submission is answered, so changes sent together are queued in the order they were
 * sent.
 */
export class QueuedChanges<A, C = A> {
  #options: QueuedChangesOptions<A, C>;
  #reads = new ReadGate();
  #preparing = new SerialTaskQueue();
  #inPreparation = 0;

  constructor(options: QueuedChangesOptions<A, C>) {
    this.#options = options;
  }

  /**
   * Runs `read` with the file's changes awaiting a decision, oldest first, while none is being
   * applied or rejected. A claimed change is not among them: it cannot be mid-apply when a read
   * runs, so an activation died applying it, and whether the provider has it is unknown.
   */
  snapshot<T>(read: (pending: readonly JournalEntry<C>[]) => Promise<T>): Promise<T> {
    return this.#reads.read(() => read(this.#mine(this.#options.journal.listUndecided())));
  }

  /**
   * Runs `prepare` while no other change to the file is being prepared, refuses a change too large
   * to store, and hands it to `submit` before the next one is prepared.
   */
  queue<P, T>(
    prepare: () => Promise<{ payload: P; result: T }>,
    submit: (payload: P) => Promise<unknown>,
  ): Promise<T> {
    this.#inPreparation++;
    return this.#preparing.run(async () => {
      let { payload, result } = await prepare();
      checkQueuedSize(payload, this.#options.maxChangeBytes);
      await submit(payload);
      return result;
    }).finally(() => this.#inPreparation--);
  }

  /**
   * Resolves once the changes sent before this have been queued, so that a read sent behind them
   * shows them. Never awaited from inside a turn, which would wait for itself.
   */
  afterTurns(): Promise<void> {
    return this.#preparing.run(() => {});
  }

  /**
   * The file's changes awaiting a decision, oldest first, read outside the gate: for a document,
   * whose reads overlap its approvals and are kept right by the write markers instead.
   */
  pending(): JournalEntry<C>[] {
    return this.#mine(this.#options.journal.listUndecided());
  }

  /**
   * Runs `body`, which applies change `actionId`, once reads in progress have settled. Each change
   * was checked against those queued before it, so they apply in that order. A decided or failed
   * change is left to `body`, which answers it without a write.
   */
  apply(actionId: number, body: () => Promise<void>): Promise<void> {
    return this.#reads.resolve(async () => {
      let state = this.#options.journal.get(actionId)?.state;
      let earlier = (state === "staged" || state === "pending") &&
        this.#mine(this.#options.journal.listPending()).find(({ id }) => id < actionId);
      if (earlier) throw new Error(this.#options.outOfOrder(earlier.id));
      await body();
    });
  }

  /**
   * Runs `body`, which rejects change `actionId`, once reads in progress have settled, and asks for
   * a restart when the gadget read changes on top of it: it was shown, and later changes were
   * queued or are being prepared over it.
   */
  reject(actionId: number, body: () => Promise<void>): Promise<void | { restart?: boolean }> {
    return this.#reads.resolve(async () => {
      let pending = this.#mine(this.#options.journal.listPending());
      let shown = pending.some(({ id }) => id === actionId);
      let builtOn = pending.at(-1)?.id !== actionId || this.#inPreparation > 0;
      await body();
      if (shown && builtOn) return { restart: true };
    });
  }

  /** The file's changes among `entries`, as its editor sees them. */
  #mine(entries: readonly JournalEntry<A>[]): JournalEntry<C>[] {
    return entries.flatMap(({ id, action }) => {
      let change = this.#options.select(action);
      return change === undefined ? [] : [{ id, action: change }];
    });
  }
}
