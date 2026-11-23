// The admin gatekeeper: gives the agents of a workspace this deployment's Admin API, as the
// deployment admin who connected it. An ordinary connect-flow gatekeeper, with one difference:
// what an account stores is no provider token but a capability the Workshop hands it when a
// deployment admin connects it (GatekeeperConnectOptions.adminApi, an AdminApiGrant). Every
// session opens the Admin API from that grant, and the Workshop checks and records each call
// where it lands.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  CONNECT_TIMEOUT_MS, INITIATION_NONCE_LIFETIME_MS, NONCE_BYTES, generateNonce, isLiveNonce,
  type TimedNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  INVALID_LINK_HTML, connectHandoffPageHtml, htmlResponse,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import { createLogger } from "@gadgets/observability/logger";
import { ADMIN_ACCESS_ERROR_CODES, createAdminAccessError } from "@gadgets/workshop-shared/api";
import type {
  AccountDescription,
  ActionKind,
  AdminApiGrant,
  AgentCatalog,
  ApprovalQueue,
  ConnectHandoff,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorInterface,
  GitCache,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  resourceTypeUrlPattern, stripTrailingSlashes, workerVersionTag,
} from "@gadgets/workshop-shared/gatekeeper";
import type { DeploymentConfiguratorRpc } from "./configurator/deployment-configurator-types";
import { ADMIN_SUBRESOURCE, type AdminSession, forwarderFor } from "./forward.js";
import DEPLOYMENT_CONFIGURATOR_HTML from "./generated/deployment-configurator-ui.txt";
import { ADMIN_SCHEMA, generatedDeclarations } from "./surface.js";
import TYPES_CODE from "./types.txt";

const logger = createLogger<{ vendorId: string }>({
  component: "gatekeeper.admin", vendorId: "admin",
});

type Env = Cloudflare.Env & {
  BASE_URL?: string,
};

function getBaseUrl(env: Env) {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/admin");
}

function getBasePath(env: Env) {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

const DISPLAY_NAME = "Deployment admin";

const SHIELD_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M208 40H48a16 16 0 0 0-16 16v56c0 52.72 25.52 84.67 46.93 102.19 23.06 18.86 46 25.27 47 25.53a8 8 0 0 0 4.2 0c1-.26 23.91-6.67 47-25.53C198.48 196.67 224 164.72 224 112V56a16 16 0 0 0-16-16Zm0 72c0 37.07-13.66 67.16-40.6 89.42A129.3 129.3 0 0 1 128 223.62a128.25 128.25 0 0 1-38.92-21.81C61.82 179.51 48 149.3 48 112V56h160Z'/></svg>",
    ),
};

/**
 * The one resource of an admin gatekeeper account: this deployment's Admin API. Not exported: the
 * runtime refuses to start a Worker whose entry module exports a value that is no handler.
 */
const DEPLOYMENT_URL = "admin://deployment";

const DEPLOYMENT_RESOURCE: SupportedResource = {
  id: "deployment",
  urlPattern: DEPLOYMENT_URL,
  title: DISPLAY_NAME,
  description: "This deployment's Admin API, for the agents of a workspace.",
  icon: SHIELD_ICON,
};

const SUPPORTED_RESOURCES: SupportedResource[] = [DEPLOYMENT_RESOURCE];

const ONE_RESOURCE = `The admin gatekeeper has one resource, ${DEPLOYMENT_URL}.`;
const ADMINS_ONLY = "Only a deployment admin can connect the admin gatekeeper.";
const NOT_CONNECTED = "This deployment admin account is no longer connected.";
const NO_RECONNECT = "A deployment admin account has no credentials to renew.";

/** The binding's declarations: the ones generated from the schema, then the hand-written ones. */
const TYPES = `${generatedDeclarations()}\n${TYPES_CODE}`;

