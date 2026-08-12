-- Full Salesforce record content mirror, keyed by 15-char Salesforce Id. Vectorize holds the
-- embedding + indexed metadata; D1 holds the authoritative text/JSON for display and retrieval.
CREATE TABLE IF NOT EXISTS records (
  sf_id           TEXT PRIMARY KEY,             -- 15-char Salesforce Id (e.g. 001cv000016kMOH)
  object_type     TEXT NOT NULL,                -- e.g. 'Account', 'Contact', 'Task'
  name            TEXT NOT NULL,                -- display name for listings
  snippet         TEXT,                         -- short serialization for search listings
  content         TEXT NOT NULL,                -- full JSON record (value objects, no PII labels)
  search_text     TEXT NOT NULL,                -- flattened text fed to the embedding model
  content_hash    TEXT NOT NULL,                -- sha256 of search_text; skips re-embedding
  attributes      TEXT NOT NULL DEFAULT '{}',   -- JSON: indexed metadata (owner/campaign/status/…)
  system_modstamp TEXT NOT NULL,                -- Salesforce SystemModstamp (ISO 8601)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_records_object  ON records(object_type);
CREATE INDEX IF NOT EXISTS idx_records_modstamp ON records(system_modstamp);

-- Per-object incremental sync cursor.
CREATE TABLE IF NOT EXISTS sync_cursor (
  object_type    TEXT PRIMARY KEY,
  last_modstamp  TEXT NOT NULL,                 -- last SystemModstamp ingested (ISO 8601)
  last_synced_at TEXT NOT NULL,
  last_count     INTEGER NOT NULL DEFAULT 0
);

-- Which object types to sync and how to serialize them.
CREATE TABLE IF NOT EXISTS object_config (
  object_type    TEXT PRIMARY KEY,
  enabled        INTEGER NOT NULL DEFAULT 1,
  soql_fields    TEXT NOT NULL,                 -- JSON array of SOQL field API names
  embed_fields   TEXT NOT NULL,                 -- JSON array of field API names included in search_text
  display_name_field TEXT NOT NULL DEFAULT 'Name', -- field used for the display name
  last_total     INTEGER
);
