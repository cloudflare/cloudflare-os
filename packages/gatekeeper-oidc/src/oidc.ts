import { WorkerEntrypoint, DurableObject, RpcStub } from "cloudflare:workers";
import {
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorIface,
  GatekeeperConnectCallback,
  AccountDescription,
  SupportedResource,
  ResourceConfiguratorFrame,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";

// TODO(lead): implement — jose will be used here for JWKS verification of ID tokens.

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_SCOPES?: string;
};

// ---------------------------------------------------------------------------
// HTTP handler — serves the browser-based OIDC auth flow.

export default {
  async fetch(_req: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    // TODO(lead): implement
    throw new Error("not implemented");
  },
};

// ---------------------------------------------------------------------------
// Vendor — top-level API exposed to the Workshop

export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async connectAccount(
      _callback: Fetcher<GatekeeperConnectCallback>,
      _options?: { resourceUrlPatterns?: string[] }): Promise<{ url: string }> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async getTypeScriptTypes(): Promise<string> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — stores per-user credentials (tokens, etc.).

export class UserAccount extends DurableObject<Env> {
  async setCallback(
      _callback: Fetcher<GatekeeperConnectCallback>,
      _nonce: string,
      _requestedResourceUrlPatterns: string[]): Promise<void> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async verifyNonce(_nonce: string): Promise<boolean> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async completeConnection(): Promise<void> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async getAccessToken(): Promise<string> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async alarm(): Promise<void> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async revoke(): Promise<void> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }
}

// ---------------------------------------------------------------------------
// UserImpl — maps resource URLs to gatekeeper DO classes

type OidcUserImplProps = {
  userObjectId: string;
};

export class OidcUserImpl extends WorkerEntrypoint<Env, OidcUserImplProps>
    implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async getGatekeeperClassFor(_url: string): Promise<{
    class: DurableObjectClass<any>;
    resource: SupportedResource;
  }> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async revoke(): Promise<void> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async reconnect(): Promise<{ url: string }> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // TODO(lead): implement — must return a provider-verified email only (see GatekeeperUser
    // JSDoc); the Workshop keys accounts by this, so an unverified address is an account-takeover
    // risk.
    throw new Error("not implemented");
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    // TODO(lead): implement
    throw new Error("not implemented");
  }
}

// ---------------------------------------------------------------------------
// Verifier — answers "can this observer access X?" against the observer's own credentials.

type OidcVerifierProps = {
  userObjectId: string;
};

export class OidcVerifier extends WorkerEntrypoint<Env, OidcVerifierProps>
    implements GatekeeperUserVerifier {
  async verify(): Promise<void> {
    // TODO(lead): implement — low-stakes sign-in-only verifier, no resource ACL to check yet.
  }
}
