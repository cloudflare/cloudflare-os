// The operations the gatekeeper calls, as the kit's typed client takes them.

import type { WireItem, WireUser } from "./acme-api";

// STOP(api): These operations are invented. Write the provider's here, or generate them from its
// OpenAPI description: list the operations the gatekeeper calls in a file, run
// `gatekeeper-openapi-schema` over it (`pnpm generate:openapi`, where the package was made with
// `--openapi`; see the gatekeeper-kit README) and import the generated `Api` instead of this one.
/** The operations the gatekeeper calls. */
export type Api = {
  get: [
    { path: "/me"; response: WireUser },
    { path: "/items/{id}"; response: WireItem },
  ];
  patch: [{ path: "/items/{id}"; body: { title: string }; response: WireItem }];
};
