import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  deleteMissingRecords, deleteRecordsByIds, ensureObjectConfig, findMissingRecordIds, getCursor,
  getExistingHashes, getRecordById, getRecordsByIds, listObjectInfo, loadObjectConfigs, setCursor,
  upsertRecords,
} from "../src/sf-store.js";
import { OBJECT_TYPE_CONFIGS } from "../src/sf-objects.js";
import type { SfRecord } from "../src/salesforce-types.js";
import { toSfId15 } from "../src/salesforce-types.js";

const MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS records (
  sf_id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  name TEXT NOT NULL,
  snippet TEXT,
  search_text TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  attributes TEXT NOT NULL DEFAULT '{}',
  system_modstamp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE INDEX IF NOT EXISTS idx_records_object ON records(object_type)`,
  `CREATE INDEX IF NOT EXISTS idx_records_modstamp ON records(system_modstamp)`,
  `CREATE TABLE IF NOT EXISTS sync_cursor (
  object_type TEXT PRIMARY KEY,
  last_modstamp TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  last_count INTEGER NOT NULL DEFAULT 0
)`,
  `CREATE TABLE IF NOT EXISTS object_config (
  object_type TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  soql_fields TEXT NOT NULL,
  embed_fields TEXT NOT NULL,
  display_name_field TEXT NOT NULL DEFAULT 'Name',
  last_total INTEGER
)`,
];

async function applyMigration(db: D1Database): Promise<void> {
  for (const stmt of MIGRATION_STATEMENTS) {
    await db.prepare(stmt).run();
  }
}

// Distinct 15-char Salesforce Ids (package primary key form).
const ID_A = "001cv000016kMOH";
const ID_B = "001cv000016kMOI";
// Matching 18-char forms (checksum suffix is illustrative).
const ID_A_18 = "001cv000016kMOHAA2";
const ID_B_18 = "001cv000016kMOIAA2";

function sampleRecord(id: string, name: string): SfRecord {
  return {
    Id: id,
    Name: name,
    SystemModstamp: "2026-08-01T10:00:00.000Z",
  };
}

describe("Salesforce D1 store", () => {
  it("round-trips record upsert and read", async () => {
    await applyMigration(env.SF_DB);

    const account = sampleRecord(ID_A, "Fred Anderson Toyota");
    await upsertRecords(env.SF_DB, [
      {
        record: account,
        objectType: "Account",
        name: "Fred Anderson Toyota",
        searchText: "Account: Fred Anderson Toyota. Type: Customer",
        contentHash: "abc123",
        content: JSON.stringify(account),
        attributes: { objectType: "Account", recordName: "Fred Anderson Toyota" },
      },
    ]);

    const stored = await getRecordById(env.SF_DB, ID_A);
    expect(stored?.name).toBe("Fred Anderson Toyota");
    expect(stored?.object_type).toBe("Account");
    expect(stored?.sf_id).toBe(ID_A);
    expect(stored?.content).toBe(JSON.stringify(account));

    // Upsert replaces fully; 18-char Ids normalize to the same 15-char key.
    const updated = sampleRecord(ID_A_18, "Fred Anderson Toyota 2");
    await upsertRecords(env.SF_DB, [
      {
        record: updated,
        objectType: "Account",
        name: "Fred Anderson Toyota 2",
        searchText: "Account: Fred Anderson Toyota 2",
        contentHash: "def456",
        content: JSON.stringify(updated),
        attributes: { objectType: "Account", recordName: "Fred Anderson Toyota 2" },
      },
    ]);
    const reStored = await getRecordById(env.SF_DB, ID_A_18);
    expect(reStored?.name).toBe("Fred Anderson Toyota 2");
    expect(reStored?.content_hash).toBe("def456");
    expect(reStored?.sf_id).toBe(ID_A);
  });

  it("fetches records by ID list and detects changed hashes", async () => {
    await applyMigration(env.SF_DB);
    const a = sampleRecord(ID_A, "A");
    const b = sampleRecord(ID_B, "B");
    await upsertRecords(env.SF_DB, [
      {
        record: a, objectType: "Account", name: "A", searchText: "A text",
        contentHash: "hash-a", content: JSON.stringify(a),
        attributes: { objectType: "Account", recordName: "A" },
      },
      {
        record: b, objectType: "Account", name: "B", searchText: "B text",
        contentHash: "hash-b", content: JSON.stringify(b),
        attributes: { objectType: "Account", recordName: "B" },
      },
    ]);

    const rows = await getRecordsByIds(env.SF_DB, [ID_A, ID_B_18]);
    expect(rows).toHaveLength(2);

    const hashes = await getExistingHashes(env.SF_DB, [ID_A_18, ID_B]);
    expect(hashes.get(ID_A)?.contentHash).toBe("hash-a");
    expect(hashes.get(ID_B)?.contentHash).toBe("hash-b");
    expect(hashes.has("missing")).toBe(false);
  });

  it("reconciles full-inventory deletions and removes D1 rows by Id", async () => {
    await applyMigration(env.SF_DB);
    await upsertRecords(env.SF_DB, [
      {
        record: sampleRecord(ID_A, "A"), objectType: "Account", name: "A",
        searchText: "A text", contentHash: "h1", content: "{}",
        attributes: { objectType: "Account", recordName: "A" },
      },
      {
        record: sampleRecord(ID_B_18, "B"), objectType: "Account", name: "B",
        searchText: "B text", contentHash: "h2", content: "{}",
        attributes: { objectType: "Account", recordName: "B" },
      },
    ]);

    // Full inventory still contains only "A" → "B" is a deletion candidate (stored as 15-char).
    const missing = await findMissingRecordIds(env.SF_DB, "Account", [ID_A_18]);
    expect(missing).toEqual([ID_B]);
    // Empty inventory must not wipe the object type.
    expect(await findMissingRecordIds(env.SF_DB, "Account", [])).toEqual([]);

    const removed = await deleteRecordsByIds(env.SF_DB, [ID_B_18]);
    expect(removed).toBe(1);
    expect(await getRecordById(env.SF_DB, ID_B)).toBeNull();
    expect(await getRecordById(env.SF_DB, ID_A)).not.toBeNull();

    // Deprecated alias still reports missing IDs (does not delete).
    await upsertRecords(env.SF_DB, [
      {
        record: sampleRecord(ID_B, "B"), objectType: "Account", name: "B",
        searchText: "B text", contentHash: "h2", content: "{}",
        attributes: { objectType: "Account", recordName: "B" },
      },
    ]);
    expect(await deleteMissingRecords(env.SF_DB, "Account", [ID_A]))
      .toEqual([ID_B]);

    const info = await listObjectInfo(env.SF_DB);
    const account = info.find((i) => i.objectType === "Account");
    expect(account?.documentCount).toBe(2);
  });

  it("manages sync cursor and object config", async () => {
    await applyMigration(env.SF_DB);
    expect(await getCursor(env.SF_DB, "Account")).toBeNull();
    await setCursor(env.SF_DB, "Account", "2026-08-01T10:00:00.000Z", 5);
    expect(await getCursor(env.SF_DB, "Account")).toBe("2026-08-01T10:00:00.000Z");

    await ensureObjectConfig(env.SF_DB, OBJECT_TYPE_CONFIGS);
    const configs = await loadObjectConfigs(env.SF_DB);
    expect(configs.some((c) => c.objectType === "Account")).toBe(true);
    expect(configs.length).toBe(OBJECT_TYPE_CONFIGS.length);
  });
});

describe("toSfId15", () => {
  it("truncates only standard 18-char Ids", () => {
    expect(toSfId15(ID_A_18)).toBe(ID_A);
    expect(toSfId15(ID_A)).toBe(ID_A);
  });
});
