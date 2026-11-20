// The Acme Service gatekeeper's main module: the HTTP entrypoint, the vendor and per-account
// entrypoints, and the observer verifier. The account Durable Object and its connect flow live in
// acme-account.ts, and the per-binding gatekeeper Durable Object and its sessions in
// acme-gatekeeper.ts and acme-session.ts, re-exported here so wrangler finds every class on the
// main module.

import { RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorIface,
  ResourceConfiguratorFrame,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { resourceTypeUrlPattern, workerVersionTag } from "@gadgets/workshop-shared/gatekeeper";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { handleConnect } from "./acme-account";
import { AcmeConfiguratorUI } from "./acme-configurator";
import { accountStub, type AcmeVerifierApi } from "./acme-credentials";
import { WEB_ORIGIN, getBasePath, getBaseUrl, type Env } from "./acme-env";
// #if hooks
import { handleWebhook } from "./acme-hooks";
// #endif
import { ALL_RESOURCES, ITEM_RESOURCE, type AcmeGatekeeperImplProps } from "./acme-resources";
import { parseResourceUrl } from "./acme-urls";
import ACME_LOGO_SVG from "./acme-logo.svg";
import TYPES_CODE from "./types.txt";
import CONFIGURATOR_HTML from "./generated/acme-configurator-ui.txt";

export { UserAccount } from "./acme-account";
export { AcmeGatekeeperImpl } from "./acme-gatekeeper";
// #if hooks
export { AcmeHookController, AcmeHookDriver } from "./acme-hooks";
// #endif
export { AcmeItemImpl } from "./acme-session";

const LOGO_URL = `data:image/svg+xml,${encodeURIComponent(ACME_LOGO_SVG)}`;

/** The `UserAccount` an entrypoint's props name. */
function accountOf(ctx: ExecutionContext<{ userObjectId: string }>) {
  return accountStub(ctx.exports, ctx.props.userObjectId);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    const relPath = url.pathname.slice(basePath.length);
    // #if hooks
    if (relPath === "/webhook" && req.method === "POST") return await handleWebhook(req, env, ctx.exports);
    // #endif
    return await handleConnect(req, env, ctx, relPath) ?? new Response("Not Found", { status: 404 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    // STOP(vendor-description): What the connect card shows. Replace acme-logo.svg too.
    return {
      displayName: "Acme Service",
      url: WEB_ORIGIN,
      logo: { url: LOGO_URL },
      color: "#f0f4ff",
      tagline: "Read and rename items",
      description: "Connect your Acme Service account so Cloudflare OS can read items, and rename them once you approve.",
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    // Every resource type needs the same access, so `options` narrows nothing.
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return ALL_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

type GatekeeperUserImplProps = { userObjectId: string };

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    const identity = await accountOf(this.ctx).getIdentity();
    return {
      displayName: identity.name,
      ...(identity.email ? { uniqueName: identity.email } : {}),
      avatar: { url: identity.avatarUrl ?? "" },
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return ALL_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const parsed = parseResourceUrl(url);
    if (!parsed) {
      throw new Error(`Not an Acme Service link this gatekeeper can bind: expected ${WEB_ORIGIN}/items/<id>.`);
    }
    const props: AcmeGatekeeperImplProps = { userObjectId: this.ctx.props.userObjectId, itemId: parsed.itemId };
    return { class: this.ctx.exports.AcmeGatekeeperImpl({ props }), resource: ITEM_RESOURCE };
  }

  async startResourceConfigurator(resourceTypeId: string): Promise<ResourceConfiguratorFrame> {
    // Throws for a type this gatekeeper doesn't have.
    resourceTypeUrlPattern(ALL_RESOURCES, resourceTypeId);
    return { iframeHtml: CONFIGURATOR_HTML, ui: new RpcStub(new AcmeConfiguratorUI()) };
  }

  async revoke(): Promise<void> {
    await accountOf(this.ctx).revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await accountOf(this.ctx).prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await accountOf(this.ctx).commitReconnect(stageId);
  }

  async ensureResources(_resourceTypeIds: string[]): Promise<{ url?: string }> {
    // A connection already covers every resource type.
    return {};
  }

  /** Mints a verifier for this account; see `AcmeGatekeeperImpl.verifyObserverAccess`. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.AcmeVerifier({ props: { userObjectId: this.ctx.props.userObjectId } });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// Every read reports the objects whose visibility governs it; an observer may see it only if
// their own connection can read each one (see UserAccount.checkSubresourceAccess).

@validateRpc()
export class AcmeVerifier extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements AcmeVerifierApi {
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    return await accountOf(this.ctx).checkSubresourceAccess(subresources);
  }
}
