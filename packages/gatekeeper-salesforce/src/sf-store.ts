// D1 data-access helpers for the Salesforce gatekeeper. The Worker binding SF_DB backs the
// `records`, `sync_cursor`, and `object_config` tables.

import type { ObjectTypeConfig } from "./sf-objects.js";
import { OBJECT_TYPE_CONFIGS } from "./sf-objects.js";
import type {
  SalesforceObjectInfo, SalesforceRecord, SalesforceSearchResult,
  SalesforceVectorMetadata, SfRecord,
} from "./salesforce-types.js";
import { toSfId15 } from "./salesforce-types.js";

export type StoredRecord = {
  sf_id: string;
  object_type: string;
  name: string;
  snippet: string | null;
  content: string;
  search_text: string;
  content_hash: string;
  attributes: string;
  system_modstamp: string;
};

// Raw D1 row → typed record.
export function rowToStored(row: Record<string, unknown>): StoredRecord {
  return {
    sf_id: String(row.sf_id),
    object_type: String(row.object_type),
    name: String(row.name),
    snippet: row.snippet == null ? null : String(row.snippet),
    content: String(row.content),
    search_text: String(row.search_text),
    content_hash: String(row.content_hash),
    attributes: String(row.attributes),
    system_modstamp: String(row.system_modstamp),
  };
}

// Insert or replace a batch of records (and their metadata) in one transaction.
export async function upsertRecords(
  db: D1Database,
  records: {
    record: SfRecord;
    objectType: string;
    name: string;
    searchText: string;
    contentHash: string;
    content: string;
    attributes: SalesforceVectorMetadata;
  }[],
): Promise<void> {
  const stmt = db
    .prepare(
      `INSERT OR REPLACE INTO records
         (sf_id, object_type, name, snippet, search_text, content, content_hash, attributes, system_modstamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  const batch = records.map((r) =>
    stmt.bind(
      toSfId15(r.record.Id),
      r.objectType,
      r.name,
      // snippet mirrors the search text prefix at this layer; search() returns it directly.
      r.searchText.slice(0, 512),
      r.searchText,
      r.content,
      r.contentHash,
      JSON.stringify(r.attributes),
      String(r.record.SystemModstamp ?? ""),
    ));
  await db.batch(batch);
}

/**
 * Full-inventory reconcile only: given the complete set of IDs that still exist in Salesforce for
 * an object type, return D1 row IDs that are absent from that inventory. Do NOT call this with an
 * incremental delta — that would treat every untouched row as deleted.
 *
 * Callers must DELETE the returned IDs from D1 (via deleteRecordsByIds) and Vectorize together.
 */
export async function findMissingRecordIds(
  db: D1Database,
  objectType: string,
  existingIds: string[],
): Promise<string[]> {
  if (existingIds.length === 0) {
    // Empty inventory with no IDs means "unknown" — refuse to wipe the object type.
    return [];
  }
  const existing = new Set(existingIds.map(toSfId15));
  const { results: allRows } = await db
    .prepare(`SELECT sf_id FROM records WHERE object_type = ?`)
    .bind(objectType)
    .all<{ sf_id: string }>();
  return allRows.filter((row) => !existing.has(row.sf_id)).map((row) => row.sf_id);
}

/** @deprecated Prefer findMissingRecordIds + deleteRecordsByIds. */
export async function deleteMissingRecords(
  db: D1Database,
  objectType: string,
  existingIds: string[],
): Promise<string[]> {
  return findMissingRecordIds(db, objectType, existingIds);
}

/** Delete indexed rows from D1 by Salesforce Id. Returns the number of rows removed. */
export async function deleteRecordsByIds(db: D1Database, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const normalized = [...new Set(ids.map(toSfId15))];
  const CHUNK = 400;
  let deleted = 0;
  for (let i = 0; i < normalized.length; i += CHUNK) {
    const slice = normalized.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    const result = await db
      .prepare(`DELETE FROM records WHERE sf_id IN (${placeholders})`)
      .bind(...slice)
      .run();
    deleted += result.meta.changes ?? slice.length;
  }
  return deleted;
}

// Fetch the content_hash and system_modstamp for a batch of IDs (used to skip re-embedding).
export async function getExistingHashes(
  db: D1Database,
  ids: string[],
): Promise<Map<string, { contentHash: string; systemModstamp: string }>> {
  if (ids.length === 0) return new Map();
  const normalized = ids.map(toSfId15);
  const placeholders = normalized.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT sf_id, content_hash, system_modstamp FROM records WHERE sf_id IN (${placeholders})`)
    .bind(...normalized)
    .all<{ sf_id: string; content_hash: string; system_modstamp: string }>();
  return new Map(
    results.map((r) => [
      r.sf_id,
      { contentHash: r.content_hash, systemModstamp: r.system_modstamp },
    ]),
  );
}

