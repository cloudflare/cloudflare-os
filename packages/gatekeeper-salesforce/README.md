# Gatekeeper Salesforce

Semantic search over your Salesforce org, available to Cloudflare OS agents as an ambient
`SALESFORCE` binding — no connection or OAuth flow required.

This auto-provisioned gatekeeper mirrors read-only Salesforce data (Accounts, Contacts, Campaigns,
Opportunities, Tasks, Events, Leads, and Touchless custom objects) into Cloudflare **Vectorize** +
**D1**, embedding each record with Workers AI `@cf/qwen/qwen3-embedding-0.6b` (1024-dim). Agents
can then ask natural-language questions like "find Toyota dealers in Wisconsin with stalled demo
activity" and get semantically-ranked records back — no SOQL needed, in <500 ms.

## How it works

```
Salesforce (REST /query, JWT) ──► SalesforceSyncWorkflow (Cron + resync RPC)
                                      │
                                      ├─ chunk/embed (@cf/qwen/qwen3-embedding-0.6b)
                                      ├─ D1 records  (full JSON content, sync cursors)
                                      └─ Vectorize   (1024-dim cosine, indexed metadata)
                                               │
Agent ──► SalesforceIndex.search(query, opts) ──► Vectorize query → D1 fetch → observation
```

- **Sync**: a durable Cloudflare Workflow pulls records modified since the last
  composite `SystemModstamp|Id` cursor (see `migrations/0001_init.sql`), every 2 hours
  (configurable). It only re-embeds records whose `search_text` actually changed, skips unchanged
  content, and reconciles deletions from Salesforce **getDeleted** (recycle-bin window) on every
  incremental run — including empty deltas. Full syncs may optionally reconcile against a complete
  ID inventory; incremental deltas are never treated as a full inventory. Removals delete from
  **D1 and Vectorize together**.
- **Read path**: `search()` embeds the query, queries Vectorize (optionally filtered by
  objectType/owner/campaign/status), then hydrates the snippets from D1. Every read is authorized
  as an observation; reads never touch the approval queue.

## Agent API

The ambient binding (`SALESFORCE`, ts type `SalesforceIndex`) exposes:

```ts
interface SalesforceIndex {
  search(query: string, opts?: {
    objectType?: string; // "Account" | "Contact" | "Campaign" | ...
    ownerId?: string;    // filter to a Salesforce user Id
    campaignId?: string;
    status?: string;
    limit?: number;      // default 20, max 50
  }): Promise<SalesforceSearchResult[]>;

  getRecord(id: string): Promise<SalesforceRecord | null>;
  listObjects(): Promise<SalesforceObjectInfo[]>;
  resync(opts?: { objectType?: string }): Promise<{ started: boolean; objectType?: string }>;
}
```

See `src/salesforce-gatekeeper.ts` (`SALESFORCE_TYPES`) for the exact agent-facing declarations.

## Configuration

### 1. Salesforce connected app (JWT)

Reuse (or create) an External Client App in your Salesforce org for the JWT bearer flow:

1. In Salesforce Setup, create an External Client App.
2. Enable OAuth, add the JWT bearer flow, and register the integration user.
3. Upload the **certificate** whose private key you'll configure as the Worker secret.
4. Allowlist the integration user (e.g. `remi@touchless.io`) on the app.

### 2. Worker secrets

Set these on the deployed `gatekeeper-salesforce` Worker (in the starter, also via
`packages/gatekeeper-salesforce/deploy-inputs.json`):

| Secret               | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| `SF_CLIENT_ID`       | The External Client App consumer key                               |
| `SF_USERNAME`        | The integration user, e.g. `remi@touchless.io`                     |
| `SF_PRIVATE_KEY`     | The RSA **PKCS#8** PEM private key (always stored in the vault)    |
| `SF_LOGIN_URL` (opt) | Defaults to `https://login.salesforce.com`; use `https://test.salesforce.com` for a sandbox |

### 3. Cloudflare resources

```sh
# Vectorize index (1024 dims to match the embedding model)
npx wrangler vectorize create salesforce-index --dimensions=1024 --metric=cosine

# Enable metadata filtering on the fields used by search() options
npx wrangler vectorize create-metadata-index salesforce-index --property-name='objectType' --type='string'
npx wrangler vectorize create-metadata-index salesforce-index --property-name='ownerId'   --type='string'
npx wrangler vectorize create-metadata-index salesforce-index --property-name='campaignId'--type='string'
npx wrangler vectorize create-metadata-index salesforce-index --property-name='status'    --type='string'

# D1 database + schema
npx wrangler d1 create salesforce-vector-store
npx wrangler d1 migrations apply salesforce-vector-store --remote
```

Then point `wrangler.jsonc` `d1_databases[0].database_id` and `vectorize[0].index_name` at the
created resources (the committed file uses `$D1_SF_DB_ID` / `$VECTORIZE_SF_INDEX_NAME`
placeholders that the release manifest / deploy service resolves).

### 4. Deploy + first sync

```sh
cd packages/gatekeeper-salesforce
npx wrangler deploy      # (secrets must be set first)
npx wrangler workflows trigger sf-sync '{}'   # full initial load
```

The initial sync of ~100K records costs roughly **$0.30** in Workers AI embedding (the whole org
fits in a single Vectorize index well below the 20M-vector limit) and completes in ~30–60 minutes
thanks to Workflows' durable steps.

## Object coverage

The default registry lives in `src/sf-objects.ts` (`OBJECT_TYPE_CONFIGS`). It covers:

Account, Contact, Campaign, CampaignMember, CampaignMemberStatus, Opportunity, Task, Event, Lead,
`Campaign_Account__c`, `Cadence_Step_Snapshot__c`, `Outreach_Scorecard_Entry__c`.

To add an object, insert an `object_config` row (SOQL fields + embedding fields) or extend the
registry and re-run the seed step — no code change is needed for standard dosing.

## Development

```sh
pnpm --filter @gadgets/gatekeeper-salesforce... install
pnpm --filter @gadgets/gatekeeper-salesforce test    # unit + D1 integration tests
pnpm --filter @gadgets/gatekeeper-salesforce build   # typecheck
```

The dev server (`pnpm dev-server`) auto-discovers the gatekeeper and binds `GATEKEEPER_SALESFORCE`.
For local dev, `wrangler.jsonc` uses `preview_database_id: "salesforce-vector-store"` and the same
index name, so `wrangler dev` works against local D1 + Vectorize once you create them.

## Security notes

- Read-only: no Salesforce writes, no approval-queue actions. All reads are observations.
- PII is kept inside Cloudflare (D1 + Vectorize) exactly as indexed; the sync never logs record
  bodies or the private key. Secrets live only in Worker secrets / the vault.
- Metadata index values are capped at 64 bytes to stay within Vectorize limits.

## Releasing

Adding this package touched the release manifest:

- `scripts/release/manifest-lib.mjs` now understands `d1_databases`, `vectorize`, `ai`, and
  `workflows` config keys, emitting `$D1_<BINDING>_ID`, `$VECTORIZE_<BINDING>_NAME`, `ai`, and
  `workflow` binding templates. `gatekeeper-salesforce` is in `NO_DEFAULT_CRED_INPUTS` (it takes
  `SF_*` secrets via `deploy-inputs.json`).
- `scripts/testdata/golden-manifest.json` was regenerated with the new package entry.
