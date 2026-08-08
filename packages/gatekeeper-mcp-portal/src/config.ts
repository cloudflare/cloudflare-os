// The one endpoint this connector talks to, as the deployment administrator configured it.
//
// The endpoint being a deployment setting rather than user input is what separates this connector
// from the generic one: there is no user-supplied URL or connect form, a grant is scoped to one
// upstream server rather than the portal as a whole, and an unconfigured deployment hides the
// connector instead of offering a dead end. See the README.

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { ConnectedServer, ServerAuthKind } from "@gadgets/mcp-shared/account";
import type { ToolScope } from "@gadgets/mcp-shared/scope";
import { fetchOptions } from "@gadgets/mcp-shared/fetch";
import { sameEndpoint } from "@gadgets/mcp-shared/scope";
import type { ServerTrust } from "@gadgets/mcp-shared/tools";

// The configured portal, once the deployment's vars have been read and validated.
export type PortalConfig = {
  // The portal's MCP endpoint URL (Streamable HTTP).
  endpoint: string;
  // Display name shown in the connector list and in every approval prompt.
  name: string;
  // How to authenticate.
  auth: ServerAuthKind;
};

// Stable id used in binding names, action kinds, and generated type names.
export const PORTAL_SERVER_ID = "portal";

// Whether this portal's tool annotations may drive auto-approval. Off unless a deployment asserts
// that the upstreams are trusted, since a portal relays annotations written by servers the
// administrator never reviewed.
//
// Call it at the point of use, every time. Persisting the answer would leave accounts vetted after
// an administrator withdrew the assertion, until each one reconnected.
export function portalTrust(env: Env): ServerTrust {
  return (env.MCP_PORTAL_TRUST_ANNOTATIONS ?? "").toLowerCase() === "true" ? "vetted" : "byo";
}

// Reads the deployment's portal configuration, or null when it is not configured. A missing or
// unusable `MCP_PORTAL_URL` returns null rather than throwing, so the connector advertises no
// resources and the Workshop hides it.
export function readPortalConfig(env: Env): PortalConfig | null {
  const raw = env.MCP_PORTAL_URL?.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // The same rule `guardedFetch` applies anyway. Enforcing it here means an `http://` typo hides the
  // connector rather than failing on the first request, with an error naming a URL the user never
  // saw.
  if (url.protocol !== "https:" && !(fetchOptions(env).allowInsecure && url.protocol === "http:")) {
    return null;
  }
  // URL userinfo is an ambient credential: URL and fetch APIs can copy it into requests, while this
  // connector also persists and returns the endpoint to users and configurator frames. Portal auth
  // has explicit OAuth/token settings, so reject rather than silently stripping credentials and
  // contacting a different endpoint than the administrator configured.
  if (url.username || url.password) return null;
  url.hash = "";

  const configured = env.MCP_PORTAL_AUTH?.trim().toLowerCase();
  const auth: ServerAuthKind =
    configured === "none" || configured === "token" ? configured : "oauth";

  return {
    endpoint: url.toString(),
    name: env.MCP_PORTAL_NAME?.trim() || `MCP Server Portal (${url.host})`,
    auth,
  };
}

// Refuses a grant that does not name one upstream server.
//
// A portal flattens many systems behind one endpoint, so a scope with no `serverId` is a grant over
// all of them at once -- `scopeAllows` permits every tool that is not portal-native -- and that is
// the one breadth this connector deliberately does not offer.
//
// This is the enforcement, not the configurator. The form refuses to *emit* such a URL, but a
// resource URL is not only ever produced by the form: an agent passes a concrete one to
// `requestConnection`, and any URL under the portal's origin reaches `getGatekeeperClassFor`. A
// rule that lives only in the iframe is a suggestion; the facet is minted here.
export function requirePortalServerScope(scope: ToolScope): void {
  if (scope.serverId !== undefined) return;
  throw new Error(
    "A portal grant has to name one of the servers behind the portal. Granting the portal itself " +
    "would cover every system connected to it, including ones added later.");
}

// The single resource type this connector offers, scoped to the configured portal's origin.
export function portalResource(config: PortalConfig): SupportedResource {
  return {
    // Origin-scoped, so a resource URL for anything else matches nothing this connector offers.
    urlPattern: `${new URL(config.endpoint).origin}/*`,
    title: config.name,
    description:
      "Tools from the servers behind this portal. Writes need approval.",
  };
}

// The connected-server record stored on an account, derived entirely from configuration.
// `provenance` is what keeps the far side from renaming itself over `MCP_PORTAL_NAME` in every
// approval prompt (see `McpAccountBase.complete`).
export function portalServer(config: PortalConfig): ConnectedServer {
  return {
    endpoint: config.endpoint,
    provenance: "deployment",
    auth: config.auth,
    serverId: PORTAL_SERVER_ID,
    serverName: config.name,
  };
}

// Probing may legitimately move between none and OAuth. A preissued token is deployment authority,
// so entering or leaving that mode requires the account to reconnect against current configuration.
export function portalAuthRequiresReconnect(
  connected: ServerAuthKind, configured: ServerAuthKind,
): boolean {
  return (connected === "token") !== (configured === "token");
}

// The preissued token, but only for the endpoint the deployment currently names.
//
// `MCP_PORTAL_TOKEN` is the one credential in this connector read from live configuration rather
// than from an account's storage. Everything else an account hands out was minted for the endpoint
// that account records, so it is safe to send there by construction. This is not: an administrator
// repoints the gateway by editing the URL and its token together, which touches no account, so
// until someone reconnects the account still names the old host while this value is already the new
// deployment's secret. An account-side endpoint check cannot catch that -- it compares the caller
// against storage that has not moved yet -- so the scoping has to happen here, against the
// configuration the token actually belongs to.
//
// Null means "this deployment has no token for that endpoint", covering both a portal with no token
// configured and one that has since been repointed. Callers fail the request closed either way.
export function portalTokenFor(env: Env, endpoint: string): string | null {
  const config = readPortalConfig(env);
  if (config?.auth !== "token" || !sameEndpoint(config.endpoint, endpoint)) return null;
  return env.MCP_PORTAL_TOKEN || null;
}