// Load a batch of full records by ID (used by search() to fetch display content).
export async function getRecordsByIds(db: D1Database, ids: string[]): Promise<StoredRecord[]> {
  if (ids.length === 0) return [];
  const normalized = ids.map(toSfId15);
  const placeholders = normalized.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT * FROM records WHERE sf_id IN (${placeholders})`)
    .bind(...normalized)
    .all();
  return results.map(rowToStored);
}

// Fetch one full record by ID.
export async function getRecordById(db: D1Database, id: string): Promise<StoredRecord | null> {
  const row = await db
    .prepare(`SELECT * FROM records WHERE sf_id = ? LIMIT 1`)
    .bind(toSfId15(id))
    .first();
  return row ? rowToStored(row) : null;
}

// The number of records indexed for each object type.
export async function listObjectInfo(db: D1Database): Promise<SalesforceObjectInfo[]> {
  const { results } = await db
    .prepare(
      `SELECT object_type, COUNT(*) AS count, MAX(updated_at) AS last_synced
       FROM records GROUP BY object_type`,
    )
    .all<{ object_type: string; count: number; last_synced: string | null }>();
  return results.map((r) => {
    const cfg = OBJECT_TYPE_CONFIGS.find((c) => c.objectType === r.object_type);
    return {
      objectType: r.object_type,
      title: cfg?.title ?? r.object_type,
      description: cfg?.description,
      documentCount: r.count,
      lastSynced: r.last_synced ?? undefined,
    };
  });
}

// Read the per-object sync cursor.
export async function getCursor(db: D1Database, objectType: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT last_modstamp FROM sync_cursor WHERE object_type = ?`)
    .bind(objectType)
    .first<{ last_modstamp: string }>();
  return row?.last_modstamp ?? null;
}

// Write the per-object sync cursor.
export async function setCursor(
  db: D1Database,
  objectType: string,
  lastModstamp: string,
  count: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_cursor (object_type, last_modstamp, last_synced_at, last_count)
       VALUES (?, ?, datetime('now'), ?)
       ON CONFLICT(object_type) DO UPDATE SET
         last_modstamp = excluded.last_modstamp,
         last_synced_at = excluded.last_synced_at,
         last_count = excluded.last_count`,
    )
    .bind(objectType, lastModstamp, count)
    .run();
}

// Enable/disable an object type's sync, or add a new one with default fields.
export async function ensureObjectConfig(db: D1Database, configs: ObjectTypeConfig[]): Promise<void> {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO object_config (object_type, enabled, soql_fields, embed_fields, display_name_field)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const batch = configs.map((c) =>
    stmt.bind(
      c.objectType,
      c.enabled === false ? 0 : 1,
      JSON.stringify(c.soqlFields),
      JSON.stringify(c.embedFields),
      c.displayField ?? "Name",
    ));
  await db.batch(batch);
}

// Load enabled object configs (falling back to the built-in default set).
export async function loadObjectConfigs(db: D1Database): Promise<ObjectTypeConfig[]> {
  const { results } = await db
    .prepare(`SELECT * FROM object_config WHERE enabled = 1`)
    .all<{
      object_type: string;
      enabled: number;
      soql_fields: string;
      embed_fields: string;
      display_name_field: string;
    }>();
  if (results.length === 0) {
    // Seeding not done yet — use the built-in defaults so the first sync is complete.
    return OBJECT_TYPE_CONFIGS.filter((c) => c.enabled !== false);
  }
  const byType = new Map(OBJECT_TYPE_CONFIGS.map((c) => [c.objectType, c]));
  return results.map((row) => {
    const base = byType.get(row.object_type);
    return {
      objectType: row.object_type,
      title: base?.title ?? row.object_type,
      description: base?.description,
      soqlFields: JSON.parse(row.soql_fields) as string[],
      embedFields: JSON.parse(row.embed_fields) as string[],
      displayField: row.display_name_field,
      ownerField: base?.ownerField,
      campaignField: base?.campaignField,
      statusField: base?.statusField,
      enabled: row.enabled === 1,
    };
  });
}

// Convert a stored record to the agent-facing SalesforceRecord shape.
export function storedToSalesforceRecord(stored: StoredRecord): SalesforceRecord {
  return {
    id: stored.sf_id,
    objectType: stored.object_type,
    title: stored.name,
    content: stored.search_text,
    fields: JSON.parse(stored.content) as Record<string, unknown>,
    systemModstamp: stored.system_modstamp ?? undefined,
  };
}

// Convert stored records + vector metadata to search results.
export function storedToSearchResults(
  stored: StoredRecord[],
  scores: Map<string, number>,
): SalesforceSearchResult[] {
  return stored
    .map((r) => ({
      id: r.sf_id,
      objectType: r.object_type,
      title: r.name,
      snippet: r.snippet ?? undefined,
      score: scores.get(r.sf_id),
      attributes: (() => {
        try {
          return JSON.parse(r.attributes) as Record<string, string>;
        } catch {
          return undefined;
        }
      })(),
    } satisfies SalesforceSearchResult))
    .filter((r) => r.id.length > 0);
}
