/**
 * Who else has the gadget open, and telling them where we are.
 *
 * Presence is ephemeral: it never enters what the gadget stores, and a collaborator whose browser
 * vanished without saying goodbye simply stops being heard from. So each side keeps time. The
 * {@link PresenceReporter} sends this client's position at most every {@link THROTTLE_MS} while it
 * moves and once every {@link HEARTBEAT_MS} while it does not, so a stationary cursor stays alive;
 * the {@link PresenceRoster} forgets anyone silent for {@link STALE_MS}. What a "position" is --
 * a caret in a block, a cell range, nothing at all -- is the gadget's `Cursor` type; the roster
 * carries it without reading it.
 */

import type { Collaborator } from "./collaborator.ts";

/** Presence is re-sent this often even when nothing moved, which is also how often the roster expires the silent. */
export const HEARTBEAT_MS = 4000;

/** A collaborator not heard from for this long is dropped: three missed heartbeats. */
export const STALE_MS = 12_000;

/** Position changes are sent at most this often. */
export const THROTTLE_MS = 70;

/**
 * A presence event as the server broadcasts it: someone joined (their identity, no position yet),
 * moved (identity plus the gadget's `Cursor` fields, and when), or left.
 */
export type PresenceEvent<Cursor extends object = Record<never, never>> =
  | ({ type: "join" } & Collaborator)
  | ({ type: "cursor"; at?: number } & Collaborator & Cursor)
  | { type: "leave"; clientId: string };

/** One collaborator as the roster knows them: identity, last position (none until they moved) and when they were last heard from. */
export interface RosterEntry<Cursor extends object = Record<never, never>> extends Collaborator {
  cursor: Cursor | null;
  seenAt: number;
}

/** Everyone else here, from the presence events the server delivers. */
export class PresenceRoster<Cursor extends object = Record<never, never>> {
  readonly #selfId: string;
  readonly #now: () => number;
  readonly #people = new Map<string, RosterEntry<Cursor>>();

  /** `selfId` is this client's id, whose events are ignored; `now` is the clock (`Date.now` unless a test says otherwise). */
  constructor(selfId: string, now: () => number = Date.now) {
    this.#selfId = selfId;
    this.#now = now;
  }

  /** Everyone currently known, in order of first hearing from them, for a "who is here" strip. */
  people(): Collaborator[] {
    return Array.from(this.#people.values(), ({ clientId, name, color }) => ({ clientId, name, color }));
  }

  /** Everyone currently known, with their positions, for drawing. */
  entries(): RosterEntry<Cursor>[] {
    return Array.from(this.#people.values());
  }

  /** One collaborator, or `null` when unknown. */
  get(clientId: string): RosterEntry<Cursor> | null {
    return this.#people.get(clientId) ?? null;
  }

  /**
   * Take in an event. A join for someone already known -- a reconnect, or the seeding of a newcomer
   * -- refreshes their name and colour but keeps their position. Returns whether anything changed,
   * which is when to redraw; the client's own events and ones naming nobody change nothing.
   */
  apply(event: PresenceEvent<Cursor>): boolean {
    if (!event.clientId || event.clientId === this.#selfId) return false;
    if (event.type === "leave") return this.#people.delete(event.clientId);
    const known = this.#people.get(event.clientId);
    const { clientId, name, color } = event;
    const cursor = event.type === "cursor" ? cursorOf(event) : (known?.cursor ?? null);
    this.#people.set(clientId, { clientId, name, color, cursor, seenAt: this.#now() });
    return true;
  }

  /** Drop everyone not heard from for {@link STALE_MS}. Returns whether anyone was dropped. */
  expire(now = this.#now()): boolean {
    let changed = false;
    for (const [id, person] of this.#people) {
      if (person.seenAt < now - STALE_MS) {
        this.#people.delete(id);
        changed = true;
      }
    }
    return changed;
  }
}

/**
 * The gadget's position fields of a cursor event: everything it carries beyond identity and time.
 * The rest of a spread over a type parameter is opaque to the compiler, hence the cast.
 */
function cursorOf<Cursor extends object>(event: { type: "cursor"; at?: number } & Collaborator & Cursor): Cursor {
  const { type: _type, at: _at, clientId: _clientId, name: _name, color: _color, ...cursor } = event;
  return cursor as unknown as Cursor;
}

/** Sends this client's own position: throttled while it moves, on a heartbeat while it does not. */
export class PresenceReporter<Update> {
  readonly #current: () => Update | null;
  readonly #send: (update: Update) => Promise<unknown>;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  /**
   * `current` reads the position to send (`null` when there is nothing to say right now); `send`
   * delivers it, and its rejections are ignored -- presence is best-effort and the next one is
   * seconds away.
   */
  constructor(current: () => Update | null, send: (update: Update) => Promise<unknown>) {
    this.#current = current;
    this.#send = send;
  }

  /** Send soon, coalescing a burst of movement into one update per {@link THROTTLE_MS}. */
  schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.sendNow(), THROTTLE_MS);
  }

  /** Send the current position now, dropping any scheduled send. */
  sendNow(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const update = this.#current();
    if (update !== null) this.#send(update).catch(() => {});
  }

  /**
   * Every {@link HEARTBEAT_MS}, send the current position and then run `onBeat` -- where the gadget
   * expires its roster and redraws. Returns the function that stops the heartbeat; starting again
   * replaces a running one.
   */
  startHeartbeat(onBeat?: () => void, intervalMs = HEARTBEAT_MS): () => void {
    this.stopHeartbeat();
    this.#heartbeat = setInterval(() => {
      this.sendNow();
      onBeat?.();
    }, intervalMs);
    return () => this.stopHeartbeat();
  }

  /** Stop the heartbeat and drop any scheduled send. */
  stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
