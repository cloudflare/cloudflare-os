/**
 * The sync library's browser entry (`gadgets:sync/client`): what a gadget's `client.js` needs to
 * keep one Durable Object and many browsers in step, without any of the gadget's own model.
 *
 * - {@link SaveScheduler} debounces, serializes and retries saves; the gadget says what is dirty
 *   and how to send it.
 * - {@link PresenceRoster} and {@link PresenceReporter} keep and report who is where, on the
 *   shared heartbeat, staleness and throttle constants; the gadget draws the result.
 * - {@link createSubscriber} builds the `RpcTarget` the server calls back, over the class the
 *   gadget's bootstrap provides.
 *
 * Nothing here touches the DOM: every module is driven through the functions the gadget passes in
 * and is tested in Node.
 */

export { type Collaborator, collaboratorFor, DEFAULT_COLOR, DEFAULT_NAME } from "./src/collaborator.ts";
export {
  HEARTBEAT_MS,
  type PresenceEvent,
  PresenceReporter,
  PresenceRoster,
  type RosterEntry,
  STALE_MS,
  THROTTLE_MS,
} from "./src/presence.ts";
export {
  DEBOUNCE_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  retryDelay,
  type SaveOutcome,
  SaveScheduler,
  type SaveSchedulerOptions,
  type SaveStatus,
} from "./src/save-scheduler.ts";
export { createSubscriber, type SyncHost } from "./src/subscriber.ts";
export { normalizeBaseVersion } from "./src/versioned.ts";
