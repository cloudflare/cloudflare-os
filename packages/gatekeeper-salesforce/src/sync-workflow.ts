// Salesforce sync Workflow. Runs the incremental pull from Salesforce into D1 + Vectorize with
// durable, retryable steps so bulk ingestion (~100K records) survives interruptions.
//
// Triggered by the gatekeeper's cron schedule (wrangler.jsonc workflows.schedules) or on demand via
// the resync() RPC with { objectType } to re-pull a single object.
//
// Step-boundary values must satisfy Workflows' Serializable constraint, so raw Salesforce records
// cross boundaries as JSON strings and are re-parsed inside each step.
//
// Deletion policy:
// - Incremental (cursor present): delete only IDs returned by Salesforce getDeleted for the window
//   since the last cursor — even when the modified-record delta is empty.
// - Full sync (no cursor) with a complete ID inventory: optional reconcile of D1 rows absent from
//   that inventory. Never treat an incremental delta as a full inventory.

import { WorkflowEntrypoint, WorkflowStep, type WorkflowEvent } from "cloudflare:workers";
import type { SalesforceVectorMetadata, SfRecord } from "./salesforce-types.js";
import { toSfId15 } from "./salesforce-types.js";
import {
  cursorFromRecords,
  formatSyncCursor,
  parseSyncCursor,
  SalesforceClient,
  type SalesforceAuthConfig,
  type SyncCursor,
} from "./sf-api.js";
import { embedBatch, truncateForEmbedding } from "./sf-embed.js";
import {
  extractMetadata, fieldList, serializeRecord, type ObjectTypeConfig,
} from "./sf-objects.js";
import {
  deleteRecordsByIds, ensureObjectConfig, findMissingRecordIds, getCursor, getExistingHashes,
  loadObjectConfigs, setCursor, upsertRecords,
} from "./sf-store.js";
import { obsContext } from "./observability.js";

export type SalesforceSyncParams = {
  // When set, sync only this object type (used by resync()); otherwise sync all enabled types.
  objectType?: string;
};

export type SalesforceSyncResult = {
  objectTypes: number;
  syncedRecords: number;
  embeddedVectors: number;
  skippedUnchanged: number;
  deletedVectors: number;
  errors: { objectType: string; message: string }[];
};

const logger = obsContext.createLogger({
  component: "gatekeeper.salesforce", vendorId: "salesforce",
});

// Number of records per Workers AI embedding batch.
const EMBED_BATCH = 50;
// Number of vectors per Vectorize upsert batch (vectorize limit is 1000).
const VECTORIZE_BATCH = 1000;

function authConfig(env: Cloudflare.Env): SalesforceAuthConfig {
  const clientId = env.SF_CLIENT_ID;
  const username = env.SF_USERNAME;
  const privateKeyPem = env.SF_PRIVATE_KEY;
  const loginUrl = env.SF_LOGIN_URL;
  if (!clientId || !username || !privateKeyPem) {
    throw new Error(
      "Salesforce sync is not configured: set SF_CLIENT_ID, SF_USERNAME, SF_PRIVATE_KEY (and " +
      "optionally SF_LOGIN_URL, defaulting to https://login.salesforce.com) worker secrets.",
    );
  }
  return { clientId, username, privateKeyPem, loginUrl: loginUrl ?? undefined };
}

// A serialized record ready to persist, crossing step boundaries as primitives only.
type SerializedRow = {
  id: string;
  name: string;
  searchText: string;
  contentHash: string;
  systemModstamp: string;
  // The raw Salesforce record as JSON (re-parsed inside the step that needs full fields).
  json: string;
  needsEmbed: boolean;
};

// A fetched Salesforce record crossing the fetch step boundary as a JSON string (keeps step values
// serializable without deep recursive types).
type FetchedRow = { id: string; json: string };

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseRecords(fetched: FetchedRow[]): SfRecord[] {
  return fetched.map((f) => JSON.parse(f.json) as SfRecord);
}

/** Remove IDs from D1 and Vectorize together. */
async function purgeIds(env: Cloudflare.Env, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const normalized = [...new Set(ids.map(toSfId15))];
  await deleteRecordsByIds(env.SF_DB, normalized);
  await env.SF_INDEX.deleteByIds(normalized);
  return normalized.length;
}

