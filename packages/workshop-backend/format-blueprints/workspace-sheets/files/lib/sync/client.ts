/**
 * The browser's half of the collaboration loop: what `client.ts` needs to keep one Durable Object
 * and many browsers in step, without any of the gadget's own model. Shared by copy with the other
 * document-style blueprints under `lib/sync/`, so a change here belongs in each copy. Nothing here
 * touches the DOM.
 */

export { type Collaborator, collaboratorFor, DEFAULT_COLOR, DEFAULT_NAME } from "./collaborator.ts";
export {
  HEARTBEAT_MS,
  type PresenceEvent,
  PresenceReporter,
  PresenceRoster,
  type RosterEntry,
  STALE_MS,
  THROTTLE_MS,
} from "./presence.ts";
export {
  DEBOUNCE_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  retryDelay,
  type SaveOutcome,
  SaveScheduler,
  type SaveSchedulerOptions,
  type SaveStatus,
} from "./save-scheduler.ts";
export { createSubscriber, type SyncHost } from "./subscriber.ts";
