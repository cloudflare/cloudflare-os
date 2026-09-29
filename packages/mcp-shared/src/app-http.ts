// The sidecar-app routes: the page a tool result's link opens, and the JSON-RPC endpoint that page
// posts to on the View's behalf.
//
// In the shared package rather than in a Worker because both connectors serve exactly these routes,
// and because both halves are security surface: the page carries the token that authorizes the
// app's calls, and the endpoint is the only way a sandboxed window inside it reaches this
// deployment.

import { connectMutationError } from "@gadgets/gatekeeper-kit/connect-pages";
import { readTextCapped, ResponseTooLargeError } from "@gadgets/gatekeeper-kit/response-body";
import { appPageHtml } from "./app-page.js";
import { errorPageHtml, htmlResponse } from "./html.js";
import type { AppRouteAccount, AppRouteHandlers } from "./http.js";
import type { McpLog } from "./log.js";

// One message is a tools/call with its arguments, not a document being uploaded: the data travels
// back in the reply, and a View that needs to send more than this is using the wrong transport.
const MAX_APP_RPC_BYTES = 64 * 1024;

/**
 * Wraps a serialized JSON-RPC message as the endpoint's reply.
 *
 * Nothing here is cacheable: a reply carries live tool output and, on the page route, a document the
 * server controls.
 */
function jsonReply(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * A JSON-RPC error for a request refused before the account saw it.
 *
 * The page relays whatever comes back to the View, so a refusal has to be JSON-RPC like any other
 * reply; the shape is the specification's, not this module's.
 * @param message Sentence the View may show.
 * @param status HTTP status, which the View never reads.
 * @returns The serialized error reply.
 */
function jsonError(message: string, status: number): Response {
  return jsonReply(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message } }), status);
}

/**
 * The sidecar page and JSON-RPC route handlers, for `handleMcpHttpRequest`'s `app` option.
 *
 * Typed by the connector's own account: the handlers are handed exactly what that Worker's link
 * resolver returns, so the routes and the account are checked against one type rather than two
 * descriptions of it.
 */
export function appHttp<A extends AppRouteAccount = AppRouteAccount>(
  options: { baseUrl: string; log: McpLog },
): AppRouteHandlers<A> {
  const origin = new URL(options.baseUrl).origin;

  return {
    async page(request, account, token) {
      const view = await account.openAppView(token);
      if ("refusal" in view) {
        // 400 like an expired connect link: the user followed a link that no longer works.
        return htmlResponse(errorPageHtml("This app link no longer works", view.refusal), 400);
      }
      return htmlResponse(appPageHtml({ view, pageUrl: request.url }));
    },

    async rpc(request, account, token) {
      // Before the body is read: a document from another origin, or a post that is not JSON, is
      // refused without the account hearing about it, and there is nothing to read a body for.
      const refusal = connectMutationError(request, { origin, contentType: "application/json" });
      if (refusal) {
        options.log.warn("app rpc refused", { event: "app.rpc.refused" });
        return refusal === "cross-origin"
          ? jsonError("This endpoint answers only its own page.", 403)
          : jsonError("This endpoint takes application/json.", 415);
      }

      // Read through the kit's capped reader rather than growing a second one: the body is refused
      // while it arrives, so an oversized message is never buffered on its way to rejection.
      let message: string;
      try {
        message = await readTextCapped(new Response(request.body), MAX_APP_RPC_BYTES);
      } catch (error) {
        if (!(error instanceof ResponseTooLargeError)) throw error;
        options.log.warn("app rpc body too large", { event: "app.rpc.refused" });
        return jsonError("This request is too large.", 413);
      }

      // The account owns parsing, the method allow-list, the read-only rule, and the reply status.
      const reply = await account.callApp(token, message);
      return jsonReply(reply.body, reply.status);
    },
  };
}
