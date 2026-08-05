import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";
import { NONCE_BYTES } from "./connect-nonce.js";
import { htmlResponse, INVALID_LINK_HTML } from "./html.js";
import type { McpLog } from "./log.js";
import { handleOAuthCallback } from "./oauth-callback.js";

type OAuthCallbackAccount = {
  acceptAuthCode(code: string, nonce: string, issuer?: string): Promise<boolean>;
};

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
