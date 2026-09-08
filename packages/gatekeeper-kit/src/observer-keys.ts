/** Storage keys observer tracking owns, shared so no other layout can overlap them. */

/** Admitted observers, by ID. */
export const OBSERVER_PREFIX = "observer:";

/** In-flight admission attempts, durable so concurrent reads already exclude the candidate. */
export const OBSERVER_ATTEMPT_PREFIX = "observer-attempt:";

/** Cancellation nonces fencing those attempts. */
export const OBSERVER_NONCE_PREFIX = "observer-nonce:";

/**
 * One marker per owner-only read still awaiting the overseer. Transient: the read's own outcome
 * deletes it, and one stranded by a crash is compacted into the latch below.
 */
export const OBSERVER_WITHHOLD_FENCE_PREFIX = "observer-withhold-fence:";

/**
 * Set once an owner-only read was recorded, or may have been. Terminal: the binding is
 * unshareable from then on, and nothing clears it.
 */
export const OBSERVER_WITHHOLD_LATCH_KEY = "observer-withhold-latch";

// Every one of these is scanned by prefix, so a foreign key landing inside one is read as an
// observer, an admission attempt, or an unsettled withheld read.
const RESERVED = [
  OBSERVER_PREFIX, OBSERVER_ATTEMPT_PREFIX, OBSERVER_NONCE_PREFIX, OBSERVER_WITHHOLD_FENCE_PREFIX,
  OBSERVER_WITHHOLD_LATCH_KEY,
];

/**
 * @param prefix Port-chosen storage prefix, including its separator.
 * @returns The observer prefix it would scan into, or be scanned by; `undefined` when clear.
 */
export function reservedObserverOverlap(prefix: string): string | undefined {
  return RESERVED.find(
    reserved => prefix.startsWith(reserved) || reserved.startsWith(prefix));
}
