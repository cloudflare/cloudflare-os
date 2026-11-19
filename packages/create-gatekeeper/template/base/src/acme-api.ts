// The only place the gatekeeper talks HTTP to Acme Service. Calls go through the kit's typed
// client, which never follows a redirect, caps the body it reads, and turns a non-2xx answer into
// an `HttpError`.

import { createOpenAPIClient, type Client } from "@gadgets/gatekeeper-kit/http";
import { HttpError } from "@gadgets/gatekeeper-kit/http-errors";
import { API_ORIGIN } from "./acme-env";

const REQUEST_TIMEOUT_MS = 30_000;

/** A user as the API returns one. */
export type WireUser = { id: string; name: string; email?: string; avatar_url?: string };

/** An item as the API returns one. */
export type WireItem = { id: string; title: string; updated_at: string };

// STOP(api): These operations are invented. Write the provider's here, or generate them from its
// OpenAPI description (`gatekeeper-openapi-schema`, see the gatekeeper-kit README) and import the
// generated `Api` instead.
/** The operations the gatekeeper calls. */
export type Api = {
  get: [
    { path: "/me"; response: WireUser },
    { path: "/items/{id}"; response: WireItem },
  ];
  patch: [{ path: "/items/{id}"; body: { title: string }; response: WireItem }];
};

/** A typed client for the operations the gatekeeper uses. */
export type Rest = Client<Api>;

/**
 * A client that calls Acme Service with `accessToken`. One made for `"read"`, as a session's is,
 * refuses every method but `GET`: a change goes through an action, which the user approves.
 */
export function createApi(accessToken: string, mode: "read" | "write" = "read"): Rest {
  return createOpenAPIClient<Api>({
    baseUrl: API_ORIGIN,
    fetch: async request => {
      if (mode === "read" && request.method !== "GET") {
        throw new Error(`A read-only client can't send ${request.method} ${new URL(request.url).pathname}.`);
      }
      // STOP(api-auth): How the provider takes a credential, and any header every request needs.
      // Set here, after the request's own headers, so no operation's header can replace it.
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${accessToken}`);
      return await fetch(new Request(request, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
    },
  });
}

// STOP(api-errors): Which answers mean what. Many providers answer 403 for a missing scope, or 404
// for an object the user can't see; some answer 401 for both a dead credential and a forbidden one.
/** Whether the provider refused the credential itself, so it should be refreshed or replaced. */
export function isAuthError(error: unknown): boolean {
  return error instanceof HttpError && error.status === 401;
}

/** Whether the provider said the user can't see what was asked for: a definite "no access". */
export function isDenial(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 403 || error.status === 404);
}
