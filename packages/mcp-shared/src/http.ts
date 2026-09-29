// The HTTP paths both MCP connectors answer: the base-path check, the OAuth callback, the connect
// link, and the sidecar-app link a tool result hands the user.
//
// Shared rather than duplicated because a link has to be answered the same way whichever connector
// minted it, and an unrecognized path has to fail the same way too. What a route *does* stays with
// the connector (`connect`) or with `app-http.ts` (`app`).

import { stripTrailingSlashes, type ConnectHandoff } from "@gadgets/workshop-shared/gatekeeper";
import { APP_TOKEN_BYTES } from "./app-tokens.js";
import type { AppRpcReply, AppViewPage, AppViewRefusal } from "./apps.js";
import { NONCE_BYTES } from "./connect-nonce.js";
import {
  connectHandoffPageHtml,
  errorPageHtml,
  htmlResponse,
  INVALID_LINK_HTML,
} from "./html.js";
import type { McpLog } from "./log.js";

type OAuthCallbackAccount = {
  /** Finishes the code exchange; null when the callback's nonce doesn't match. */
  acceptAuthCode(code: string, nonce: string, issuer?: string): Promise<ConnectHandoff | null>;
};

/** The account methods an app link needs; `McpAccountBase` provides both. */
export type AppRouteAccount = {
  /** Resolves a link into everything the sidecar page renders, or a refusal to show instead. */
  openAppView(token: string): Promise<AppViewPage | AppViewRefusal>;
  /** Answers one JSON-RPC message from an open sidecar page. */
  callApp(token: string, message: unknown): Promise<AppRpcReply>;
};

/** What a connector serves for an app link, when it serves one at all. */
export type AppRouteHandlers<A> = {
  /** Serves the sidecar page for one app token. */
  page(request: Request, account: A, token: string): Promise<Response>;
  /** Serves one JSON-RPC message from an open sidecar page. */
  rpc(request: Request, account: A, token: string): Promise<Response>;
};

async function handleOAuthCallback(
  url: URL,
  accountForId: (id: string) => OAuthCallbackAccount,
  log: McpLog,
): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error) {
    const detail = url.searchParams.get("error_description") ?? error;
    return htmlResponse(errorPageHtml(
      "Authorization failed", `${detail} Start the connection again.`), 400);
  }

  const state = url.searchParams.get("state") ?? "";
  const separator = state.indexOf(":");
  const code = url.searchParams.get("code");
  if (separator < 0 || !code) return htmlResponse(INVALID_LINK_HTML, 400);

  let account: OAuthCallbackAccount;
  try {
    account = accountForId(state.slice(0, separator));
  } catch {
    return htmlResponse(INVALID_LINK_HTML, 400);
  }

  let handoff: ConnectHandoff | null;
  try {
    handoff = await account.acceptAuthCode(
      code, state.slice(separator + 1), url.searchParams.get("iss") ?? undefined);
  } catch (err) {
    log.warn("oauth code exchange failed", { event: "connect.oauth.failed", error: err });
    return htmlResponse(errorPageHtml(
      "Could not finish connecting", err instanceof Error ? err.message : String(err)), 502);
  }
  if (!handoff) return htmlResponse(INVALID_LINK_HTML, 400);
  return htmlResponse(connectHandoffPageHtml(handoff));
}

/**
 * Routes an app link: the sidecar page, or the JSON-RPC endpoint its script posts to.
 *
 * Both shapes carry the account id, so an id that names no account is an expired link here exactly
 * as it is for a connect link. A path that is not an app link returns undefined, which leaves it to
 * the caller's own routes: a connector serving no sidecar still answers 404 rather than a page it
 * cannot render.
 */
async function handleAppLink<A>(
  request: Request,
  path: string[],
  options: { accountForId(id: string): A } & AppRouteHandlers<A>,
): Promise<Response | undefined> {
  const [route, accountId, token, tail] = path;
  const handler =
    path.length === 3 ? options.page
      : path.length === 4 && tail === "rpc" ? options.rpc
        : undefined;
  if (route !== "app" || !handler) return undefined;
  // A token is as long as a connect nonce, and carries the same weight.
  if (accountId.length !== 64 || token.length !== APP_TOKEN_BYTES * 2) return undefined;

  let account: A;
  try {
    account = options.accountForId(accountId);
  } catch {
    return htmlResponse(INVALID_LINK_HTML, 400);
  }
  return handler(request, account, token);
}

/** Routes the HTTP paths common to both MCP connectors. */
export async function handleMcpHttpRequest<A extends OAuthCallbackAccount>(
  request: Request,
  options: {
    baseUrl: string;
    accountForId(id: string): A;
    log: McpLog;
    connect(request: Request, account: A, nonce: string, path: string): Promise<Response>;
    /**
     * The sidecar routes, absent on a connector that serves no app links. `NoInfer` so `A` is
     * settled by `accountForId`: the handlers are checked against the connector's account, not
     * inferred from the account shape they happen to be written for.
     */
    app?: AppRouteHandlers<NoInfer<A>>;
  },
): Promise<Response> {
  const url = new URL(request.url);
  const basePath = stripTrailingSlashes(new URL(options.baseUrl).pathname);
  if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
    return new Response("Not Found", { status: 404 });
  }

  const relativePath = url.pathname.slice(basePath.length);
  if (relativePath === "/oauth") {
    return handleOAuthCallback(url, options.accountForId, options.log);
  }

  const path = relativePath.slice(1).split("/");
  const app = options.app;
  if (app) {
    const response = await handleAppLink(request, path,
      { accountForId: options.accountForId, ...app });
    if (response) return response;
  }

  if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
    let account: A;
    try {
      account = options.accountForId(path[0]);
    } catch {
      return htmlResponse(INVALID_LINK_HTML, 400);
    }
    return options.connect(request, account, path[1], url.pathname);
  }

  return new Response("Not Found", { status: 404 });
}
