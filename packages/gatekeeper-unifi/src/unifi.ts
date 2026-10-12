/**
 * The UniFi gatekeeper: Network sites, devices, WiFi networks, and guest hotspots, and Protect
 * cameras, sensors, and floodlights, through a Site Manager API key (cloud) or a console's own API
 * key (direct). This module serves the connect page and exports every entrypoint and Durable Object.
 *
 * The connect link is `${BASE_URL}/<account id>/<nonce>`, both 64 hex characters. GET renders the
 * form; POST checks the browser's Origin, reads the body under a cap, and hands the parsed input to
 * the account, which checks the credentials with UniFi and completes the connection.
 */

import {
  connectHandoffPageHtml, connectMutationError, errorPageHtml, htmlResponse, INVALID_LINK_HTML,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import {
  CONNECT_FORM_CONTENT_TYPE, connectFormHtml, formResponse, MAX_CONNECT_FORM_BYTES, parseConnectForm,
} from "./connect-form";
import { getBasePath, getBaseUrl, type UnifiEnv } from "./env";

export { UnifiAccount } from "./account";
export { UnifiGatekeeper } from "./gatekeeper";
export { GatekeeperVendor } from "./vendor";
export { UnifiUser } from "./user";
export { UnifiVerifier } from "./verifier";

const CONNECT_PATH = /^\/([0-9a-f]{64})\/([0-9a-f]{64})$/;

export default {
  async fetch(req: Request, env: UnifiEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return new Response("Not Found", { status: 404 });
    }
    const match = CONNECT_PATH.exec(url.pathname.slice(basePath.length));
    if (!match) return new Response("Not Found", { status: 404 });
    if (req.method !== "GET" && req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
    }
    const [, accountId, nonce] = match as unknown as [string, string, string];

    let account;
    try {
      account = ctx.exports.UnifiAccount.get(ctx.exports.UnifiAccount.idFromString(accountId));
    } catch {
      return htmlResponse(INVALID_LINK_HTML, 400);
    }
    const action = `${basePath}/${accountId}/${nonce}`;

    if (req.method === "GET") {
      const page = await account.connectPage(nonce);
      return page ? formResponse(connectFormHtml(action, page)) : htmlResponse(INVALID_LINK_HTML, 400);
    }

    // The expected origin is BASE_URL's, never the request's own, which a proxy may have rewritten.
    const refusal = connectMutationError(req, { origin: getBaseUrl(env), contentType: CONNECT_FORM_CONTENT_TYPE });
    if (refusal === "cross-origin") {
      return htmlResponse(errorPageHtml("Request refused", "Submit the form from the page it came from."), 403);
    }
    if (refusal === "unsupported-content-type") {
      return htmlResponse(errorPageHtml("Request refused", "That isn't a form submission."), 415);
    }
    let body: string;
    try {
      body = await readTextCapped(req, MAX_CONNECT_FORM_BYTES);
    } catch {
      return htmlResponse(errorPageHtml("Too much data", "The form submission was too large."), 413);
    }
    const page = await account.connectPage(nonce);
    if (!page) return htmlResponse(INVALID_LINK_HTML, 400);
    const parsed = parseConnectForm(body, page);
    if (!parsed.ok) return formResponse(connectFormHtml(action, page, parsed), 400);

    const outcome = await account.submitConnectForm(nonce, parsed.input);
    switch (outcome.kind) {
      case "invalid":
        return htmlResponse(INVALID_LINK_HTML, 400);
      case "retry":
        return formResponse(connectFormHtml(action, page, outcome), 400);
      case "done":
        return htmlResponse(connectHandoffPageHtml(outcome.handoff));
    }
  },
} satisfies ExportedHandler<UnifiEnv>;
