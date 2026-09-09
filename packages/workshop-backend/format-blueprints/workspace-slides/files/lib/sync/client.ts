/**
 * The browser's half of the collaboration loop: what `client.ts` needs to keep one Durable Object
 * and many browsers in step, without any of the gadget's own model. Shared by copy with the other
 * document-style blueprints under `lib/sync/`, so a change here belongs in each copy. Nothing here
 * touches the DOM.
 */

export { createSubscriber, type SyncHost } from "./subscriber.ts";
