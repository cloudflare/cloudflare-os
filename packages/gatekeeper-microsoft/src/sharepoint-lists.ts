// SharePoint list queries and values. An agent never writes OData: it names columns and values, and
// this module checks every column against the list's own schema before compiling the `$filter`,
// `$orderby` and `$select` Graph receives, quoting values so no text can change the query's shape.
// Values written to an item are checked against their column's type the same way.

import type { ColumnType, GraphColumn } from "./graph-parse";
import type { ColumnInfo, FieldFilter, FieldValue, ItemQuery } from "./types";

/** A query refused before reaching Graph. The message names the column and what was wrong. */
export class ListQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListQueryError";
  }
}

/** Columns every list has that agents may filter, sort and read, though SharePoint marks them hidden or read-only. */
const SYSTEM_COLUMNS: GraphColumn[] = [
  { name: "ID", displayName: "ID", type: "number", required: false, readOnly: true, hidden: false, indexed: true },
  { name: "Created", displayName: "Created", type: "dateTime", required: false, readOnly: true, hidden: false, indexed: false },
  { name: "Modified", displayName: "Modified", type: "dateTime", required: false, readOnly: true, hidden: false, indexed: true },
];

/**
 * Columns SharePoint uses internally, which would only confuse an agent. Whole names only, beyond the
 * `_` and `ows_` prefixes: a list's own `OrderNumber` or `Editorial` is not SharePoint's `Order` or `Editor`.
 */
const INTERNAL_COLUMN = /^(?:_|ows_)|^(?:ContentType|ContentTypeId|Attachments|Edit|LinkTitle|LinkTitleNoMenu|DocIcon|ItemChildCount|FolderChildCount|AppAuthor|AppEditor|ComplianceAssetId|Author|Editor|SelectTitle|InstanceID|Order|GUID|WorkflowVersion|WorkflowInstanceID|ParentVersionString|ParentLeafName|FileRef|FileDirRef|FSObjType|SortBehavior|PermMask|FileLeafRef|UniqueId|SyncClientId|ProgId|ScopeId|HTML_x0020_File_x0020_Type|MetaInfo|Restricted|OriginatorId|NoExecute|ContentVersion|AccessPolicy|BSN|SMTotalSize|SMLastModifiedDate|SMTotalFileStreamSize|SMTotalFileCount|Created_x0020_Date|Last_x0020_Modified|File_x0020_Type|EncodedAbsUrl|BaseName|FileSizeDisplay|ServerUrl|ID)$/;

/** The columns an agent sees: the list's own, plus the system columns worth querying. */
export function visibleColumns(columns: readonly GraphColumn[]): GraphColumn[] {
  const own = columns.filter(column => column.name === "Title" || (!column.hidden && !INTERNAL_COLUMN.test(column.name)));
  const named = new Set(own.map(column => column.name));
  return [...own, ...SYSTEM_COLUMNS.filter(column => !named.has(column.name))];
}

/** A column as the agent-facing API describes it. */
export function toColumnInfo(column: GraphColumn): ColumnInfo {
  return {
    name: column.name,
    displayName: column.displayName,
    type: column.type,
    ...(column.description ? { description: column.description } : {}),
    required: column.required,
    readOnly: column.readOnly,
    indexed: column.indexed,
    ...(column.choices ? { choices: column.choices } : {}),
  };
}

/** Looks a column up by internal name, or by display name when that is unambiguous. */
export function findColumn(columns: readonly GraphColumn[], name: string): GraphColumn {
  if (typeof name !== "string" || name === "") throw new ListQueryError("A column name is required.");
  const exact = columns.find(column => column.name === name);
  if (exact) return exact;
  const byDisplay = columns.filter(column => column.displayName.toLowerCase() === name.toLowerCase());
  if (byDisplay.length === 1) return byDisplay[0];
  const known = columns.map(column => column.name).slice(0, 30).join(", ");
  throw new ListQueryError(`This list has no column "${name}". Its columns are: ${known}.`);
}

