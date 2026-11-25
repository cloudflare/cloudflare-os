/**
 * Bookkeeping for edits the browser performs on its own, and for IME composition. In both cases
 * the DOM has already changed by the time the editor sees the result, so the editor has to
 * remember what to go back to.
 *
 * A native edit has this lifecycle:
 *
 * 1. `beforeinput` decides to let the browser edit. It records the undo step right away (the
 *    DOM is about to change) and calls `begin` with the state to return to if the edit is
 *    rejected. From now on `historyRecorded` is true.
 * 2. `input` reads the DOM back and then does exactly one of:
 *    - accept it: `settle` (the undo step already exists);
 *    - reject it or discard it: `takeRestorePoint` and restore that state.
 *
 * An edit the editor never saw a `beforeinput` for (the event was not cancelable, or the browser
 * skipped it) has no restore point and `historyRecorded` stays false, so `input` records the
 * undo step itself.
 *
 * `RestorePoint` is whatever the editor needs to roll back; this class only holds on to it.
 */
export class NativeEditTracker<RestorePoint> {
  private restorePoint: RestorePoint | null = null;
  private recorded = false;
  private composing = false;

  /** Between compositionstart and compositionend: the IME owns the DOM. */
  get isComposing(): boolean {
    return this.composing;
  }

  setComposing(composing: boolean): void {
    this.composing = composing;
  }

  /** Whether `beforeinput` already pushed the undo step for the edit in flight. */
  get historyRecorded(): boolean {
    return this.recorded;
  }

  /**
   * Sets the flag directly. Used when a rollback restores the editor to a moment that had a
   * particular value, and when abandoning bookkeeping (pass false).
   */
  setHistoryRecorded(recorded: boolean): void {
    this.recorded = recorded;
  }

  /** The state to return to if the edit in flight is rejected, without consuming it. */
  get pendingRestorePoint(): RestorePoint | null {
    return this.restorePoint;
  }

  /** A native edit is about to happen, and its undo step has just been recorded. */
  begin(restorePoint: RestorePoint): void {
    this.restorePoint = restorePoint;
    this.recorded = true;
  }

  /** The edit is being rejected: hands back the restore point (if any) and forgets it. */
  takeRestorePoint(): RestorePoint | null {
    const restorePoint = this.restorePoint;
    this.restorePoint = null;
    return restorePoint;
  }

  /** Forgets the restore point but leaves `historyRecorded` as it is. */
  clearRestorePoint(): void {
    this.restorePoint = null;
  }

  /** The edit was accepted: nothing is in flight any more. */
  settle(): void {
    this.restorePoint = null;
    this.recorded = false;
  }
}