// Sync one object type. Returns count of embedded (changed) vectors and skipped rows.
async function syncObjectType(
  env: Cloudflare.Env,
  step: WorkflowStep,
  config: ObjectTypeConfig,
): Promise<{ embedded: number; skipped: number; deleted: number }> {
  const objectType = config.objectType;
  const start = Date.now();
  const client = new SalesforceClient(authConfig(env));

  const cursorRaw = await step.do(`read-cursor:${objectType}`, async () => {
    return (await getCursor(env.SF_DB, objectType)) ?? null;
  });
  const cursor: SyncCursor | null = parseSyncCursor(cursorRaw);
  const isIncremental = cursor !== null;

  // Fetch records modified since the cursor (or everything on first load). Records cross the step
  // boundary as JSON strings so the step result stays trivially serializable.
  const soqlFields = fieldList(config);
  const fetched = await step.do(
    `fetch:${objectType}`,
    { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
      timeout: "10 minutes" },
    async () => {
      const { records, truncated } = await client.queryModified(objectType, soqlFields, cursor);
      return {
        rows: records.map((r): FetchedRow => ({ id: r.Id, json: JSON.stringify(r) })),
        truncated,
      };
    },
  );
  const records = parseRecords(fetched.rows);
  const truncated = fetched.truncated;

  // Reconcile deletions.
  // Incremental: always call getDeleted for [cursor, now], even when the delta is empty.
  // Full sync: only when we have a complete ID inventory (not truncated).
  let deleted = 0;
  try {
    deleted = await step.do(
      `reconcile-deletions:${objectType}`,
      { retries: { limit: 3, delay: "10 seconds" } },
      async () => {
        if (isIncremental && cursor) {
          const deletedRows = await client.getDeleted(
            objectType,
            cursor.modstamp,
            new Date().toISOString(),
          );
          const ids = [...new Set(deletedRows.map((r) => r.id))];
          return purgeIds(env, ids);
        }

        if (!isIncremental && !truncated && records.length > 0) {
          const absentIds = await findMissingRecordIds(
            env.SF_DB,
            objectType,
            records.map((r) => r.Id),
          );
          return purgeIds(env, absentIds);
        }

        if (!isIncremental && truncated) {
          logger.warn("skipping full-inventory deletion reconcile; fetch truncated", {
            event: "sync.reconcile.skipped", objectType, recordCount: records.length,
          });
        }
        return 0;
      },
    );
  } catch (err) {
    logger.warn("deletion reconciliation failed", {
      event: "sync.reconcile.failed", objectType, error: err,
    });
  }

  let embedded = 0;
  let skipped = 0;

  if (records.length > 0) {
    // Serialize every record into its embedding text + content hash (all primitive fields).
    const rows = await step.do(`serialize:${objectType}`, async () => {
      const existing = await getExistingHashes(env.SF_DB, records.map((r) => r.Id));
      const out: SerializedRow[] = [];
      for (const record of records) {
        const { name, searchText } = serializeRecord(record, config);
        const contentHash = await sha256Hex(searchText);
        const systemModstamp = String(record.SystemModstamp ?? "");
        const stored = existing.get(toSfId15(record.Id));
        // Embed only when the search text actually changed (or the record is new).
        const needsEmbed = !stored || stored.contentHash !== contentHash;
        out.push({
          id: toSfId15(record.Id), name, searchText, contentHash, systemModstamp,
          json: JSON.stringify(record), needsEmbed,
        });
      }
      return out;
    });

    // Embed the changed subset in batches, persisting D1 + Vectorize per batch.
    const changed = rows.filter((r) => r.needsEmbed);
    skipped = rows.length - changed.length;
    for (let i = 0; i < changed.length; i += EMBED_BATCH) {
      const slice = changed.slice(i, i + EMBED_BATCH);
      await step.do(
        `embed-store:${objectType}:${i / EMBED_BATCH}`,
        { retries: { limit: 4, delay: "10 seconds", backoff: "exponential" },
          timeout: "5 minutes" },
        async () => {
          const vectorsOut = await embedBatch(
            env.AI,
            slice.map((s) => ({ text: truncateForEmbedding(s.searchText) })),
          );
          const vectors: { id: string; values: number[]; metadata: SalesforceVectorMetadata }[] =
            slice.map((s, idx) => ({
              id: s.id,
              values: Array.from(vectorsOut[idx]),
              metadata: extractMetadata(JSON.parse(s.json) as SfRecord, config, s.name),
            }));
          await storeRows(env, objectType, slice, config, vectors);
        },
      );
      embedded += slice.length;
    }

    // Persist unchanged records' D1 rows so their content stays current even when the embedding
    // didn't change (e.g. a field outside embedFields was updated). Vectorize is untouched.
    const unchanged = rows.filter((r) => !r.needsEmbed);
    if (unchanged.length > 0) {
      await step.do(`refresh-d1:${objectType}`, async () => {
        await upsertRecords(
          env.SF_DB,
          unchanged.map((s) => {
            const record = JSON.parse(s.json) as SfRecord;
            return {
              record,
              objectType,
              name: s.name,
              searchText: s.searchText,
              contentHash: s.contentHash,
              content: s.json,
              attributes: extractMetadata(record, config, s.name),
            };
          }),
        );
      });
    }
  }

  // Advance the composite cursor past the last ordered record (modstamp + Id tie-break).
  // On incremental empty deltas, still bump last_synced via setCursor with the prior cursor so
  // ops can see freshness — but keep the same exclusive lower bound (modstamp|id).
  const nextCursor = cursorFromRecords(records, cursor);
  if (nextCursor) {
    await step.do(`cursor:${objectType}`, async () => {
      await setCursor(
        env.SF_DB,
        objectType,
        formatSyncCursor(nextCursor.modstamp, nextCursor.id),
        records.length,
      );
    });
  }

  const durationMs = Date.now() - start;
  logger.info("object type synced", {
    event: "sync.object.complete", objectType, recordCount: records.length, durationMs,
  });
  return { embedded, skipped, deleted };
}

