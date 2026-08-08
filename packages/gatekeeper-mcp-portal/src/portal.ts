// The MCP Server Portals gatekeeper: connects the deployment's own MCP portal as a Gadgets
// capability. A portal is one endpoint fronting many upstream MCP servers; Cloudflare's MCP Server
// Portals is the case this is written against.
//
// A sibling of the generic MCP connector rather than a mode of it: the endpoint is a deployment
// setting rather than user input, and a grant is scoped to one upstream server. Everything else is
// shared via `@gadgets/mcp-shared`. See the README.
import { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  matchesResourceUrlPattern,
  stripTrailingSlashes,
  type AvatarImage,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { ToolCatalog } from "@gadgets/mcp-shared/client";
import {
  classifyTool,
  type ServerTrust,
} from "@gadgets/mcp-shared/tools";
import { bindingNameFragment, hostOf } from "@gadgets/mcp-shared/util";
import type { McpLog, McpLogFields } from "@gadgets/mcp-shared/log";
import { generateSessionTypes, sessionTypeName } from "@gadgets/mcp-shared/schema-to-ts";
import { McpAccountBase, type ConnectedServer, type ConnectOutcome }
  from "@gadgets/mcp-shared/account";
import { generateNonce } from "@gadgets/mcp-shared/connect-nonce";
import { fetchTools, withClient, type ConnectionAccount } from "@gadgets/mcp-shared/connection";
import { McpSessionBase } from "@gadgets/mcp-shared/session";
import { McpFacetBase } from "@gadgets/mcp-shared/facet";
import {
  groupToolsByServer,
  looksLikePortal,
  parsePortalServers,
  reconcilePortalServers,
  PORTAL_LIST_SERVERS_TOOL,
  type PortalServer,
} from "@gadgets/mcp-shared/portal";
import {
  endpointOfResourceUrl,
  endpointTag,
  parseToolScope,
  requireCompleteCatalogForToolSelection,
  sameEndpoint,
  scopeAllows,
  validateToolScopeAgainstCatalog,
  type ToolScope,
} from "@gadgets/mcp-shared/scope";
import {
  errorPageHtml,
  htmlResponse,
  INVALID_LINK_HTML,
  SELF_CLOSING_HTML,
} from "@gadgets/mcp-shared/html";
import { handleMcpHttpRequest } from "@gadgets/mcp-shared/http";
import {
  McpGatekeeperUserBase,
  mcpGatekeeperUserContext,
  type McpGatekeeperUserProps,
} from "@gadgets/mcp-shared/user";
import {
  portalAuthRequiresReconnect,
  portalResource,
  portalServer,
  portalTokenFor,
  portalTrust,
  readPortalConfig,
  requirePortalServerScope,
} from "./config.js";
import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";
import { MCP_BASE_TYPES } from "@gadgets/mcp-shared/base-types";
import PORTAL_LOGO_SVG from "./portal-logo.svg";
import MCP_SERVER_CONFIGURATOR_HTML from "./generated/server-configurator-ui.txt";
import type { McpServerConfiguratorRpc } from "./configurator/server-configurator-types";

const VENDOR_ID = "mcp_portal";

const logger = createLogger<McpLogFields>({
  component: "gatekeeper.mcp-portal", vendorId: VENDOR_ID,
});


const PORTAL_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(PORTAL_LOGO_SVG)}`;
const PORTAL_AVATAR: AvatarImage = { url: PORTAL_LOGO_URL };

// Cloudflare orange, matching the Cloudflare Gateway glyph used as the mark. A deployment fronting
// some other aggregator should change both together.
const PORTAL_COLOR = "#f6821f";

// ---------------------------------------------------------------------------
// Helpers

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/mcp-portal");
}

async function fetchPortalServers(
  env: Env,
  account: DurableObjectStub<McpAccount>,
  endpoint: string,
): Promise<PortalServer[]> {
  try {
    const result = await withClient(env, account, endpoint,
      client => client.callTool(PORTAL_LIST_SERVERS_TOOL, {}));
    return parsePortalServers(result);
  } catch (err) {
    logger.warn("could not list portal servers", {
      event: "portal.servers.list.failed",
      serverHost: hostOf(endpoint),
      error: err,
    });
    return [];
  }
}

// HTTP handler. There is no page asking which server to connect, since the endpoint is configured,
// so the only browser round trip is the portal's own authorization.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleMcpHttpRequest(req, {
      baseUrl: getBaseUrl(env),
      accountForId: id => ctx.exports.McpAccount.get(
        ctx.exports.McpAccount.idFromString(id)),
      log: logger,
      connect: async (request, account, initiationNonce) => {
        if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
        return continueConnect(account, initiationNonce, env);
      },
    });
  },
};

// Hands off to the account DO, which owns every credential. The target comes from configuration, so
// this is the same call for a first connect and a reconnect.
async function continueConnect(
  account: DurableObjectStub<McpAccount>,
  initiationNonce: string,
  env: Env,
): Promise<Response> {
  const config = readPortalConfig(env);
  if (!config) {
    return htmlResponse(errorPageHtml(
      "No MCP server portal is configured",
      "Ask an administrator to set this deployment's MCP server portal URL."), 503);
  }

  let outcome: ConnectOutcome;
  try {
    outcome = await account.beginConnect(initiationNonce, portalServer(config));
  } catch (err) {
    logger.warn("connect failed", { event: "connect.failed", error: err });
    return htmlResponse(errorPageHtml(
      "Could not connect", err instanceof Error ? err.message : String(err)), 502);
  }

  if (outcome.kind === "invalid") return htmlResponse(INVALID_LINK_HTML, 400);
  if (outcome.kind === "redirect") return Response.redirect(outcome.url, 302);
  return htmlResponse(SELF_CLOSING_HTML);
}

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    const config = readPortalConfig(this.env);
    return {
      displayName: config?.name ?? "Cloudflare MCP Server Portals",
      url: "https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/",
      logo: PORTAL_AVATAR,
      color: PORTAL_COLOR,
      tagline: config
        ? `Connect a server behind ${hostOf(config.endpoint)}`
        : "No MCP server portal is configured",
      description:
        "Use the MCP servers this organization has approved, through its MCP server portal. Reads " +
        "happen straight away. Anything that writes waits for your approval.",
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const accountId = this.ctx.exports.McpAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.McpAccount.get(accountId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${accountId.toString()}/${initiationNonce}` };
  }

  // The one resource this connector offers, or none when unconfigured. Returning nothing is how the
  // connector hides itself: the Workshop drops a vendor that advertises no resources.
  async getSupportedResources(): Promise<SupportedResource[]> {
    const config = readPortalConfig(this.env);
    return config ? [portalResource(config)] : [];
  }

  async getTypeScriptTypes(): Promise<string> {
    // Vendor-level types are the transport-neutral base only. The per-tool `callTool` overloads are
    // generated per resource, from the chosen upstream server's own catalog; see
    // `McpGatekeeperImpl.getTypeScriptTypes()`.
    return MCP_BASE_TYPES;
  }
}

