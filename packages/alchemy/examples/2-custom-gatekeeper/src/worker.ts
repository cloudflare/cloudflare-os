/// <reference types="@cloudflare/workers-types" />
// A minimal but REAL custom gatekeeper, modeled on
// `packages/integration-tests/fixtures/gatekeeper-test`. One Worker module,
// several exports — workerd requires every named export of an entry module
// to be a class, and this layout is the gatekeeper contract:
//
//   - `GatekeeperVendor`  the ONE entrypoint consumed externally: the
//                         workshop backend binds this Worker with
//                         `entrypoint: "GatekeeperVendor"` and speaks
//                         capability-passing RPC to it.
//   - `AcmeAccount`,      WorkerEntrypoint / DurableObject classes the
//     `AcmeVerifier`,     vendor mints and hands back as capabilities —
//     `AcmeThing`         reached via `ctx.exports` loopback, never bound.
//   - `default`           the HTTP surface the router forwards at
//                         /gatekeeper/acme/* (OAuth landings, configurator
//                         iframes, logos). This vendor needs none of that.
//
// The interfaces come from `@gadgets/workshop-shared/gatekeeper` — see that
// file for the full contract documentation, and `packages/gatekeeper-github`
// for a production OAuth implementation.
import {
  DurableObject,
  RpcTarget,
  WorkerEntrypoint,
  type RpcStub,
} from "cloudflare:workers";
import type {
  AccountDescription,
  ActionKind,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { AcmeEnv } from "../alchemy.run.ts";

const VENDOR_HOST = "acme.example";

const SUPPORTED_RESOURCES: SupportedResource[] = [
  {
    urlPattern: `https://${VENDOR_HOST}/things/*`,
    title: "Acme Thing",
    description: "A thing in Acme, addressable by URL.",
  },
];

// The session API surfaced to gadgets and the coding agent. The Workshop
// parses this to build the agent's type database.
const TYPES_CODE = `
/** A session on one Acme thing. */
interface AcmeThingSession {
  /** Read the thing's current status from the Acme API. */
  getStatus(): Promise<string>;
}
`;

const AVATAR = {
  url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};

type AccountProps = { label: string };
type ThingProps = AccountProps & { resourceUrl: string };

// ---------------------------------------------------------------------------
// The vendor entrypoint — what `GATEKEEPER_ACME` at `GatekeeperVendor` calls.

export class GatekeeperVendor extends WorkerEntrypoint<AcmeEnv> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Acme",
      url: `https://${VENDOR_HOST}`,
      logo: AVATAR,
      tagline: "Acme things, mediated by the approval queue.",
      // Accounts are minted on demand — no OAuth. A credentialed vendor
      // implements connectAccount() instead: return the URL of your OAuth
      // flow, then invoke `callback.complete()` when it finishes (see
      // packages/gatekeeper-github).
      autoProvisionsAccount: true,
    };
  }

  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    const label = `acme-${crypto.randomUUID().slice(0, 8)}@${VENDOR_HOST}`;
    return this.ctx.exports.AcmeAccount({ props: { label } });
  }

  async connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
  ): Promise<{ url: string }> {
    throw new Error("Acme auto-provisions accounts; there is no connect flow.");
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// One connected account. Handed back to the Workshop as a capability; it
// binds resources by URL and mints per-resource Gatekeeper classes.

export class AcmeAccount
  extends WorkerEntrypoint<AcmeEnv, AccountProps>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return {
      displayName: this.ctx.props.label.split("@")[0],
      uniqueName: this.ctx.props.label,
      avatar: AVATAR,
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  // The owner pasted a URL; the returned DO class becomes a Gatekeeper
  // facet under that gadget's Overseer.
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<AcmeSession>>;
    resource: SupportedResource;
  }> {
    const parsed = new URL(url);
    if (parsed.host !== VENDOR_HOST || !parsed.pathname.startsWith("/things/")) {
      throw new Error(`Not an Acme resource URL: ${url}`);
    }
    return {
      class: this.ctx.exports.AcmeThing({
        props: { label: this.ctx.props.label, resourceUrl: url },
      }),
      resource: SUPPORTED_RESOURCES[0],
    };
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.AcmeVerifier({ props: this.ctx.props });
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async revoke(): Promise<void> {}

  startResourceConfigurator(
    _resourceUrlPattern: string,
  ): Promise<ResourceConfiguratorFrame> {
    throw new Error("Acme has no resource configurator; bind a URL directly.");
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("Acme has no credentials to reconnect.");
  }
}

/** Identifies which account is asking (see GatekeeperUserVerifier's docs). */
export interface AcmeVerifierApi extends GatekeeperUserVerifier {
  identify(): Promise<string>;
}

export class AcmeVerifier
  extends WorkerEntrypoint<AcmeEnv, AccountProps>
  implements AcmeVerifierApi
{
  async identify(): Promise<string> {
    return this.ctx.props.label;
  }
}

// ---------------------------------------------------------------------------
// One bound resource: a Durable Object running as a facet under the gadget's
// Overseer. Its session object is the capability gadgets actually call.

/** Matches the `AcmeThingSession` interface in {@link TYPES_CODE}. */
export class AcmeSession extends RpcTarget {
  constructor(
    private env: AcmeEnv,
    private resourceUrl: string,
  ) {
    super();
  }

  async getStatus(): Promise<string> {
    const cached = await this.env.CACHE.get(`status:${this.resourceUrl}`);
    if (cached !== null) return cached;
    const response = await fetch(`https://api.${VENDOR_HOST}/status`, {
      headers: { authorization: `Bearer ${this.env.ACME_API_TOKEN}` },
    });
    const status = await response.text();
    await this.env.CACHE.put(`status:${this.resourceUrl}`, status, {
      expirationTtl: 60,
    });
    return status;
  }
}

export class AcmeThing
  extends DurableObject<AcmeEnv, ThingProps>
  implements Gatekeeper<AcmeSession>
{
  async describe(): Promise<ResourceDescription> {
    const name = new URL(this.ctx.props.resourceUrl).pathname.split("/").pop()!;
    return {
      url: this.ctx.props.resourceUrl,
      title: `Acme Thing ${name}`,
      snippet: `The Acme thing ${name}.`,
      suggestedBindingName: "ACME_THING",
      tsType: "AcmeThingSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(_approvalQueue: RpcStub<ApprovalQueue>): Promise<AcmeSession> {
    return new AcmeSession(this.env, this.ctx.props.resourceUrl);
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    // Every account may observe; a real vendor checks the verifier here and
    // throws to refuse.
  }

  async removeObserver(_id: string): Promise<void> {}

  async applyAction(_action: number): Promise<void> {
    throw new Error("Acme submits no actions.");
  }

  async rejectAction(_action: number): Promise<void> {}

  async revertAction(_action: number): Promise<void> {
    throw new Error("Acme submits no actions.");
  }
}

// ---------------------------------------------------------------------------
// The HTTP surface the router forwards at /gatekeeper/acme/*. This vendor
// has no OAuth landing or configurator, so it only answers a health probe.

export default {
  async fetch(_request: Request, env: AcmeEnv): Promise<Response> {
    return new Response(`Acme gatekeeper at ${env.BASE_URL}`);
  },
};