/** An OData string literal: single quotes doubled, nothing else changes meaning inside one. */
function quote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** The OData literal for a filter value, checked against the column's type. */
function literal(column: GraphColumn, value: FieldFilter["value"]): string {
  if (value === null) return "null";
  // Graph types the ID as a string in filters, and refuses to compare it with a number.
  if (column.name === "ID") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new ListQueryError("Column \"ID\" holds whole numbers.");
    return quote(String(value));
  }
  switch (column.type) {
    case "number":
    case "currency":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ListQueryError(`Column "${column.name}" holds numbers; compare it with a number.`);
      }
      return String(value);
    case "boolean":
      if (typeof value !== "boolean") throw new ListQueryError(`Column "${column.name}" holds true or false.`);
      // SharePoint stores yes/no columns as 1 and 0, and filters them that way.
      return value ? "1" : "0";
    case "dateTime":
      if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
        throw new ListQueryError(`Column "${column.name}" holds dates; compare it with an ISO 8601 date like "2026-10-17".`);
      }
      return quote(value);
    default:
      if (typeof value !== "string") throw new ListQueryError(`Column "${column.name}" holds text; compare it with a string.`);
      return quote(value);
  }
}

const COMPARISONS: Record<Exclude<FieldFilter["op"], "startsWith">, string> = {
  eq: "eq", ne: "ne", lt: "lt", le: "le", gt: "gt", ge: "ge",
};

/** Column types Graph cannot filter on through `fields/`. */
const UNFILTERABLE: ReadonlySet<ColumnType> = new Set(["note", "multiChoice", "person", "lookup", "hyperlink", "other"]);

/** What a query compiles to, and whether it touches columns that are not indexed. */
export type CompiledQuery = {
  query: Record<string, string>;
  /** Columns filtered or sorted on that SharePoint has not indexed. */
  unindexed: string[];
};

/** Every column, the system ones included, is filtered and sorted through the item's `fields`. */
function fieldPath(column: GraphColumn): string {
  return `fields/${column.name}`;
}

/**
 * Compiles a query into Graph's list item parameters.
 * @throws ListQueryError for an unknown column, a value of the wrong type, or an unsupported filter.
 */
export function compileQuery(columns: readonly GraphColumn[], query: ItemQuery = {}): CompiledQuery {
  const clauses: string[] = [];
  const unindexed = new Set<string>();
  const where = query.where ?? [];
  if (!Array.isArray(where)) throw new ListQueryError("`where` must be a list of conditions.");
  if (where.length > 20) throw new ListQueryError("A query may have at most 20 conditions.");
  for (const condition of where) {
    const column = findColumn(columns, condition?.field);
    if (UNFILTERABLE.has(column.type)) {
      throw new ListQueryError(`Column "${column.name}" (${column.type}) can't be filtered on; read the items and check it yourself.`);
    }
    if (!column.indexed) unindexed.add(column.name);
    const path = fieldPath(column);
    if (condition.op === "startsWith") {
      if (typeof condition.value !== "string") throw new ListQueryError("`startsWith` compares with a string.");
      clauses.push(`startswith(${path},${quote(condition.value)})`);
    } else if (Object.hasOwn(COMPARISONS, condition.op)) {
      clauses.push(`${path} ${COMPARISONS[condition.op]} ${literal(column, condition.value)}`);
    } else {
      throw new ListQueryError(`Unknown comparison "${String(condition.op)}". Use eq, ne, lt, le, gt, ge, or startsWith.`);
    }
  }
  const compiled: Record<string, string> = { $expand: "fields" };
  if (clauses.length > 0) compiled.$filter = clauses.join(" and ");
  if (query.orderBy !== undefined) {
    const column = findColumn(columns, query.orderBy.field);
    if (!column.indexed) unindexed.add(column.name);
    compiled.$orderby = `${fieldPath(column)}${query.orderBy.descending ? " desc" : ""}`;
  }
  if (query.fields !== undefined) {
    if (!Array.isArray(query.fields) || query.fields.length === 0) throw new ListQueryError("`fields` must name at least one column.");
    const names = query.fields.map(name => findColumn(columns, name).name).filter(name => !["ID", "Created", "Modified"].includes(name));
    // The version and approval state ride along: they decide what an observer must be shown.
    compiled.$expand = `fields($select=${[...(names.length > 0 ? names : ["Title"]), "_UIVersionString", "_ModerationStatus"].join(",")})`;
  }
  return { query: compiled, unindexed: [...unindexed] };
}

// -- values -------------------------------------------------------------------------------------