// ---------------------------------------------------------------------------
// Account DO — owns the endpoint choice and every credential for it.

// One connected portal, for one user. Nothing outside this object ever sees a credential.
//
// The endpoint is a deployment setting rather than user input, so the preissued token is the only
// real addition: a portal may be fronted by one instead of using OAuth.
export class McpAccount extends McpAccountBase<Env> {
  protected baseUrl(): string {
    return getBaseUrl(this.env);
  }

  protected log(): McpLog {
    return logger;
  }

  protected mintAccount(): Fetcher<GatekeeperUser> {
    const props: McpGatekeeperUserProps = { accountObjectId: this.ctx.id.toString() };
    return this.ctx.exports.GatekeeperUserImpl({ props });
  }

  // Scoped to the endpoint this account is connected to, never merely to what configuration says
  // today. The rule lives beside the configuration it guards, in `portalTokenFor`.
  protected override staticToken(server: ConnectedServer): string | null {
    return portalTokenFor(this.env, server.endpoint);
  }
}

// ---------------------------------------------------------------------------
// Account-facing interface

@validateRpc()
export class GatekeeperUserImpl
  extends McpGatekeeperUserBase<Env>
  implements GatekeeperUser {

  #account(): DurableObjectStub<McpAccount> {
    return this.ctx.exports.McpAccount.get(
      this.ctx.exports.McpAccount.idFromString(this.ctx.props.accountObjectId));
  }

  protected [mcpGatekeeperUserContext]() {
    return { account: this.#account(), avatar: PORTAL_AVATAR, baseUrl: getBaseUrl(this.env) };
  }

  // The portal as currently configured, not as it was when this account connected. Repointing the
  // deployment therefore surfaces as a reconnect, via `getGatekeeperClassFor` refusing the old
  // endpoint, rather than as a Gadget quietly talking to a portal nobody chose.
  async getSupportedResources(): Promise<SupportedResource[]> {
    const config = readPortalConfig(this.env);
    return config ? [portalResource(config)] : [];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<unknown>>;
    resource: SupportedResource;
  }> {
    const config = readPortalConfig(this.env);
    if (!config) {
      throw new Error("This deployment has no MCP server portal configured.");
    }
    const server = await this.#account().getServer();
    const resource = portalResource(config);

    // The account connected to one portal and the deployment now names one; a repoint between the
    // two must surface as a reconnect. Otherwise this facet would be minted against the endpoint
    // frozen on the account while the deployment believes it configured a different one.
    if (!sameEndpoint(server.endpoint, config.endpoint)) {
      throw new Error(
        `This connection is for ${hostOf(server.endpoint)}, but this deployment's portal is now ` +
        `${hostOf(config.endpoint)}. Reconnect the account.`);
    }
    if (portalAuthRequiresReconnect(server.auth, config.auth)) {
      throw new Error("This deployment's portal authentication changed. Reconnect the account.");
    }

    // The account holds credentials for one portal, so a resource URL naming any other endpoint is
    // not this account's to grant. Compared in full rather than by origin: one host can front `/mcp`
    // and `/mcp-v2` as unrelated endpoints, and the facet always calls the endpoint recorded on the
    // account, so an origin-only test would honour a grant against a URL nobody connected to.
    const requested = new URL(url, server.endpoint);
    if (!sameEndpoint(requested.toString(), config.endpoint)) {
      throw new Error(
        `This connection is for ${config.endpoint}, not ` +
        `${endpointOfResourceUrl(requested)}.`);
    }
    if (!matchesResourceUrlPattern(resource.urlPattern, requested.toString())) {
      throw new Error(`"${url}" does not match this connection's resource type.`);
    }

    // The fragment records how much of the portal this binding may call; see `scope.ts`. A grant
    // that names no upstream server would reach every system behind the portal, so it is refused
    // here rather than only in the form that normally builds these URLs.
    const scope = parseToolScope(requested);
    requirePortalServerScope(scope);
    const [catalog, portalServers] = await Promise.all([
      fetchTools(this.env, this.#account(), server.endpoint),
      fetchPortalServers(this.env, this.#account(), server.endpoint),
    ]);
    const upstream = validateToolScopeAgainstCatalog(
      scope,
      catalog,
      portalServers,
    );

    const props: McpGatekeeperImplProps = {
      accountObjectId: this.ctx.props.accountObjectId,
      endpoint: server.endpoint,
      serverId: server.serverId,
      serverName: config.name,
      scopeServerName: upstream?.name ?? scope.serverId!,
      scope,
    };
    return { class: this.ctx.exports.McpGatekeeperImpl({ props }), resource };
  }

  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    return {
      iframeHtml: MCP_SERVER_CONFIGURATOR_HTML,
      ui: new RpcStub(new McpServerConfiguratorUI(this.env, this.#account())),
    };
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.McpPortalVerifier({});
  }
}

// ---------------------------------------------------------------------------
// Verifier

// Required by the `GatekeeperUser` contract but never interrogated, since `addObserver` refuses
// everyone.
@validateRpc()
export class McpPortalVerifier
  extends WorkerEntrypoint<Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Resource configurator

@validateRpc()
class McpServerConfiguratorUI extends RpcTarget implements McpServerConfiguratorRpc {
  #env: Env;
  #account: DurableObjectStub<McpAccount>;
  #toolsPromise: Promise<ToolCatalog> | undefined;

  constructor(env: Env, account: DurableObjectStub<McpAccount>) {
    super();
    this.#env = env;
    this.#account = account;
  }

  async getEndpoint(): Promise<string> {
    return (await this.#account.getServer()).endpoint;
  }

  // One `tools/list` per configurator frame, shared by every question the form asks.
  #tools(): Promise<ToolCatalog> {
    this.#toolsPromise ??= (async () => {
      const server = await this.#account.getServer();
      return await fetchTools(this.#env, this.#account, server.endpoint);
    })();
    return this.#toolsPromise;
  }

  // The upstream servers behind a portal, derived from the tool list so there is no separate probe
  // to keep in step. Empty for a plain MCP server and for a portal currently fronting nothing; the
  // form treats both as having nothing to grant rather than telling them apart.
  async listServerOptions(): Promise<ConfiguratorUIOption[]> {
    const { tools, truncated } = await this.#tools();
    if (!looksLikePortal(tools, truncated)) return [];

    const servers = reconcilePortalServers(
      await this.#fetchPortalServers(), tools, truncated);
    const trust = portalTrust(this.#env);
    const grouped = groupToolsByServer(tools);

    return servers.map(upstream => {
      const owned = grouped.get(upstream.id) ?? [];
      const reads = owned.filter(
        tool => classifyTool(tool, trust).mode === "read").length;
      return {
        value: upstream.id,
        title: upstream.name,
        subtitle: truncated
          ? `Catalog truncated \u00b7 ${owned.length} shown, ${reads} shown read-only`
          : `${owned.length} tool${owned.length === 1 ? "" : "s"} \u00b7 ` +
            `${reads} read-only, ${owned.length - reads} need approval`,
        // A server can be configured but switched off for this session, making a grant onto it valid
        // but presently empty, which the person choosing should see.
        meta: upstream.enabled ? undefined : "disabled in portal",
      };
    });
  }

  // Asks the portal which upstream servers it fronts. A tool call, but the gatekeeper's own while
  // building a configuration form rather than a Gadget's, so it does not pass through the approval
  // queue. Advisory only: membership comes from tool-name prefixes, so a failure degrades to unnamed
  // groups rather than an error.
  async #fetchPortalServers(): Promise<PortalServer[]> {
    const server = await this.#account.getServer();
    return fetchPortalServers(this.#env, this.#account, server.endpoint);
  }

  // Tools the grant may cover, narrowed to one portal upstream server when `serverId` is given.
  async listToolOptions(serverId?: string): Promise<ConfiguratorUIOption[]> {
    const trust = portalTrust(this.#env);
    const { tools, truncated } = await this.#tools();
    requireCompleteCatalogForToolSelection(truncated);
    const scope: ToolScope = serverId ? { serverId } : {};
    const isPortal = looksLikePortal(tools, truncated);

    return tools
      .filter(tool => scopeAllows(scope, tool.name, isPortal))
      .map(tool => ({
        value: tool.name,
        // Within a chosen server the `{server_id}_` prefix is noise, so it is shown stripped while
        // `value` keeps the wire name the grant is actually recorded with.
        title: tool.title ?? (serverId ? tool.name.slice(serverId.length + 1) : tool.name),
        subtitle: tool.description?.split(/\r?\n/)[0],
        // Surfaced here so the person granting can see, per tool, whether calls will interrupt them.
        meta: classifyTool(tool, trust).mode === "read" ? "read-only" : "needs approval",
      }));
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper facet

// Props identifying which server (and how much of it) a gatekeeper facet governs. The trust tier is
// absent: it is deployment configuration, read from `portalTrust(this.env)` at each point of use,
// since baking it into props would pin every binding to the setting on the day it was created.
type McpGatekeeperImplProps = {
  accountObjectId: string;
  endpoint: string;
  serverId: string;
  serverName: string;
  // Optional for facets minted before catalog-backed validation persisted the upstream display name.
  scopeServerName?: string;
  // How much of the endpoint this binding may call. Empty means the whole endpoint, including tools
  // it publishes later.
  scope: ToolScope;
};

export class McpGatekeeperImpl
  extends McpFacetBase<Env, McpGatekeeperImplProps, McpSessionImpl> {

  protected get log() {
    return logger.with({
      serverId: this.ctx.props.serverId,
      serverHost: hostOf(this.ctx.props.endpoint),
      trust: portalTrust(this.env),
    });
  }

  protected account(): ConnectionAccount {
    return this.ctx.exports.McpAccount.get(
      this.ctx.exports.McpAccount.idFromString(this.ctx.props.accountObjectId));
  }

  protected get trust(): ServerTrust {
    return portalTrust(this.env);
  }

  protected get sessionClass() {
    return McpSessionImpl;
  }

  protected get observerName(): string {
    return this.#scopeLabel();
  }

  // How this binding's breadth reads to a human, for approval prompts and the bindings list.
  #scopeLabel(): string {
    const { scope, serverName, scopeServerName } = this.ctx.props;
    return `${serverName} / ${scopeServerName ?? scope.serverId}`;
  }

  async describe(): Promise<ResourceDescription> {
    const tools = await this.tools();
    const reads = tools.filter(entry => entry.mode === "read").length;
    const { scope } = this.ctx.props;
    const label = this.#scopeLabel();

    const counts = `${reads} read-only, ${tools.length - reads} requiring approval`;
    const plural = tools.length === 1 ? "" : "s";
    const snippet = scope.tools
      ? `${scope.tools.length} named MCP tool${scope.tools.length === 1 ? "" : "s"} on ` +
        `${label} \u2014 ${counts}. Other tools are refused.`
      : scope.serverId
      ? `All ${tools.length} MCP tool${plural} of the ` +
        `${this.ctx.props.scopeServerName ?? scope.serverId} server on ` +
        `${this.ctx.props.serverName} \u2014 ${counts}. Other servers on it are refused.`
      : `All ${tools.length} MCP tool${plural} on ${label} \u2014 ${counts}.`;

    return {
      url: this.resourceUrl,
      title: scope.tools?.length === 1 ? `${label}: ${scope.tools[0]}` : label,
      snippet,
      suggestedBindingName: `MCP_${bindingNameFragment(this.#bindingId())}`,
      tsType: sessionTypeName(this.#bindingId(), this.resourceUrl),
    };
  }

  // Identifies this binding's shape for naming. Server-scoped bindings get their own suggested name
  // and session type, so two bindings onto different servers of one portal do not collide and the
  // agent's type for the GitHub half of a portal is named after GitHub.
  //
  // This is a readable label, not an identity: two grants pinning different tools of one upstream
  // server produce the same id. `sessionTypeName` is what separates them, from the scoped resource
  // URL.
  #bindingId(): string {
    const { scope, serverId } = this.ctx.props;
    return scope.serverId ? `${serverId}-${scope.serverId}` : serverId;
  }

  // Namespaces persistent approval policy by both the readable binding shape and the exact portal
  // endpoint. A deployment repoint must not carry an always-approve decision to a different system
  // merely because both portals expose a tool with the same name.
  protected get actionScopeTag(): string {
    return `mcp-portal:${endpointTag(this.ctx.props.endpoint)}:${this.#bindingId()}`;
  }

  async getTypeScriptTypes(): Promise<string> {
    return generateSessionTypes({
      baseTypes: MCP_BASE_TYPES,
      serverId: this.#bindingId(),
      serverName: this.#scopeLabel(),
      endpoint: this.ctx.props.endpoint,
      discriminator: this.resourceUrl,
      trust: portalTrust(this.env),
      tools: await this.tools(),
    });
  }

  // The upstream server as the user should see it, not the portal's own name. The same label
  // `describe()` shows, so an approval prompt names the system being written to.
  get serverName(): string {
    return this.#scopeLabel();
  }
}

// ---------------------------------------------------------------------------
// Session — the capability handed to the Gadget

// Subclassed rather than used directly so `@validateRpc()` is applied in the file that hands the
// class to a Gadget, where it can be seen.
@validateRpc()
class McpSessionImpl extends McpSessionBase {}
