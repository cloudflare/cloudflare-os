import type { BillowDocument, ItemRegistry, ModelRange } from "./types.js";

export interface HistoryState<Registry extends ItemRegistry> {
  readonly document: BillowDocument<Registry>;
  readonly selection: ModelRange;
}

type HistoryGroup = "typing" | "deleting" | null;

export interface HistorySnapshot<Registry extends ItemRegistry> {
  readonly undoStack: readonly HistoryState<Registry>[];
  readonly redoStack: readonly HistoryState<Registry>[];
  readonly group: HistoryGroup;
  readonly compositionBefore: HistoryState<Registry> | null;
}

/**
 * Undo/redo stacks of `{ document, selection }` states, each holding the state *before* an edit.
 *
 * - Grouping: consecutive typing (or deleting) edits share one undo step. `record` skips pushing
 *   while the active `group` matches; `boundary()` ends the group, e.g. when the caret moves.
 * - Composition: while an IME composes, the state from `beginComposition` is held aside and
 *   pushed as a single step by `commitComposition` (or dropped by `cancelComposition`).
 * - `snapshot`/`restore` let the editor roll back a failed edit, and `mapDocuments` rewrites
 *   every stored document, which is how `updateItem` changes item data without losing history.
 *
 * All of the history lives in one immutable `HistorySnapshot` that every change replaces, never
 * modifies. A snapshot is therefore just the current value: taking one copies nothing, and
 * nothing done afterwards can change it.
 */
export class HistoryManager<Registry extends ItemRegistry> {
  private data: HistorySnapshot<Registry> = { undoStack: [], redoStack: [], group: null, compositionBefore: null };

  constructor(private readonly limit = 100) {
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError("historyLimit must be a non-negative integer");
  }

  /** `stack` with `state` added on top, dropping the oldest entries beyond the limit. */
  private pushed(
    stack: readonly HistoryState<Registry>[],
    state: HistoryState<Registry>,
  ): readonly HistoryState<Registry>[] {
    if (this.limit === 0) return stack;
    const next = [...stack, state];
    return next.length > this.limit ? next.slice(next.length - this.limit) : next;
  }

  /** Forgets all undo and redo steps. An IME composition in progress is left alone. */
  reset(): void {
    this.data = { ...this.data, undoStack: [], redoStack: [], group: null };
  }

  snapshot(): HistorySnapshot<Registry> {
    return this.data;
  }

  restore(snapshot: HistorySnapshot<Registry>): void {
    this.data = snapshot;
  }

  boundary(): void {
    if (this.data.group !== null) this.data = { ...this.data, group: null };
  }

  record(snapshot: HistoryState<Registry>, group: HistoryGroup = null): void {
    if (group !== null && this.data.group === group) return;
    this.data = {
      ...this.data,
      undoStack: this.pushed(this.data.undoStack, snapshot),
      redoStack: [],
      group,
    };
  }

  undo(current: HistoryState<Registry>, validate: (document: BillowDocument<Registry>) => boolean): HistoryState<Registry> | null {
    const previous = this.data.undoStack.at(-1);
    if (!previous || !validate(previous.document)) return null;
    this.data = {
      ...this.data,
      undoStack: this.data.undoStack.slice(0, -1),
      redoStack: this.pushed(this.data.redoStack, current),
      group: null,
    };
    return previous;
  }

  redo(current: HistoryState<Registry>, validate: (document: BillowDocument<Registry>) => boolean): HistoryState<Registry> | null {
    const next = this.data.redoStack.at(-1);
    if (!next || !validate(next.document)) return null;
    this.data = {
      ...this.data,
      undoStack: this.pushed(this.data.undoStack, current),
      redoStack: this.data.redoStack.slice(0, -1),
      group: null,
    };
    return next;
  }

  beginComposition(snapshot: HistoryState<Registry>): void {
    this.data = { ...this.data, group: null, compositionBefore: snapshot };
  }

  setCompositionBaseline(snapshot: HistoryState<Registry>): void {
    this.data = { ...this.data, compositionBefore: snapshot };
  }

  cancelComposition(): void {
    this.data = { ...this.data, compositionBefore: null };
  }

  commitComposition(): void {
    const { compositionBefore } = this.data;
    this.data = compositionBefore
      ? {
        ...this.data,
        undoStack: this.pushed(this.data.undoStack, compositionBefore),
        redoStack: [],
        compositionBefore: null,
      }
      : { ...this.data, compositionBefore: null };
  }

  /**
   * Applies `transform` to every stored document. All of them are transformed before any are
   * replaced, so if `transform` throws, the history is left exactly as it was.
   */
  mapDocuments(transform: (document: BillowDocument<Registry>) => BillowDocument<Registry>): void {
    const mapState = (state: HistoryState<Registry>): HistoryState<Registry> => ({
      ...state,
      document: transform(state.document),
    });
    const { undoStack, redoStack, compositionBefore } = this.data;
    this.data = {
      ...this.data,
      undoStack: undoStack.map(mapState),
      redoStack: redoStack.map(mapState),
      compositionBefore: compositionBefore ? mapState(compositionBefore) : null,
    };
  }
}
