// Value types for the Salesforce gatekeeper. The agent-read path and the sync pipeline share these
// shapes; keep them in sync with SALESFORCE_TYPES in salesforce-gatekeeper.ts.

// Salesforce API name of an object (e.g. "Account", "Contact", "Task").
export type SalesforceObjectType = string;

// A search result returned by search().
export type SalesforceSearchResult = {
  // Salesforce record Id (15 chars), accepted by getRecord().
  id: string;
  // Salesforce object API name, e.g. "Account".
  objectType: SalesforceObjectType;
  // Record name for display.
  title: string;
  // Short serialized snippet for the agent to scan.
  snippet?: string;
  // Relevance score (higher is better).
  score?: number;
  // Indexed metadata (the same fields used for filtering).
  attributes?: Record<string, string>;
};

// Full record content returned by getRecord().
export type SalesforceRecord = {
  id: string;
  objectType: SalesforceObjectType;
  title: string;
  // The flattened search text the vector was embedded from.
  content: string;
  // The full serialized record value (fields).
  fields: Record<string, unknown>;
  // The SystemModstamp reported by Salesforce at sync time.
  systemModstamp?: string;
};

// Discovery metadata about one indexed object type.
export type SalesforceObjectInfo = {
  objectType: SalesforceObjectType;
  title: string;
  description?: string;
  documentCount: number;
  lastSynced?: string;
};

// The Vectorize metadata attached to every vector. These are the only filterable properties, so
// keep their values short (<=64 bytes each; only 10 metadata indexes may exist per Vectorize index).
export type SalesforceVectorMetadata = {
  objectType: string;
  recordName: string;
  ownerId?: string;
  campaignId?: string;
  status?: string;
};

// A JSON value from the Salesforce REST API. Using a closed JSON union keeps SfRecord serializable
// for Cloudflare Workflows step outputs (Record<string, unknown> is rejected).
export type SfJson =
  | string
  | number
  | boolean
  | null
  | SfJson[]
  | { [key: string]: SfJson };

// A Salesforce record as returned by the REST /query endpoint.
export type SfRecord = { Id: string; [key: string]: SfJson | undefined } & {
  SystemModstamp?: string;
};

export const VENDOR_ID = "salesforce";

// The Salesforce Id is exactly 15 alphanumeric characters (case-sensitive). We store the 15-char
// Id (not the 18-char suffix form) so vector IDs stay short and stable.
export function isSfId(value: string): boolean {
  return /^[a-zA-Z0-9]{15}$/.test(value);
}

/** Truncate a standard 18-char Salesforce Id to the case-sensitive 15-char form used as our key. */
export function toSfId15(id: string): string {
  return id.length === 18 ? id.slice(0, 15) : id;
}
