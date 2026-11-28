// The operations the gatekeeper calls, as the kit's typed client takes them.

import type { WireItem, WireUser } from "./acme-api";
// #if hooks-subscription
import type { WireWebhook } from "./acme-api";
// #endif

// STOP(api): These operations are invented. Write the provider's here, or generate them from its
// OpenAPI description: list the operations the gatekeeper calls in a file, run
// `gatekeeper-openapi-schema` over it (`pnpm generate:openapi`, where the package was made with
// `--openapi`; see the gatekeeper-kit README) and import the generated `Api` instead of this one.
/** The operations the gatekeeper calls. */
export type Api = {
  get: [
    { path: "/me"; response: WireUser },
    { path: "/items/{id}"; response: WireItem },
    // #if hooks-subscription
    { path: "/items/{id}/webhooks/{webhook}"; response: WireWebhook },
    // #endif
  ];
  patch: [{ path: "/items/{id}"; body: { title: string }; response: WireItem }];
  // #if hooks-subscription
  /** The webhooks the hook driver adds and deletes. */
  post: [{ path: "/items/{id}/webhooks"; body: { url: string; secret: string }; response: WireWebhook }];
  delete: [{ path: "/items/{id}/webhooks/{webhook}"; response: undefined }];
  // #endif
};
