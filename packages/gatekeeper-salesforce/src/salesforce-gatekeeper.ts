// Salesforce gatekeeper. Auto-provisions one account per user; each account provides a read-only
// agent singleton (SalesforceIndex) backed by the indexed Salesforce mirror in D1 + Vectorize.
// All reads are authorized as observations; no actions are ever submitted.

import { DurableObject, RpcStub as NativeRpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { boundAgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  AgentCatalogRequest,
  AppUiContext,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUiFrame,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ObservationAuthorizer,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { SalesforceReadSession } from "./salesforce-read.js";

// The Salesforce "cloud" glyph as a self-contained SVG data URI (no external asset), matching
// AvatarImage's { url } shape.
const SALESFORCE_ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" +
    "<path d='M20 12V8a4 4 0 0 0-8 0v4'/><path d='M20 12a4 4 0 0 1-8 0v4a4 4 0 0 1 8 0Z'/>" +
    "</svg>"),
};

// Agent-facing API returned by getTypeScriptTypes(). Keep in sync with salesforce-types.ts.
const SALESFORCE_TYPES = `
/**
 * Semantic search over the indexed Salesforce mirror. Every call is authorized as a read
 * observation. \`search()\` embeds the query and returns the most similar Salesforce
 * records across Account, Contact, Campaign, Opportunity, Task, Event, Lead, and custom objects.
 */
interface SalesforceIndex {
  /**
   * Ranked semantic search across indexed Salesforce records. Optionally narrow by object type,
   * owner, campaign, or status (metadata filters, applied before retrieval).
   */
  search(query: string, opts?: {
    /** Salesforce object API name, e.g. "Account", "Contact", "Opportunity", "Task". */
    objectType?: string;
    /** Filter to records owned by this Salesforce user Id (15 chars). */
    ownerId?: string;
    /** Filter to records in this campaign (15-char Campaign/record Id). */
    campaignId?: string;
    /** Filter to records with this status/label (e.g. StageName, Status, Disposition). */
    status?: string;
    /** Max results (default 20, capped at 50). */
    limit?: number;
  }): Promise<SalesforceSearchResult[]>;

  /** Returns the full indexed record for a 15-char Salesforce Id. */
  getRecord(id: string): Promise<SalesforceRecord | null>;

  /** Lists the indexed object types with record counts, to discover what is searchable. */
  listObjects(): Promise<SalesforceObjectInfo[]>;

  /** Requests a re-sync of one object type (or all) with Salesforce. */
  resync(opts?: { objectType?: string }): Promise<{ started: boolean; objectTypes?: number }>;
}

/** A ranked Salesforce search hit. */
interface SalesforceSearchResult {
  /** 15-char Salesforce record Id — pass to getRecord(). */
  id: string;
  /** Salesforce object API name, e.g. "Account". */
  objectType: string;
  /** Record display name. */
  title: string;
  /** Short excerpt of the serialized record. */
  snippet?: string;
  /** Relevance score (higher is better). */
  score?: number;
  /** Indexed metadata used for filtering. */
  attributes?: Record<string, string>;
}

/** Full indexed Salesforce record. */
interface SalesforceRecord {
  id: string;
  objectType: string;
  title: string;
  /** The serialized search text the record was embedded from. */
  content: string;
  /** The record's fields (the raw Salesforce value). */
  fields: Record<string, unknown>;
  systemModstamp?: string;
}

/** Discovery metadata over the indexed object types. */
interface SalesforceObjectInfo {
  objectType: string;
  title: string;
  description?: string;
  documentCount: number;
  lastSynced?: string;
}
`;

type SalesforceAccountProps = {
  accountId: string;
};

