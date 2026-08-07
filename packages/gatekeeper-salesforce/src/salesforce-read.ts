// Agent-facing read session for the Salesforce gatekeeper. Every call is authorized as an
// observation (read-only; no actions are ever submitted to an approval queue).

import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type { ObservationAuthorizer } from "@gadgets/workshop-shared/gatekeeper";
import { embedQuery, truncateForEmbedding } from "./sf-embed.js";
import {
  getRecordById, getRecordsByIds, listObjectInfo,
  storedToSalesforceRecord, storedToSearchResults,
} from "./sf-store.js";
import type {
  SalesforceObjectInfo, SalesforceObjectType, SalesforceRecord,
  SalesforceSearchResult, SalesforceVectorMetadata,
} from "./salesforce-types.js";

const MAX_SEARCH_RESULTS = 50;

export type SalesforceSearchOptions = {
  objectType?: SalesforceObjectType;
  ownerId?: string;
  campaignId?: string;
  status?: string;
  limit?: number;
};

@validateRpc()
export class SalesforceReadSession extends RpcTarget {
  constructor(
    private env: Cloudflare.Env,
    private accountId: string,
    private authorizer: NativeRpcStub<ObservationAuthorizer>,
  ) {
    super();
  }

  // Release the authorizer owned by this read session.
  [Symbol.dispose](): void {
    this.authorizer[Symbol.dispose]?.();
  }

  async #authorize(description: { title: string; description: string }): Promise<void> {
    await this.authorizer.authorizeObservation(description);
  }

  // Vectorize metadata filter. Values are plain strings; we pass them as exact equality (the
  // implicit $eq form).
  #filter(opts: SalesforceSearchOptions): Record<string, string> | undefined {
    const filter: Record<string, string> = {};
    if (opts.objectType) filter.objectType = opts.objectType;
    if (opts.ownerId) filter.ownerId = opts.ownerId;
    if (opts.campaignId) filter.campaignId = opts.campaignId;
    if (opts.status) filter.status = opts.status;
    return Object.keys(filter).length > 0 ? filter : undefined;
  }

  /**
   * Semantic search over the indexed Salesforce records. Returns records ranked by relevance to
   * the natural-language `query`. Optionally narrows by object type, owner, campaign, or status.
   */
  async search(query: string, opts?: SalesforceSearchOptions): Promise<SalesforceSearchResult[]> {
    const limit = Math.min(opts?.limit ?? 20, MAX_SEARCH_RESULTS);

    // Embed the query with the same model used at index time.
    const queryVector = await embedQuery(this.env.AI, truncateForEmbedding(query));

    const filter = this.#filter(opts ?? {});
    const matches = await this.env.SF_INDEX.query(queryVector, {
      topK: limit,
      returnMetadata: "all",
      ...(filter ? { filter } : {}),
    });

    const ids = matches.matches.map((m) => m.id);
    if (ids.length === 0) return [];

    const stored = await getRecordsByIds(this.env.SF_DB, ids);
    const scores = new Map(
      matches.matches.map((m) => [m.id, m.score]),
    );
    const results = storedToSearchResults(
      stored.toSorted((a, b) => (scores.get(b.sf_id) ?? 0) - (scores.get(a.sf_id) ?? 0)),
      scores,
    );

    await this.#authorize({
      title: `Salesforce search: ${query}`,
      description:
        `Searched the indexed Salesforce data for \`${query}\`. ` +
        `Returned ${results.length} record(s): ${ids.join(", ")}.`,
    });

    return results;
  }

  /** Fetches the full indexed record for a Salesforce Id (15 chars). */
  async getRecord(id: string): Promise<SalesforceRecord | null> {
    const stored = await getRecordById(this.env.SF_DB, id);
    if (!stored) return null;
    await this.#authorize({
      title: `Salesforce record: ${stored.name}`,
      description: `Read Salesforce ${stored.object_type} record \`${id}\`.`,
    });
    return storedToSalesforceRecord(stored);
  }

  /** Lists the indexed object types with record counts (discovery metadata). */
  async listObjects(): Promise<SalesforceObjectInfo[]> {
    const info = await listObjectInfo(this.env.SF_DB);
    await this.#authorize({
      title: "Salesforce index listing",
      description: `Listed ${info.length} indexed Salesforce object type(s) with counts.`,
    });
    return info;
  }

  /** Requests a re-sync of one object type (or all enabled types) with Salesforce. */
  async resync(opts?: { objectType?: string }): Promise<{ started: boolean; objectType?: string }> {
    // Duplicate a no-op authorization so the action is observable without revealing Salesforce data.
    await this.#authorize({
      title: "Salesforce resync request",
      description: opts?.objectType
        ? `Requested a Salesforce resync of \`${opts.objectType}\`.`
        : "Requested a full Salesforce resync.",
    });
    const started = await this.env.SF_SYNC.create({
      params: { objectType: opts?.objectType },
    }).then(() => true).catch(() => false);
    return { started, objectType: opts?.objectType };
  }
}

export type { SalesforceVectorMetadata };
