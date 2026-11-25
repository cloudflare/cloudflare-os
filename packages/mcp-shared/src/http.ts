import { stripTrailingSlashes, type ConnectHandoff } from "@gadgets/workshop-shared/gatekeeper";
import { NONCE_BYTES } from "./connect-nonce.js";
import {
  connectHandoffPageHtml,
  errorPageHtml,
  htmlResponse,
  INVALID_LINK_HTML,
} from "./html.js";
import type { McpLog } from "./log.js";
import type { ConnectionEnv } from "./connection.js";
import { CLIENT_METADATA_PATH, oauthClient } from "./oauth.js";

type OAuthCallbackAccount = {
  /** Finishes the code exchange; null when the callback's nonce doesn't match. */
  acceptAuthCode(code: string, nonce: string, issuer?: string): Promise<ConnectHandoff | null>;
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

/** Routes the HTTP paths common to both MCP connectors. */
export async function handleMcpHttpRequest<A extends OAuthCallbackAccount>(
  request: Request,
  options: {
    baseUrl: string;
    /** The Worker's environment, for the OAuth client it presents. */
    env: ConnectionEnv;
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
  if (relativePath === CLIENT_METADATA_PATH) {
    // The Client ID Metadata Document: an authorization server that supports them fetches this
    // URL, the client_id it was given, in place of a registration. Holds nothing secret.
    const client = oauthClient(options.baseUrl, options.env);
    if (!client.metadataUrl) return new Response("Not Found", { status: 404 });
    return Response.json({ client_id: client.metadataUrl, ...client.metadata }, {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
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