@validateRpc()
export class SalesforceAccount
  extends WorkerEntrypoint<Cloudflare.Env, SalesforceAccountProps>
  implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Salesforce",
      avatar: SALESFORCE_ICON,
      singleton: { tsType: "SalesforceIndex" },
    };
  }

  // Return the agent-facing read-path gatekeeper class, scoped by this account's props.
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<SalesforceReadSession>>> {
    return this.ctx.exports.SalesforceGatekeeper({ props: this.ctx.props });
  }

  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    throw new Error("The Salesforce gatekeeper has no management app; search through the agent.");
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }
  getGatekeeperClassFor(_url: string): never {
    throw new Error("The Salesforce gatekeeper has no URL-addressed resources.");
  }
  startResourceConfigurator(_resourceUrlPattern: string): never {
    throw new Error("The Salesforce gatekeeper has no URL-addressed resources.");
  }
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
  async revoke(): Promise<void> {
    // Nothing per-account is stored; the mirror is shared across accounts.
  }
  reconnect(): never {
    throw new Error("The Salesforce gatekeeper is auto-provisioned; it has no connect flow.");
  }
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.SalesforceVerifier({ props: this.ctx.props });
  }
}

@validateRpc()
export class SalesforceVerifier
  extends WorkerEntrypoint<Cloudflare.Env, SalesforceAccountProps>
  implements GatekeeperUserVerifier {
  verify(): void {}
}

// Gadget-side read path. Read-only: no actions are ever submitted.
@validateRpc()
export class SalesforceGatekeeper
  extends DurableObject<Cloudflare.Env, SalesforceAccountProps>
  implements Gatekeeper<SalesforceReadSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "salesforce://index",
      title: "Salesforce",
      snippet: "Search and read your indexed Salesforce records.",
      suggestedBindingName: "SALESFORCE",
      tsType: "SalesforceIndex",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return SALESFORCE_TYPES;
  }

  #newReadSession(authorizer: NativeRpcStub<ObservationAuthorizer>): SalesforceReadSession {
    // The read session uses this authorizer after startSession() returns, so it owns a duplicate.
    let ownedAuthorizer = authorizer.dup();
    try {
      return new SalesforceReadSession(this.env, this.ctx.props.accountId, ownedAuthorizer);
    } catch (err) {
      ownedAuthorizer[Symbol.dispose]?.();
      throw err;
    }
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<SalesforceReadSession> {
    return this.#newReadSession(approvalQueue);
  }

  async getAgentCatalog(
    request: AgentCatalogRequest,
    authorizer: NativeRpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog> {
    // Catalog = the object types the mirror currently indexes.
    // Reuse the read path's D1 access via the read session would double-authorize; instead build a
    // lightweight catalog directly from D1 (the same listObjects() data) and authorize one catalog
    // observation.
    const { listObjectInfo } = await import("./sf-store.js");
    const info = await listObjectInfo(this.env.SF_DB);
    const entries = info.map((i) => ({
      id: i.objectType,
      title: i.title,
      description: i.description ?? `${i.documentCount} record(s) indexed.`,
    }));
    if (entries.length > 0) {
      await authorizer.authorizeObservation({
        title: "Salesforce catalog",
        description: `Listed ${entries.length} indexed Salesforce object type(s).`,
      });
    }
    return boundAgentCatalog(entries, request);
  }

  // Read-only gatekeeper: no side-effecting actions, so nothing is ever auto-approvable.
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}

  applyAction(_action: number): Promise<void> {
    throw new Error("The Salesforce gatekeeper is read-only and implements no actions.");
  }
  rejectAction(_action: number): Promise<void> {
    throw new Error("The Salesforce gatekeeper is read-only and implements no actions.");
  }
  revertAction(_action: number):
    Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("The Salesforce gatekeeper is read-only and implements no actions.");
  }
}

// Vendor entrypoint. Auto-provisions one Salesforce account per user.
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Salesforce",
      url: "https://www.salesforce.com/",
      logo: SALESFORCE_ICON,
      tagline: "Search your Salesforce records",
      description:
        "Indexes your Salesforce org (Account, Contact, Campaign, Opportunity, Task, Event, Lead, " +
        "and custom objects) into a semantic search index on Cloudflare. Always available — no " +
        "connection needed.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  // Mint a fresh account capability with no user identity.
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.SalesforceAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("The Salesforce gatekeeper is auto-provisioned; it has no connect flow.");
  }
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }
  async getTypeScriptTypes(): Promise<string> {
    return SALESFORCE_TYPES;
  }
}