// ---------------------------------------------------------------------------
// HTTP handler: the connect link. There is no provider to send the user to, so visiting the link
// completes the connection, and the page it returns hands the popup back to the Workshop.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    // Answered without the path: a connect link's holds its nonce, which must not reach a log.
    if (!url.pathname.startsWith(`${basePath}/`)) return new Response("Not Found", { status: 404 });
    const path = url.pathname.slice(basePath.length + 1).split("/");

    if (req.method === "GET" && path.length === 2 && path[0]!.length === 64 &&
        path[1]!.length === NONCE_BYTES * 2) {
      let account: DurableObjectStub<UserAccount>;
      try {
        account = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(path[0]!));
      } catch {
        return htmlResponse(INVALID_LINK_HTML);
      }
      const handoff = await account.completeConnection(path[1]!);
      return htmlResponse(handoff === null ? INVALID_LINK_HTML : connectHandoffPageHtml(handoff));
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorInterface {
  /** Describes the admin gatekeeper vendor. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: DISPLAY_NAME,
      url: "https://github.com/cloudflare/cloudflare-os/blob/main/docs/admin-access.md",
      logo: SHIELD_ICON,
      tagline: "Give a deployment admin's agents this deployment's Admin API",
      description: "For deployment admins only. Agents in a workspace you add it to use this " +
        "deployment's Admin API as you: they read what admins read (users, workspaces, " +
        "settings, the audit log and audited views of workspaces and accounts), and nothing " +
        "else. What they read is restricted: a collaborator opens such a workspace only with " +
        "an account of their own, so only as a deployment admin. Removing this account ends " +
        "every connection made with it.",
    };
  }

  /** The version tag of this Worker's running version, for the deployment's admins. */
  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  /**
   * Starts a connection for the deployment admin whose Admin API `options.adminApi` is, and
   * refuses anyone else: the Workshop hands that grant to deployment admins only. The grant is
   * stored in a new account, beside the callback, and the returned link completes the connection
   * when it is visited.
   */
  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>, options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    if (options?.adminApi === undefined) throw new Error(ADMINS_ONLY);
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, options.adminApi, nonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${nonce}` };
  }

  /**
   * Returns the one resource to a deployment admin and none to anyone else, which hides the
   * vendor from them.
   */
  async getSupportedResources(
    options?: { userId?: string; isAdmin?: boolean },
  ): Promise<SupportedResource[]> {
    return options?.isAdmin === true ? SUPPORTED_RESOURCES : [];
  }

  /** Returns the agent-facing declarations of the admin binding. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES;
  }
}

// ---------------------------------------------------------------------------
// UserAccount: one deployment admin's connection. Its credential is the AdminApiGrant the
// Workshop handed over at connect, stored as it is; nothing is cached beside it.

export class UserAccount extends DurableObject<Env> {
  /** Stores what a new connection needs until its link is visited, and no longer than an hour. */
  async setCallback(
    callback: Fetcher<GatekeeperConnectCallback>, grant: Fetcher<AdminApiGrant>, nonce: string,
  ): Promise<void> {
    const { kv } = this.ctx.storage;
    await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    kv.put("callback", callback);
    kv.put("grant", grant);
    kv.put<TimedNonce>("nonce", { value: nonce, expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS });
  }

  /**
   * Completes the connection its link started: spends the link's nonce, so the Workshop is told
   * once, and returns the handoff the link's page delivers. Null for a link that is expired, was
   * already visited, or names no account.
   */
  async completeConnection(nonce: string): Promise<ConnectHandoff | null> {
    const { kv } = this.ctx.storage;
    if (!isLiveNonce(kv.get<TimedNonce>("nonce"), nonce, Date.now())) return null;
    kv.delete("nonce");
    const callback = kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback === undefined) return null;

    const props: AccountProps = { userObjectId: this.ctx.id.toString() };
    const handoff = await callback.complete(this.ctx.exports.AdminAccount({ props }));
    // Only now is the account the Workshop's to remove: until then the alarm clears it.
    kv.put("connected", true);
    logger.info("admin account connected", { event: "account.connected" });
    return handoff;
  }

  /** The Admin API grant the Workshop handed over when this account was connected. */
  async adminApi(): Promise<Fetcher<AdminApiGrant>> {
    const grant = this.ctx.storage.kv.get<Fetcher<AdminApiGrant>>("grant");
    if (grant === undefined || !this.#connected()) throw new Error(NOT_CONNECTED);
    return grant;
  }

  /** Whether the account's connection completed and the account has not been removed since. */
  #connected(): boolean {
    return this.ctx.storage.kv.get<boolean>("connected") === true;
  }

  /**
   * Whether this account's user is a deployment admin now, which the grant asks the Workshop at
   * every call. Nothing is cached, so a demotion is noticed at the next check. Throws for an
   * account that was removed, including one removed while the Workshop was being asked.
   */
  async isAdmin(): Promise<boolean> {
    const admin = await (await this.adminApi()).isAdmin();
    // The object takes other calls while the Workshop answers, revoke() among them.
    if (!this.#connected()) throw new Error(NOT_CONNECTED);
    return admin;
  }

  /**
   * Refuses unless the account still holds its grant and its user is a deployment admin now.
   * Every forwarded call asks, a view's included, so removing the account or demoting its admin
   * ends the sessions that are already open, not only the next ones.
   */
  async requireAdmin(): Promise<void> {
    if (!(await this.isAdmin())) throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.notAdmin);
  }

  /**
   * Whether this account's user may see what the admin binding reads, for each of `ids`: whether
   * they are a deployment admin now. Throws for an account that was removed, and for any id but
   * the binding's own.
   */
  async checkSubresourceAccess(ids: string[]): Promise<boolean[]> {
    if (ids.some((id) => id !== ADMIN_SUBRESOURCE)) throw new Error("Unknown subresource ID.");
    const admin = await this.isAdmin();
    return ids.map(() => admin);
  }

  /** Clears a connection whose link was never visited. */
  async alarm(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("connected") !== true) await this.ctx.storage.deleteAll();
  }

  /** Forgets the grant, which ends every connection made with this account. */
  async revoke(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// The account, as the Workshop holds it.

type AccountProps = {
  /** The id of the account's UserAccount Durable Object. */
  userObjectId: string;
};

const accountOf = (ctx: { exports: Cloudflare.Exports; props: AccountProps }) =>
  ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(ctx.props.userObjectId));

@validateRpc()
export class AdminAccount extends WorkerEntrypoint<Env, AccountProps> implements GatekeeperUser {
  /**
   * Describes the account: no agent singleton and no management UI. Every account of a user is
   * the same identity, that user as an admin of this deployment, so the deployment's host is its
   * unique name, and the Workshop keeps one account per user rather than a duplicate per connect.
   */
  async describe(): Promise<AccountDescription> {
    return {
      displayName: DISPLAY_NAME, uniqueName: new URL(getBaseUrl(this.env)).host, avatar: SHIELD_ICON,
    };
  }

  /**
   * Returns the account's one resource, the deployment, while its user is a deployment admin.
   * A demoted admin's account stays listed, to be removed or used again once they are an admin,
   * and offers nothing meanwhile.
   */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return await accountOf(this.ctx).isAdmin() ? SUPPORTED_RESOURCES : [];
  }

  /**
   * Returns the workspace facet class for the deployment's URL, and for no other. Refused while
   * the account's user is no deployment admin: a connection that could answer nothing would
   * still be one every collaborator must verify against.
   */
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<AdminSession>>;
    resource: SupportedResource;
  }> {
    if (url !== DEPLOYMENT_URL) throw new Error(ONE_RESOURCE);
    await accountOf(this.ctx).requireAdmin();
    const props: AccountProps = { userObjectId: this.ctx.props.userObjectId };
    return {
      class: this.ctx.exports.AdminGatekeeperImpl({ props }),
      resource: DEPLOYMENT_RESOURCE,
    };
  }

  /** Returns the frame that adds the deployment: it has nothing to choose. The type is named by
   * its id, or by its exact pattern as an older Workshop names it (resourceTypeUrlPattern()). */
  async startResourceConfigurator(resourceTypeId: string): Promise<ResourceConfiguratorFrame> {
    try {
      resourceTypeUrlPattern(SUPPORTED_RESOURCES, resourceTypeId);
    } catch {
      throw new Error(ONE_RESOURCE);
    }
    return {
      iframeHtml: DEPLOYMENT_CONFIGURATOR_HTML,
      ui: new RpcStub(new DeploymentConfiguratorUI()),
    };
  }

  /** Confirms there are no resource scopes to grant. */
  async ensureResources(_resourceTypeIds: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {
    await accountOf(this.ctx).revoke();
  }

  /** Refuses: the grant does not expire, so the Workshop never asks for it to be renewed. */
  reconnect(): Promise<{ url: string }> {
    throw new Error(NO_RECONNECT);
  }

  /** Refuses, as reconnect() does. */
  commitReconnect(_stageId: string): Promise<void> {
    throw new Error(NO_RECONNECT);
  }

  /** Returns no authentication identity. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the verifier that answers for this account's user (see AdminVerifier). */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: AccountProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.AdminVerifier({ props });
  }
}

/** The configurator's capability: the deployment's URL, the one resource there is to add. */
class DeploymentConfiguratorUI extends RpcTarget implements DeploymentConfiguratorRpc {
  async resourceUrl(): Promise<string> {
    return DEPLOYMENT_URL;
  }
}

// ---------------------------------------------------------------------------
// Verifier: answers "may this observer see what the binding read?" from the OBSERVER's own
// account, so from whether its user is a deployment admin now.

/** The vendor's own method on the otherwise opaque verifier. */
export interface AdminVerifierApi extends GatekeeperUserVerifier {
  checkSubresourceAccess(ids: string[]): Promise<boolean[]>;
}

@validateRpc()
export class AdminVerifier extends WorkerEntrypoint<Env, AccountProps> implements AdminVerifierApi {
  async checkSubresourceAccess(ids: string[]): Promise<boolean[]> {
    return accountOf(this.ctx).checkSubresourceAccess(ids);
  }
}

// ---------------------------------------------------------------------------
// The workspace facet.

@validateRpc()
export class AdminGatekeeperImpl
  extends DurableObject<Env, AccountProps>
  implements Gatekeeper<AdminSession>
{
  /** Opens the Admin API from the account's grant, asked of the account at each open, so a
   * removed account's connections answer nothing. */
  readonly #openAdminApi = async () => {
    using grant = await accountOf(this.ctx).adminApi();
    return await grant.open();
  };
  /** What every forwarded call asks first (see UserAccount.requireAdmin()). */
  readonly #requireAdmin = () => accountOf(this.ctx).requireAdmin();

  /** Describes the admin binding. */
  async describe(): Promise<ResourceDescription> {
    return {
      url: DEPLOYMENT_URL,
      title: DISPLAY_NAME,
      snippet: "This deployment's Admin API, as the admin who connected it.",
      suggestedBindingName: "ADMIN",
      tsType: "AdminBinding",
    };
  }

  /** Returns the agent-facing declarations of the admin binding. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES;
  }

  /** Reports no action kinds. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  /**
   * Opens a session that forwards each Admin API read to the Admin API it opens, on first use,
   * from the account's grant.
   *
   * Skips validation: capnweb-validate builds a method's return validator from its declared
   * type, and the session's type declares none of its Admin API methods (they are defined from
   * the schema at load), so a validated return would wrap the session in a proxy refusing every
   * one of them. The session checks each call's arguments against the schema, and the Workshop
   * validates them again where the call lands. The skip also leaves `queue` unchecked, which only
   * the Workshop passes.
   */
  @skipRpcValidation()
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<AdminSession> {
    // The queue is disposed when this call returns, so the session keeps its own copy.
    return new (forwarderFor(ADMIN_SCHEMA.entry))(
        queue.dup(), this.#requireAdmin, { open: this.#openAdminApi });
  }

  /** Returns no catalog: the binding's types say everything there is to know. */
  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  // Judges each observer by the verifier this call brings, and stores nothing. If an account
  // cannot answer, the whole call fails and the Workshop denies everyone in it.
  readonly #verifyObserverAccess = observerAccessVerifier({
    hasCollectionAccess: (verifier: Fetcher<AdminVerifierApi>, ids) =>
      verifier.checkSubresourceAccess([...ids]),
  });

  /**
   * Allows the observers whose own account says its user is a deployment admin now. Every
   * observation of this binding reports ADMIN_SUBRESOURCE and nothing else.
   */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    // Refuse an ID this binding never reports rather than guessing what it names.
    if (subresources.some((id) => id !== ADMIN_SUBRESOURCE)) {
      throw new Error("This connection was asked about a resource it never reported.");
    }
    return this.#verifyObserverAccess(observers, subresources);
  }

  /** Reports no requirement recorded before observations carried their subresources. */
  async getHistoricalSubresources(): Promise<string[]> {
    return [];
  }

  /** Compatibility only: every access requirement is on the observations. */
  async addObserver(_id: string, _verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Compatibility only; there is no observer state to remove. */
  async removeObserver(_id: string): Promise<void> {}

  /** Refuses: this gatekeeper queues no action. */
  applyAction(action: number, _cache: RpcStub<GitCache>): Promise<void> {
    throw noAction(action);
  }

  /** Refuses: this gatekeeper queues no action. */
  rejectAction(action: number): Promise<void> {
    throw noAction(action);
  }

  /** Refuses: this gatekeeper queues no action. */
  revertAction(
    action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw noAction(action);
  }
}

function noAction(action: number): Error {
  return new Error(`The admin gatekeeper has no action ${action}.`);
}
