import type { SupabaseApi, SqlRow } from "./supabase-api";
import { supabaseUpstream } from "./supabase-upstream";
import type {
  SupabaseColumn,
  SupabaseForeignKey,
  SupabaseListTablesOptions,
  SupabaseTable,
  SupabaseTableDetails,
} from "./types";

/**
 * Schema introspection implemented as read-only catalog queries against the project database.
 *
 * Keeping this in one place means the Session can offer typed `listSchemas` / `listTables` /
 * `describeTable` conveniences instead of forcing the calling Gadget to hand-write
 * `pg_catalog` queries.
 */

// Schemas that are part of Postgres itself and never interesting to a Gadget. These are inlined
// (not bound as a parameter) since they are fixed, code-controlled constants — this keeps the
// query independent of array-parameter binding semantics.
const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];
const SYSTEM_SCHEMAS_SQL = SYSTEM_SCHEMAS.map(name => `'${name}'`).join(", ");

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function optionalStr(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : str(value);
}

function bool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

function approxRows(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * Coerces a value into string[]. The foreign-key query emits JSON arrays (via `to_json`), so the
 * value is normally a real array; we also accept a JSON-encoded array string defensively. We
 * deliberately do NOT hand-parse Postgres' `{...}` text-array format, which would mishandle quoted
 * elements containing commas/quotes.
 */
function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(str);
  if (typeof value === "string" && value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(str);
    } catch {
      // fall through
    }
  }
  return [];
}

export async function listSchemas(api: SupabaseApi, ref: string): Promise<string[]> {
  const rows = await api.runReadOnlyQuery(
    ref,
    `select n.nspname as schema
       from pg_catalog.pg_namespace n
      where n.nspname not in (${SYSTEM_SCHEMAS_SQL})
        and n.nspname not like 'pg_temp%'
        and n.nspname not like 'pg_toast_temp%'
      order by n.nspname`,
  );
  return rows.map(row => str(row.schema));
}

function rowToTable(row: SqlRow): SupabaseTable {
  const kind = str(row.kind) === "view" ? "view" : "table";
  return {
    schema: str(row.schema),
    name: str(row.name),
    kind,
    rlsEnabled: kind === "table" && bool(row.rls_enabled),
    approximateRowCount: kind === "view" ? null : approxRows(row.approx_rows),
    comment: optionalStr(row.comment),
  };
}

export async function listTables(
  api: SupabaseApi,
  ref: string,
  options?: SupabaseListTablesOptions,
): Promise<SupabaseTable[]> {
  const schema = options?.schema ?? "public";
  const includeViews = options?.includeViews ?? true;
  // relkind: r = table, p = partitioned table, v = view, m = materialized view. Inlined as a
  // fixed, code-controlled literal so we don't depend on array-parameter binding.
  const relkindsSql = (includeViews ? ["r", "p", "v", "m"] : ["r", "p"]).map(k => `'${k}'`).join(", ");
  const rows = await api.runReadOnlyQuery(
    ref,
    `select n.nspname as schema,
            c.relname as name,
            case when c.relkind in ('v','m') then 'view' else 'table' end as kind,
            c.relrowsecurity as rls_enabled,
            c.reltuples as approx_rows,
            pg_catalog.obj_description(c.oid, 'pg_class') as comment
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1
        and c.relkind in (${relkindsSql})
      order by c.relname`,
    [schema],
  );
  return rows.map(rowToTable);
}

async function getTableSummary(
  api: SupabaseApi,
  ref: string,
  schema: string,
  name: string,
): Promise<SupabaseTable> {
  const rows = await api.runReadOnlyQuery(
    ref,
    `select n.nspname as schema,
            c.relname as name,
            case when c.relkind in ('v','m') then 'view' else 'table' end as kind,
            c.relrowsecurity as rls_enabled,
            c.reltuples as approx_rows,
            pg_catalog.obj_description(c.oid, 'pg_class') as comment
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2
        and c.relkind in ('r','p','v','m')`,
    [schema, name],
  );
  if (rows.length === 0) {
    throw new Error(`Table ${schema}.${name} was not found.`);
  }
  return rowToTable(rows[0]);
}

