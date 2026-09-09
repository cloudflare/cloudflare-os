/**
 * The Durable Object's half of the collaboration loop: what `server.ts` needs to be the authority
 * many browsers share, without any of the gadget's own model. Shared by copy with the other
 * document-style blueprints under `lib/sync/`, so a change here belongs in each copy. Imports
 * nothing from the runtime: a registry's stubs are whatever the RPC layer delivers.
 */

export { MutationQueue } from "./mutation-queue.ts";
export { type PresenceHooks, SubscriberRegistry, type SubscriberStub } from "./subscribers.ts";
