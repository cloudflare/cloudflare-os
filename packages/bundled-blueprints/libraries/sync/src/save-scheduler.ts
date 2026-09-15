/**
 * When a client's local changes go to the server.
 *
 * Typing is applied locally at once; the save that carries it to the server is debounced, so a
 * burst of keystrokes becomes one round trip, and serialized, so a save that lands while another is
 * in flight is folded into the next one rather than racing it. The scheduler owns that timing, the
 * status line's vocabulary and the retry policy; the gadget supplies the two things only it knows
 * -- how to send what is dirty ({@link SaveSchedulerOptions.save}) and whether anything still is
 * ({@link SaveSchedulerOptions.isDirty}) -- and reports what the server said as a
 * {@link SaveOutcome}, so that a rebased conflict is re-sent at once and a failed transport is
 * retried with backoff instead of as fast as the loop can turn.
 */

/** The save state shown to the reader; `synced` is the gadget's to report when a remote change lands. */
export type SaveStatus = "saved" | "saving" | "synced" | "conflict" | "offline";

/**
 * What one save did: `saved` -- everything sent was accepted (or nothing needed sending);
 * `conflict` -- something was rejected and the draft rebased, so it goes out again at once;
 * `pending` -- nothing can be sent yet because a draft waits on something else (a remote change held
 * back for the caret to leave), and the gadget will schedule again when it can.
 */
export type SaveOutcome = "saved" | "conflict" | "pending";

/** How long typing extends the wait before a save, when the gadget names no other. */
export const DEBOUNCE_MS = 220;

/**
 * How long after a failed save the next attempt waits: {@link RETRY_BASE_MS} after the first
 * failure, doubling with each consecutive one up to {@link RETRY_MAX_MS}, so a transport that
 * rejects at once (a dropped connection, a server refusing this payload) is retried a handful of
 * times a minute. Typing schedules a save as usual; a success resets the count.
 */
export const RETRY_BASE_MS = 40;

/** The longest wait between two retries of a failing save. */
export const RETRY_MAX_MS = 10_000;

/** The retry delay after `failures` consecutive failed saves. */
export function retryDelay(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/** What a {@link SaveScheduler} is built over. */
export interface SaveSchedulerOptions {
  /** Send whatever is dirty and say what the server made of it. A rejection is a failed save, retried with backoff. */
  save(): Promise<SaveOutcome>;
  /** Whether anything local still differs from what the server acknowledged; checked after every save. */
  isDirty(): boolean;
  /** The status line. */
  onStatus?(status: SaveStatus, message: string): void;
  /** Typing debounce; {@link DEBOUNCE_MS} by default. */
  debounceMs?: number;
  /** The reader may not edit: nothing is ever saved, whatever {@link isDirty} says. */
  readOnly?: boolean;
}

/** Debounces, serializes and retries a gadget's saves. */
export class SaveScheduler {
  readonly #options: SaveSchedulerOptions;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #shown: SaveStatus | null = null;
  #inFlight = false;
  #saveAgain = false;
  #failures = 0;

  constructor(options: SaveSchedulerOptions) {
    this.#options = options;
  }

  /** Whether a save is waiting to start or in flight. */
  get busy(): boolean {
    return this.#timer !== null || this.#inFlight;
  }

  /** Consecutive failed saves so far; 0 once one succeeds. */
  get failures(): number {
    return this.#failures;
  }

  /** Save soon; calling again before then extends the wait. */
  schedule(delay = this.#options.debounceMs ?? DEBOUNCE_MS): void {
    if (this.#options.readOnly) return;
    this.#status("saving", "Saving…");
    this.#arm(delay);
  }

  /**
   * Starts (or restarts) the timer that saves after `delay`. What the status line says meanwhile is
   * the caller's: `Saving…` after a keystroke, and after a failed save the failure, which stays up
   * through the backoff rather than being replaced by a `Saving…` that nothing in flight justifies.
   * The save announces itself when the timer fires, unless the line already says so.
   */
  #arm(delay: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (this.#shown !== "saving") this.#status("saving", "Saving…");
      void this.flush();
    }, delay);
  }

  /** Forget a scheduled save. One in flight completes; nothing follows it unless it must. */
  cancel(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * Save now -- or, while a save is in flight, once it finishes. After the save, another is
   * scheduled if the server rejected anything, if it failed (after {@link retryDelay}), or if the
   * gadget is dirty again; a `pending` outcome schedules nothing, the gadget will.
   */
  async flush(): Promise<void> {
    this.cancel();
    if (this.#options.readOnly) return;
    if (this.#inFlight) {
      this.#saveAgain = true;
      return;
    }
    this.#inFlight = true;
    let outcome: SaveOutcome | null = null;
    try {
      outcome = await this.#options.save();
      this.#failures = 0;
      if (outcome === "conflict") {
        this.#saveAgain = true;
        this.#status("conflict", "Resolving concurrent edit…");
      } else if (outcome === "pending") {
        this.#status("conflict", "Concurrent edit pending");
      } else {
        this.#status("saved", "Saved");
      }
    } catch {
      this.#failures++;
      this.#saveAgain = true;
      this.#status("offline", "Save failed — retrying");
    } finally {
      this.#inFlight = false;
      if (this.#saveAgain || (outcome !== "pending" && this.#options.isDirty())) {
        this.#saveAgain = false;
        if (this.#failures) {
          this.#arm(retryDelay(this.#failures));
        } else {
          this.schedule(RETRY_BASE_MS);
        }
      }
    }
  }

  #status(status: SaveStatus, message: string): void {
    this.#shown = status;
    this.#options.onStatus?.(status, message);
  }
}