// Store a batch: D1 rows (full JSON) + Vectorize vectors (with full metadata).
async function storeRows(
  env: Cloudflare.Env,
  objectType: string,
  slice: SerializedRow[],
  config: ObjectTypeConfig,
  vectors: { id: string; values: number[]; metadata: SalesforceVectorMetadata }[],
): Promise<void> {
  const rows = slice.map((s) => {
    const record = JSON.parse(s.json) as SfRecord;
    return {
      record,
      objectType,
      name: s.name,
      searchText: s.searchText,
      contentHash: s.contentHash,
      content: s.json,
      attributes: extractMetadata(record, config, s.name),
    };
  });
  await upsertRecords(env.SF_DB, rows);
  const withMetadata = vectors.map((v, idx) => ({
    ...v,
    metadata: rows[idx].attributes,
  }));
  for (let v = 0; v < withMetadata.length; v += VECTORIZE_BATCH) {
    await env.SF_INDEX.upsert(withMetadata.slice(v, v + VECTORIZE_BATCH));
  }
}

export class SalesforceSyncWorkflow extends WorkflowEntrypoint<Cloudflare.Env, SalesforceSyncParams> {
  async run(event: WorkflowEvent<SalesforceSyncParams>, step: WorkflowStep): Promise<SalesforceSyncResult> {
    const start = Date.now();
    const paramObjectType = event.payload.objectType;

    // Seed object_config from the built-in registry on first run.
    await step.do("seed-object-config", async () => {
      await ensureObjectConfig(this.env.SF_DB, (await import("./sf-objects.js")).OBJECT_TYPE_CONFIGS);
    });

    const configs = await step.do("load-configs", async () => loadObjectConfigs(this.env.SF_DB));

    if (paramObjectType && !configs.some((c) => c.objectType === paramObjectType)) {
      throw new Error(`Unknown objectType for resync: ${paramObjectType}`);
    }

    const targets = paramObjectType
      ? configs.filter((c) => c.objectType === paramObjectType)
      : configs;

    let syncedRecords = 0;
    let embeddedVectors = 0;
    let skippedUnchanged = 0;
    let deletedVectors = 0;
    const errors: { objectType: string; message: string }[] = [];

    for (const config of targets) {
      try {
        const result = await syncObjectType(this.env, step, config);
        embeddedVectors += result.embedded;
        skippedUnchanged += result.skipped;
        deletedVectors += result.deleted;
        syncedRecords += result.embedded + result.skipped;
      } catch (err) {
        errors.push({
          objectType: config.objectType,
          message: err instanceof Error ? err.message : String(err),
        });
        obsContext
          .createLogger({ component: "gatekeeper.salesforce", vendorId: "salesforce" })
          .error("object type sync failed", {
            event: "sync.object.failed", objectType: config.objectType, error: err,
          });
      }
    }

    const durationMs = Date.now() - start;
    logger.info("salesforce sync complete", {
      event: "sync.complete", durationMs,
      batchSize: syncedRecords, recordCount: syncedRecords,
    });

    return {
      objectTypes: targets.length,
      syncedRecords,
      embeddedVectors,
      skippedUnchanged,
      deletedVectors,
      errors,
    };
  }
}
