/**
 * The sync library's server entry (`@gadgets/bundled-blueprints/libraries/sync/server`): what a
 * gadget's Durable Object needs to be the authority many browsers share, without any of the
 * gadget's own model.
 *
 * - {@link MutationQueue} commits mutations in call order, each seeing the state the last one left.
 * - {@link SubscriberRegistry} keeps the subscribed browsers' stubs, fans events out to them with
 *   per-subscriber failure isolation, and announces presence as they come and go.
 * - {@link applyVersioned} is the per-item optimistic-concurrency rule: an edit based on a stale
 *   version is rejected with the authoritative item, so the client can rebase rather than lose it.
 *
 * The entry imports nothing from the runtime: a registry's stubs are whatever the RPC layer
 * delivers to the gadget's `subscribe`, seen through {@link SubscriberStub}.
 */

export { type Collaborator, normalizeCollaborator } from "./src/collaborator.ts";
export { MutationQueue } from "./src/mutation-queue.ts";
export type { PresenceEvent } from "./src/presence.ts";
export { type PresenceHooks, SubscriberRegistry, type SubscriberStub } from "./src/subscribers.ts";
export {
  applyVersioned,
  normalizeBaseVersion,
  type OperationStatus,
  operationStatus,
  type VersionConflict,
  type Versioned,
  type VersionedBatch,
  type VersionedDeletion,
  type VersionedOptions,
  type VersionedOutcome,
  type VersionedUpsert,
} from "./src/versioned.ts";
