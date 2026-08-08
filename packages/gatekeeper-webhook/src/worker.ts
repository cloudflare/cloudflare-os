// Webhooks worker: inbound HTTP endpoints a workspace hands to third-party services. The vendor
// auto-provisions accounts that expose an agent singleton and a management UI; the default fetch
// handler is the public receiver those endpoint URLs point at.

export { EndpointIndex } from "./endpoint-index.js";
export { EndpointRegistry } from "./endpoint-registry.js";
export {
  GatekeeperVendor,
  WebhookAccount,
  WebhookEndpointGatekeeper,
  WebhookGatekeeper,
  WebhookHookController,
  WebhookVerifier,
} from "./webhook.js";
export { parseEndpointPath } from "./receiver.js";

export { default } from "./receiver.js";