/** Most characters a single-line text column holds. */
const MAX_TEXT = 255;
/** Most characters a multi-line text column holds. */
const MAX_NOTE = 63_999;

/**
 * Checks values an agent wants written against the columns they name, and returns them keyed by
 * internal name, as Graph wants them.
 * @throws ListQueryError naming the first column that is unknown, read-only, or of the wrong type.
 */
export function validateFieldValues(columns: readonly GraphColumn[], fields: Record<string, FieldValue>): Record<string, FieldValue> {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) throw new ListQueryError("Fields must be an object of column values.");
  const entries = Object.entries(fields);
  if (entries.length === 0) throw new ListQueryError("Name at least one column to set.");
  const out: Record<string, FieldValue> = {};
  for (const [name, value] of entries) {
    const column = findColumn(columns, name);
    if (column.readOnly) throw new ListQueryError(`Column "${column.name}" is computed by SharePoint and can't be set.`);
    out[column.name] = checkValue(column, value);
  }
  return out;
}

/** Checks the columns a new item must have. */
export function requireRequired(columns: readonly GraphColumn[], fields: Record<string, FieldValue>): void {
  const missing = columns.filter(column => column.required && !column.readOnly && (fields[column.name] === undefined || fields[column.name] === null || fields[column.name] === ""));
  if (missing.length > 0) {
    throw new ListQueryError(`A new item needs ${missing.map(column => `"${column.name}"`).join(", ")}.`);
  }
}

function checkValue(column: GraphColumn, value: FieldValue): FieldValue {
  if (value === null) {
    if (column.required) throw new ListQueryError(`Column "${column.name}" is required and can't be emptied.`);
    return null;
  }
  switch (column.type) {
    case "text":
    case "note": {
      if (typeof value !== "string") throw new ListQueryError(`Column "${column.name}" holds text.`);
      const max = column.type === "text" ? MAX_TEXT : MAX_NOTE;
      if (value.length > max) throw new ListQueryError(`Column "${column.name}" holds at most ${max.toLocaleString("en-US")} characters.`);
      if (column.type === "text" && /[\r\n]/.test(value)) throw new ListQueryError(`Column "${column.name}" holds a single line of text.`);
      return value;
    }
    case "number":
    case "currency":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new ListQueryError(`Column "${column.name}" holds a number.`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw new ListQueryError(`Column "${column.name}" holds true or false.`);
      return value;
    case "dateTime":
      if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
        throw new ListQueryError(`Column "${column.name}" holds a date, as an ISO 8601 string like "2026-10-17T09:00:00Z".`);
      }
      return value;
    case "choice":
      if (typeof value !== "string") throw new ListQueryError(`Column "${column.name}" holds one of: ${(column.choices ?? []).join(", ")}.`);
      if (column.choices && column.choices.length > 0 && !column.choices.includes(value)) {
        throw new ListQueryError(`"${value}" isn't a choice of column "${column.name}". Choose one of: ${column.choices.join(", ")}.`);
      }
      return value;
    case "multiChoice": {
      if (!Array.isArray(value) || !value.every(choice => typeof choice === "string")) {
        throw new ListQueryError(`Column "${column.name}" holds a list of choices.`);
      }
      const unknown = value.filter(choice => column.choices && column.choices.length > 0 && !column.choices.includes(choice));
      if (unknown.length > 0) throw new ListQueryError(`"${unknown[0]}" isn't a choice of column "${column.name}".`);
      return value;
    }
    default:
      throw new ListQueryError(`Column "${column.name}" (${column.type}) can't be written.`);
  }
}

/**
 * A field value as Graph returned it, as the agent-facing `FieldValue`: lookups and people become
 * their display text, multi-value fields lists of strings, and anything else structured its JSON.
 */
export function readFieldValue(value: unknown): FieldValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map(entry => {
      if (entry !== null && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        return String(record.LookupValue ?? record.Email ?? record.Label ?? JSON.stringify(entry));
      }
      return String(entry);
    });
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // A hyperlink column reads as { Url, Description }.
    if (typeof record.Url === "string") return record.Description && record.Description !== record.Url ? `${record.Description} (${record.Url})` : record.Url;
    if (typeof record.LookupValue === "string") return record.LookupValue;
    if (typeof record.Label === "string") return record.Label;
    return JSON.stringify(value);
  }
  return String(value);
}