async function getColumns(
  api: SupabaseApi,
  ref: string,
  schema: string,
  name: string,
): Promise<SupabaseColumn[]> {
  const rows = await api.runReadOnlyQuery(
    ref,
    `select a.attname as name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
            not a.attnotnull as nullable,
            pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_value,
            a.attidentity <> '' as is_identity,
            pg_catalog.col_description(a.attrelid, a.attnum) as comment
       from pg_catalog.pg_attribute a
       join pg_catalog.pg_class c on c.oid = a.attrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
      order by a.attnum`,
    [schema, name],
  );
  return rows.map(row => ({
    name: str(row.name),
    dataType: str(row.data_type),
    nullable: bool(row.nullable),
    defaultValue: optionalStr(row.default_value),
    isIdentity: bool(row.is_identity),
    comment: optionalStr(row.comment),
  }));
}

async function getPrimaryKey(
  api: SupabaseApi,
  ref: string,
  schema: string,
  name: string,
): Promise<string[]> {
  const rows = await api.runReadOnlyQuery(
    ref,
    `select a.attname as name
       from pg_catalog.pg_index i
       join pg_catalog.pg_class c on c.oid = i.indrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
       join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
      where n.nspname = $1 and c.relname = $2 and i.indisprimary
      order by k.ord`,
    [schema, name],
  );
  return rows.map(row => str(row.name));
}

async function getForeignKeys(
  api: SupabaseApi,
  ref: string,
  schema: string,
  name: string,
): Promise<SupabaseForeignKey[]> {
  const rows = await api.runReadOnlyQuery(
    ref,
    `select (select to_json(array_agg(att.attname order by u.ord))
               from unnest(con.conkey) with ordinality as u(attnum, ord)
               join pg_catalog.pg_attribute att
                 on att.attrelid = con.conrelid and att.attnum = u.attnum) as columns,
            fn.nspname as ref_schema,
            fc.relname as ref_table,
            (select to_json(array_agg(att.attname order by u.ord))
               from unnest(con.confkey) with ordinality as u(attnum, ord)
               join pg_catalog.pg_attribute att
                 on att.attrelid = con.confrelid and att.attnum = u.attnum) as ref_columns
       from pg_catalog.pg_constraint con
       join pg_catalog.pg_class c on c.oid = con.conrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_class fc on fc.oid = con.confrelid
       join pg_catalog.pg_namespace fn on fn.oid = fc.relnamespace
      where n.nspname = $1 and c.relname = $2 and con.contype = 'f'
      order by con.conname`,
    [schema, name],
  );
  return rows.map(row => ({
    columns: stringArray(row.columns),
    referencedSchema: str(row.ref_schema),
    referencedTable: str(row.ref_table),
    referencedColumns: stringArray(row.ref_columns),
  }));
}

/**
 * Reads a table's or view's summary, columns, primary key and foreign keys: a batch of up to four
 * catalog queries, whose calls are counted summed, as one point.
 */
export async function describeTable(
  api: SupabaseApi,
  ref: string,
  schema: string,
  name: string,
): Promise<SupabaseTableDetails> {
  return await supabaseUpstream.summed(async () => {
    const summary = await getTableSummary(api, ref, schema, name);
    const [columns, primaryKey, foreignKeys] = await Promise.all([
      getColumns(api, ref, schema, name),
      summary.kind === "table" ? getPrimaryKey(api, ref, schema, name) : Promise.resolve<string[]>([]),
      summary.kind === "table" ? getForeignKeys(api, ref, schema, name) : Promise.resolve<SupabaseForeignKey[]>([]),
    ]);
    return { ...summary, columns, primaryKey, foreignKeys };
  });
}
