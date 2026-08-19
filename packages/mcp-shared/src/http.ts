import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";
import { NONCE_BYTES } from "./connect-nonce.js";
import {
  errorPageHtml,
  htmlResponse,
  INVALID_LINK_HTML,
  SELF_CLOSING_HTML,
} from "./html.js";
import type { McpLog } from "./log.js";

type OAuthCallbackAccount = {
  acceptAuthCode(code: string, nonce: string, issuer?: string): Promise<boolean>;
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

  try {
    const accepted = await account.acceptAuthCode(
      code, state.slice(separator + 1), url.searchParams.get("iss") ?? undefined);
    if (!accepted) return htmlResponse(INVALID_LINK_HTML, 400);
  } catch (err) {
    log.warn("oauth code exchange failed", { event: "connect.oauth.failed", error: err });
    return htmlResponse(errorPageHtml(
      "Could not finish connecting", err instanceof Error ? err.message : String(err)), 502);
  }
  return htmlResponse(SELF_CLOSING_HTML);
}

/** Routes the HTTP paths common to both MCP connectors. */
export async function handleMcpHttpRequest<A extends OAuthCallbackAccount>(
  request: Request,
  options: {
    baseUrl: string;
    accountForId(id: string): A;
    log: McpLog;
    connect(request: Request, account: A, nonce: string, path: string): Promise<Response>;
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
