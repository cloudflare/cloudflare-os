// Thin wrapper around the Notion REST API (https://developers.notion.com/reference), plus the
// OAuth helpers used by the connect flow and the block<->Markdown / property converters used to
// present a simplified API to Gadgets.
//
// Two Notion-Version values are used. The default (NOTION_VERSION = 2022-06-28) is used for pages,
// blocks, comments, search and users, where it keeps user-facing IDs consistent (pages report
// `database_id` parents; search returns `database` objects). The data-source-aware version
// (DATA_SOURCE_VERSION = 2025-09-03) is used only to discover a database's data sources and to
// read the schema / query rows of a data source — required because newer multi-source / Meeting
// Notes / wiki databases return no rows from the legacy `databases/{id}/query` endpoint. The
// database→data-source split is hidden from the Session API.

import type {
  NotionComment,
  NotionDatabaseSchema,
  NotionIconInput,
  NotionItemSummary,
  NotionObjectKind,
  NotionParent,
  NotionPageMetadata,
  NotionPageSummary,
  NotionPropertyInput,
  NotionPropertySchema,
  NotionPropertyType,
  NotionPropertyValue,
  NotionUser,
} from "./types";

const API_BASE_URL = "https://api.notion.com";
// Default version: pages/blocks/comments/search/users keep reporting `database_id` parents and
// `database` search objects, which keeps user-facing IDs/URLs consistent.
const NOTION_VERSION = "2022-06-28";
// Data-source-aware version, used only for the database→data-source discovery, data-source schema,
// and row queries. Required because newer multi-source / Meeting Notes / wiki databases return no
// rows from the legacy `databases/{id}/query` endpoint.
const DATA_SOURCE_VERSION = "2025-09-03";
const REQUEST_TIMEOUT_MS = 30_000;

export class NotionApiError extends Error {
  status: number;
  code?: string;
  isAuthError: boolean;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
    this.code = code;
    this.isAuthError = status === 401;
  }
}

// ---------------------------------------------------------------------------------------------
// OAuth

export type NotionOAuthGrant = {
  accessToken: string;
  refreshToken?: string;
  botId?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceIcon?: string;
  owner?: NotionUser | null;
};

type NotionTokenResponse = {
  access_token: string;
  refresh_token?: string;
  bot_id?: string;
  workspace_id?: string;
  workspace_name?: string | null;
  workspace_icon?: string | null;
  owner?: { user?: NotionUserResponse } | null;
  error?: string;
  error_description?: string;
};

async function postToken(
  body: Record<string, string>,
  clientId: string,
  clientSecret: string,
): Promise<NotionOAuthGrant> {
  const response = await fetch(`${API_BASE_URL}/v1/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const parsed = (await response.json().catch(() => null)) as NotionTokenResponse | null;
  if (!response.ok || !parsed || !parsed.access_token || parsed.error) {
    const message =
      [parsed?.error, parsed?.error_description].filter(Boolean).join(": ") ||
      `Notion OAuth token request failed: ${response.status} ${response.statusText}`;
    throw new NotionApiError(response.status, message, parsed?.error);
  }

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    botId: parsed.bot_id,
    workspaceId: parsed.workspace_id,
    workspaceName: parsed.workspace_name ?? undefined,
    workspaceIcon: parsed.workspace_icon ?? undefined,
    owner: parsed.owner?.user ? userResponseToUser(parsed.owner.user) : null,
  };
}

/** Exchange an authorization code for an access token + refresh token. */
export async function exchangeAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<NotionOAuthGrant> {
  return await postToken(
    { grant_type: "authorization_code", code, redirect_uri: redirectUri },
    clientId,
    clientSecret,
  );
}

/** Refresh an access token using a stored refresh token. */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<NotionOAuthGrant> {
  return await postToken(
    { grant_type: "refresh_token", refresh_token: refreshToken },
    clientId,
    clientSecret,
  );
}

// ---------------------------------------------------------------------------------------------
// Loose response shapes for the bits of the Notion API we read.

type NotionRichText = {
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    code?: boolean;
  };
  text?: { content?: string; link?: { url: string } | null };
};

type NotionUserResponse = {
  id: string;
  name?: string | null;
  avatar_url?: string | null;
  type?: "person" | "bot";
  person?: { email?: string };
};

type NotionFileLike = {
  name?: string;
  external?: { url: string };
  file?: { url: string };
};

type NotionIcon =
  | { type: "emoji"; emoji: string }
  | { type: "external"; external: { url: string } }
  | { type: "file"; file: { url: string } }
  | null;

type NotionPropertyResponse = {
  id: string;
  type: string;
  [key: string]: unknown;
};

export type NotionPageResponse = {
  object: "page";
  id: string;
  url: string;
  created_time: string;
  last_edited_time: string;
  created_by?: NotionUserResponse;
  last_edited_by?: NotionUserResponse;
  archived?: boolean;
  in_trash?: boolean;
  locked?: boolean;
  icon?: NotionIcon;
  parent?: NotionParentResponse;
  properties?: Record<string, NotionPropertyResponse>;
};

/**
 * Under Notion-Version 2025-09-03, a database is a container of one or more data sources; the
 * schema (properties) lives on the data source, and the database response lists `data_sources`.
 */
export type NotionDatabaseResponse = {
  object: "database";
  id: string;
  url?: string;
  created_time: string;
  last_edited_time: string;
  title?: NotionRichText[];
  description?: NotionRichText[];
  icon?: NotionIcon;
  parent?: NotionParentResponse;
  data_sources?: { id: string; name: string }[];
};

/** A data source holds the actual row schema (properties) and is what we query for rows. */
export type NotionDataSourceResponse = {
  object: "data_source";
  id: string;
  url?: string;
  created_time: string;
  last_edited_time: string;
  title?: NotionRichText[];
  description?: NotionRichText[];
  icon?: NotionIcon;
  properties?: Record<string, NotionPropertyResponse>;
};

type NotionParentResponse =
  | { type: "workspace"; workspace: true }
  | { type: "page_id"; page_id: string }
  | { type: "database_id"; database_id: string }
  | { type: "block_id"; block_id: string };

type NotionBlockResponse = {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
};

type NotionListResponse<T> = {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
};

// ---------------------------------------------------------------------------------------------
// Conversions: users, icons, rich text

function userResponseToUser(user: NotionUserResponse): NotionUser {
  return {
    id: user.id,
    name: user.name ?? undefined,
    avatarUrl: user.avatar_url ?? undefined,
    type: user.type,
    email: user.person?.email,
  };
}

function iconToString(icon: NotionIcon | undefined): string | undefined {
  if (!icon) return undefined;
  if (icon.type === "emoji") return icon.emoji;
  if (icon.type === "external") return icon.external.url;
  if (icon.type === "file") return icon.file.url;
  return undefined;
}

function iconInputToNotion(icon: NotionIconInput): NotionIcon {
  if ("emoji" in icon) return { type: "emoji", emoji: icon.emoji };
  return { type: "external", external: { url: icon.imageUrl } };
}

function richTextToPlain(rich: NotionRichText[] | undefined): string {
  if (!rich) return "";
  return rich.map(r => r.plain_text ?? r.text?.content ?? "").join("");
}

// A signature of the styling applied to a rich-text run, used to merge adjacent runs.
function runStyleKey(r: NotionRichText): string {
  const a = r.annotations ?? {};
  const href = r.href ?? r.text?.link?.url ?? "";
  return `${a.bold ? 1 : 0}${a.italic ? 1 : 0}${a.strikethrough ? 1 : 0}${a.code ? 1 : 0}|${href}`;
}

// Wrap inline text in Markdown emphasis markers without putting whitespace immediately inside the
// markers (CommonMark won't treat `** text **` as bold), by hoisting leading/trailing spaces out.
function wrapInline(text: string, r: NotionRichText): string {
  const leading = text.match(/^\s*/)?.[0] ?? "";
  const trailing = text.match(/\s*$/)?.[0] ?? "";
  let core = text.slice(leading.length, text.length - trailing.length);
  if (core) {
    const ann = r.annotations ?? {};
    if (ann.code) core = "`" + core + "`";
    if (ann.bold) core = `**${core}**`;
    if (ann.italic) core = `*${core}*`;
    if (ann.strikethrough) core = `~~${core}~~`;
    const href = r.href ?? r.text?.link?.url;
    if (href) core = `[${core}](${href})`;
  }
  return leading + core + trailing;
}

// Convert rich text to inline Markdown, honoring basic annotations and links. Adjacent runs that
// share identical styling are merged first, so we don't emit broken sequences like `**a****b**`.
function richTextToMarkdown(rich: NotionRichText[] | undefined): string {
  if (!rich || rich.length === 0) return "";
  const merged: NotionRichText[] = [];
  for (const r of rich) {
    const prev = merged[merged.length - 1];
    if (prev && runStyleKey(prev) === runStyleKey(r)) {
      const prevText = prev.plain_text ?? prev.text?.content ?? "";
      const curText = r.plain_text ?? r.text?.content ?? "";
      merged[merged.length - 1] = { ...prev, plain_text: prevText + curText, text: undefined };
    } else {
      merged.push(r);
    }
  }
  return merged
    .map(r => {
      const text = r.plain_text ?? r.text?.content ?? "";
      return text ? wrapInline(text, r) : "";
    })
    .join("");
}

// Build a Notion rich text array from a plain string (no inline Markdown parsing — used for titles
// and simple text fields). Notion caps a single rich text content chunk at 2000 chars.
function plainToRichText(text: string): unknown[] {
  if (!text) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 2000) chunks.push(text.slice(i, i + 2000));
  return chunks.map(content => ({ type: "text", text: { content } }));
}

function titleOf(properties: Record<string, NotionPropertyResponse> | undefined): string {
  if (!properties) return "";
  for (const prop of Object.values(properties)) {
    if (prop.type === "title") {
      return richTextToPlain(prop.title as NotionRichText[] | undefined);
    }
  }
  return "";
}

function parentToNotion(parent: NotionParentResponse | undefined): NotionParent {
  if (!parent) return { type: "workspace" };
  switch (parent.type) {
    case "page_id":
      return { type: "page", pageId: parent.page_id };
    case "database_id":
      return { type: "database", databaseId: parent.database_id };
    case "block_id":
      return { type: "block", blockId: parent.block_id };
    default:
      return { type: "workspace" };
  }
}

// ---------------------------------------------------------------------------------------------
// Conversions: property values (read)

export function propertyResponseToValue(prop: NotionPropertyResponse): NotionPropertyValue {
  const p = prop as Record<string, any>;
  switch (prop.type) {
    case "title":
      return { type: "title", text: richTextToPlain(p.title) };
    case "rich_text":
      return { type: "rich_text", text: richTextToPlain(p.rich_text) };
    case "number":
      return { type: "number", number: p.number ?? null };
    case "select":
      return { type: "select", option: p.select?.name ?? null };
    case "multi_select":
      return { type: "multi_select", options: (p.multi_select ?? []).map((o: any) => o.name) };
    case "status":
      return { type: "status", status: p.status?.name ?? null };
    case "date":
      return { type: "date", start: p.date?.start ?? null, end: p.date?.end ?? null };
    case "checkbox":
      return { type: "checkbox", checked: !!p.checkbox };
    case "url":
      return { type: "url", url: p.url ?? null };
    case "email":
      return { type: "email", email: p.email ?? null };
    case "phone_number":
      return { type: "phone_number", phoneNumber: p.phone_number ?? null };
    case "people":
      return { type: "people", people: (p.people ?? []).map(userResponseToUser) };
    case "relation":
      return { type: "relation", pageIds: (p.relation ?? []).map((r: any) => r.id) };
    case "formula": {
      const f = p.formula ?? {};
      const value =
        f.type === "string" ? f.string ?? null
        : f.type === "number" ? f.number ?? null
        : f.type === "boolean" ? f.boolean ?? null
        : f.type === "date" ? f.date?.start ?? null
        : null;
      return { type: "formula", value };
    }
    case "rollup": {
      const r = p.rollup ?? {};
      let summary = "";
      if (r.type === "number") summary = String(r.number ?? "");
      else if (r.type === "date") summary = r.date?.start ?? "";
      else if (r.type === "array") {
        // Render the rolled-up values (e.g. emails, names, titles) rather than just a count.
        const values = (r.array ?? []).map(rollupItemText).filter(Boolean);
        summary = values.join(", ");
      }
      return { type: "rollup", summary };
    }
    case "files":
      return {
        type: "files",
        files: (p.files ?? []).map((f: NotionFileLike) => ({
          name: f.name ?? "",
          url: f.external?.url ?? f.file?.url ?? "",
        })),
      };
    case "unique_id": {
      const u = p.unique_id ?? {};
      const prefix = u.prefix ? `${u.prefix}-` : "";
      return { type: "unique_id", value: `${prefix}${u.number ?? ""}` };
    }
    case "created_time":
      return { type: "created_time", time: new Date(p.created_time) };
    case "last_edited_time":
      return { type: "last_edited_time", time: new Date(p.last_edited_time) };
    case "created_by":
      return { type: "created_by", user: p.created_by ? userResponseToUser(p.created_by) : null };
    case "last_edited_by":
      return {
        type: "last_edited_by",
        user: p.last_edited_by ? userResponseToUser(p.last_edited_by) : null,
      };
    default:
      return { type: "unsupported", rawType: prop.type };
  }
}

// Render a single item inside an array rollup to a short string (email, name, title text, etc.).
function rollupItemText(item: Record<string, any>): string {
  switch (item?.type) {
    case "email": return item.email ?? "";
    case "phone_number": return item.phone_number ?? "";
    case "url": return item.url ?? "";
    case "number": return item.number == null ? "" : String(item.number);
    case "checkbox": return item.checkbox ? "true" : "false";
    case "date": return item.date?.start ?? "";
    case "select": return item.select?.name ?? "";
    case "status": return item.status?.name ?? "";
    case "multi_select": return (item.multi_select ?? []).map((o: any) => o.name).join(", ");
    case "title": return richTextToPlain(item.title);
    case "rich_text": return richTextToPlain(item.rich_text);
    case "people": return (item.people ?? []).map((u: any) => u.name ?? u.id).join(", ");
    default: return "";
  }
}

export function propertiesToValues(
  properties: Record<string, NotionPropertyResponse> | undefined,
): Record<string, NotionPropertyValue> {
  const out: Record<string, NotionPropertyValue> = {};
  for (const [name, prop] of Object.entries(properties ?? {})) {
    out[name] = propertyResponseToValue(prop);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Conversions: property values (write)

/** Convert a single writable property input into the Notion API property payload. */
export function propertyInputToNotion(input: NotionPropertyInput): unknown {
  switch (input.type) {
    case "title":
      return { title: plainToRichText(input.text) };
    case "rich_text":
      return { rich_text: plainToRichText(input.text) };
    case "number":
      return { number: input.number };
    case "select":
      return { select: input.option === null ? null : { name: input.option } };
    case "multi_select":
      return { multi_select: input.options.map(name => ({ name })) };
    case "status":
      return { status: input.status === null ? null : { name: input.status } };
    case "date":
      return {
        date: input.start === null ? null : { start: input.start, end: input.end ?? null },
      };
    case "checkbox":
      return { checkbox: input.checked };
    case "url":
      return { url: input.url };
    case "email":
      return { email: input.email };
    case "phone_number":
      return { phone_number: input.phoneNumber };
    case "people":
      return { people: input.userIds.map(id => ({ object: "user", id })) };
    case "relation":
      return { relation: input.pageIds.map(id => ({ id })) };
    case "files":
      return {
        files: input.files.map(f => ({
          name: f.name,
          type: "external",
          external: { url: f.url },
        })),
      };
  }
}

export function propertyInputsToNotion(
  properties: Record<string, NotionPropertyInput>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, input] of Object.entries(properties)) {
    out[name] = propertyInputToNotion(input);
  }
  return out;
}

/**
 * Convert a read property value back into a writable input, for capturing "previous" state so an
 * action can be reverted. Returns null for non-writable/computed types (which can't be reverted).
 */
export function propertyValueToInput(value: NotionPropertyValue): NotionPropertyInput | null {
  switch (value.type) {
    case "title":
      return { type: "title", text: value.text };
    case "rich_text":
      return { type: "rich_text", text: value.text };
    case "number":
      return { type: "number", number: value.number };
    case "select":
      return { type: "select", option: value.option };
    case "multi_select":
      return { type: "multi_select", options: value.options };
    case "status":
      return { type: "status", status: value.status };
    case "date":
      return { type: "date", start: value.start, end: value.end };
    case "checkbox":
      return { type: "checkbox", checked: value.checked };
    case "url":
      return { type: "url", url: value.url };
    case "email":
      return { type: "email", email: value.email };
    case "phone_number":
      return { type: "phone_number", phoneNumber: value.phoneNumber };
    case "people":
      return { type: "people", userIds: value.people.map(u => u.id) };
    case "relation":
      return { type: "relation", pageIds: value.pageIds };
    case "files":
      return { type: "files", files: value.files };
    default:
      return null;
  }
}

/** Convert a page's current icon (the simplified string form) into an icon input, for revert. */
export function iconStringToInput(icon: string | undefined): NotionIconInput | null {
  if (!icon) return null;
  return /^https?:\/\//i.test(icon) ? { imageUrl: icon } : { emoji: icon };
}

function propertySchemaOf(prop: NotionPropertyResponse): NotionPropertySchema {
  const p = prop as Record<string, any>;
  let options: string[] | undefined;
  if (prop.type === "select" || prop.type === "multi_select" || prop.type === "status") {
    options = (p[prop.type]?.options ?? []).map((o: any) => o.name);
  }
  // Notion returns property IDs percent-encoded (e.g. "%5EOE%40"); expose the decoded form.
  let id = prop.id;
  try {
    id = decodeURIComponent(prop.id);
  } catch {
    // Leave as-is if it isn't valid percent-encoding.
  }
  return { id, type: prop.type as NotionPropertyType, options };
}

// ---------------------------------------------------------------------------------------------
// Conversions: summaries

export function pageToSummary(page: NotionPageResponse): NotionPageSummary {
  return {
    id: page.id,
    title: titleOf(page.properties),
    url: page.url,
    icon: iconToString(page.icon),
    createdAt: new Date(page.created_time),
    lastEditedAt: new Date(page.last_edited_time),
    properties: propertiesToValues(page.properties),
  };
}

export function pageToMetadata(page: NotionPageResponse): NotionPageMetadata {
  return {
    id: page.id,
    title: titleOf(page.properties),
    url: page.url,
    icon: iconToString(page.icon),
    parent: parentToNotion(page.parent),
    createdAt: new Date(page.created_time),
    lastEditedAt: new Date(page.last_edited_time),
    createdBy: page.created_by ? userResponseToUser(page.created_by) : null,
    lastEditedBy: page.last_edited_by ? userResponseToUser(page.last_edited_by) : null,
    archived: !!(page.archived || page.in_trash),
    locked: !!page.locked,
  };
}

export function itemResponseToSummary(
  item: NotionPageResponse | NotionDatabaseResponse,
): NotionItemSummary {
  if (item.object === "database") {
    return {
      kind: "database",
      id: item.id,
      title: richTextToPlain(item.title),
      url: item.url ?? notionUrlFromId(item.id),
      icon: iconToString(item.icon),
      createdAt: new Date(item.created_time),
      lastEditedAt: new Date(item.last_edited_time),
    };
  }
  return {
    kind: "page",
    id: item.id,
    title: titleOf(item.properties),
    url: item.url,
    icon: iconToString(item.icon),
    createdAt: new Date(item.created_time),
    lastEditedAt: new Date(item.last_edited_time),
  };
}

/** Build the simplified schema from a data source (or anything exposing a Notion `properties` map). */
export function databaseSchema(source: { properties?: Record<string, NotionPropertyResponse> }): NotionDatabaseSchema {
  const properties: Record<string, NotionPropertySchema> = {};
  for (const [name, prop] of Object.entries(source.properties ?? {})) {
    properties[name] = propertySchemaOf(prop);
  }
  return { properties };
}

/** The primary (first) data source ID of a database. */
export function primaryDataSourceId(db: NotionDatabaseResponse): string {
  const id = db.data_sources?.[0]?.id;
  if (!id) {
    throw new NotionApiError(404, "This Notion database has no accessible data source.");
  }
  return id;
}

// ---------------------------------------------------------------------------------------------
// IDs

/** Build a canonical Notion URL for an object ID (accepts dashed or undashed IDs). */
export function notionUrlFromId(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}

function formatUuid(hex: string): string {
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Find a Notion ID within a string. Returns a dashed UUID, or undefined if none is present.
//
// We must NOT simply strip all hyphens and grab a 32-char run: if a slug's last word ends in a hex
// character (a–f or a digit) it would glue onto the ID and shift the window. Instead the ID is an
// explicit dashed UUID, or a 32-hex run delimited by a non-hex boundary on both sides (Notion
// separates the slug from the ID with `-`/`/`).
function findNotionId(text: string): string | undefined {
  const dashed = text.match(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g);
  if (dashed && dashed.length > 0) {
    return formatUuid(dashed[dashed.length - 1].replace(/-/g, ""));
  }
  const re = /(?:^|[^0-9a-fA-F])([0-9a-fA-F]{32})(?![0-9a-fA-F])/g;
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = re.exec(text)) !== null) last = match[1];
  return last ? formatUuid(last) : undefined;
}

/**
 * Extract a Notion object ID from a raw ID or a Notion URL. Returns a dashed UUID.
 *
 * URL handling: a "peek" URL puts the focused page ID in the `?p=` query param (the path holds the
 * containing database), so that takes precedence. Otherwise the ID is the trailing path token; the
 * rest of the query (e.g. `?v=<viewId>`) is ignored.
 */
export function parseNotionId(idOrUrl: string): string {
  const raw = idOrUrl.trim();
  let candidate = raw;
  try {
    const url = new URL(raw);
    const peek = url.searchParams.get("p");
    if (peek) {
      const fromPeek = findNotionId(peek);
      if (fromPeek) return fromPeek;
    }
    candidate = url.pathname;
  } catch {
    // Not a URL — treat the input as a raw ID.
  }

  const id = findNotionId(candidate);
  if (id) return id;

  throw new NotionApiError(400, `Could not find a Notion ID in: ${idOrUrl}`);
}

// ---------------------------------------------------------------------------------------------
// Block <-> Markdown

// Deep enough to see through column layouts (column_list -> column -> content) plus a few real
// nesting levels, while staying bounded (each level is a recursive API fetch).
const MAX_BLOCK_DEPTH = 5;

/** Convert a list of Notion blocks (with their fetched children) into Markdown. */
export function blocksToMarkdown(blocks: BlockWithChildren[], depth = 0): string {
  const lines: string[] = [];
  let numberedIndex = 0;
  for (const block of blocks) {
    const indent = "  ".repeat(depth);
    const b = block.block as Record<string, any>;
    const type = block.block.type;
    if (type === "numbered_list_item") numberedIndex += 1;
    else numberedIndex = 0;

    // Column layouts are pure structure in Notion; render their children inline at the same depth
    // (no placeholder, no extra indentation) so column content isn't lost.
    if (type === "column_list" || type === "column") {
      if (block.children && block.children.length > 0) {
        const child = blocksToMarkdown(block.children, depth);
        if (child) lines.push(child);
      } else if (block.block.has_children) {
        lines.push(indent + "_[nested content not shown]_");
      }
      continue;
    }

    switch (type) {
      case "paragraph":
        lines.push(indent + richTextToMarkdown(b.paragraph?.rich_text));
        break;
      case "heading_1":
        lines.push(indent + "# " + richTextToMarkdown(b.heading_1?.rich_text));
        break;
      case "heading_2":
        lines.push(indent + "## " + richTextToMarkdown(b.heading_2?.rich_text));
        break;
      case "heading_3":
        lines.push(indent + "### " + richTextToMarkdown(b.heading_3?.rich_text));
        break;
      case "bulleted_list_item":
        lines.push(indent + "- " + richTextToMarkdown(b.bulleted_list_item?.rich_text));
        break;
      case "numbered_list_item":
        lines.push(indent + `${numberedIndex}. ` + richTextToMarkdown(b.numbered_list_item?.rich_text));
        break;
      case "to_do":
        lines.push(
          indent + `- [${b.to_do?.checked ? "x" : " "}] ` + richTextToMarkdown(b.to_do?.rich_text),
        );
        break;
      case "quote":
        lines.push(indent + "> " + richTextToMarkdown(b.quote?.rich_text));
        break;
      case "callout":
        lines.push(indent + "> " + richTextToMarkdown(b.callout?.rich_text));
        break;
      case "toggle":
        lines.push(indent + richTextToMarkdown(b.toggle?.rich_text));
        break;
      case "code": {
        const lang = b.code?.language ?? "";
        lines.push(indent + "```" + lang);
        lines.push(richTextToMarkdown(b.code?.rich_text));
        lines.push(indent + "```");
        break;
      }
      case "divider":
        lines.push(indent + "---");
        break;
      case "child_page":
        lines.push(indent + `- [${b.child_page?.title ?? "Untitled"}](${notionUrlFromId(block.block.id)})`);
        break;
      case "child_database":
        lines.push(indent + `- [${b.child_database?.title ?? "Untitled database"}](${notionUrlFromId(block.block.id)})`);
        break;
      case "table":
        lines.push(indent + "_[table omitted — read the page in Notion]_");
        break;
      case "image":
      case "file":
      case "video":
      case "pdf":
      case "embed":
        lines.push(indent + `_[${type} omitted]_`);
        break;
      default:
        lines.push(indent + `_[unsupported block: ${type}]_`);
        break;
    }

    // Child pages/databases are rendered as links above; their bodies live in their own document,
    // so don't render (or flag) their children here.
    const isNestedDoc = type === "child_page" || type === "child_database";
    if (!isNestedDoc) {
      if (block.children && block.children.length > 0 && depth < MAX_BLOCK_DEPTH) {
        const child = blocksToMarkdown(block.children, depth + 1);
        if (child) lines.push(child);
      } else if (block.block.has_children) {
        // Children exist but weren't fetched (depth cap) — mark the gap rather than silently drop.
        lines.push("  ".repeat(depth + 1) + "_[nested content not shown]_");
      }
    }
  }
  return lines.join("\n");
}

export type BlockWithChildren = {
  block: NotionBlockResponse;
  children?: BlockWithChildren[];
};

/**
 * Parse a block of Markdown into Notion block objects suitable for append_block_children.
 * Supports a focused subset; unsupported constructs degrade to plain paragraphs.
 */
export function markdownToBlocks(markdown: string): unknown[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: unknown[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      i += 1;
      continue;
    }

    // Fenced code block.
    const fence = trimmed.match(/^```(\w*)$/);
    if (fence) {
      const lang = fence[1] || "plain text";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== "```") {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence
      blocks.push({
        object: "block",
        type: "code",
        code: { language: normalizeCodeLanguage(lang), rich_text: plainToRichText(codeLines.join("\n")) },
      });
      continue;
    }

    if (trimmed === "---" || trimmed === "***" || trimmed === "___") {
      blocks.push({ object: "block", type: "divider", divider: {} });
      i += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      // Notion only has three heading levels; clamp deeper Markdown headings to H3.
      const level = Math.min(3, heading[1].length);
      const type = `heading_${level}`;
      blocks.push({
        object: "block",
        type,
        [type]: { rich_text: inlineMarkdownToRichText(heading[2]) },
      });
      i += 1;
      continue;
    }

    const todo = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (todo) {
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: {
          checked: todo[1].toLowerCase() === "x",
          rich_text: inlineMarkdownToRichText(todo[2]),
        },
      });
      i += 1;
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: inlineMarkdownToRichText(bullet[1]) },
      });
      i += 1;
      continue;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: inlineMarkdownToRichText(numbered[1]) },
      });
      i += 1;
      continue;
    }

    const quote = trimmed.match(/^>\s+(.*)$/);
    if (quote) {
      blocks.push({
        object: "block",
        type: "quote",
        quote: { rich_text: inlineMarkdownToRichText(quote[1]) },
      });
      i += 1;
      continue;
    }

    // Default: a paragraph. Merge consecutive plain lines into one paragraph.
    const paragraphLines = [trimmed];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i].trim())) {
      paragraphLines.push(lines[i].trim());
      i += 1;
    }
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: inlineMarkdownToRichText(paragraphLines.join(" ")) },
    });
  }
  return blocks;
}

function isBlockStart(trimmed: string): boolean {
  return (
    /^(#{1,6})\s+/.test(trimmed) ||
    /^[-*]\s+/.test(trimmed) ||
    /^\d+\.\s+/.test(trimmed) ||
    /^>\s+/.test(trimmed) ||
    trimmed.startsWith("```") ||
    trimmed === "---" ||
    trimmed === "***" ||
    trimmed === "___"
  );
}

// Notion only accepts a fixed set of code-block language identifiers; fall back to plain text.
function normalizeCodeLanguage(lang: string): string {
  const known = new Set([
    "abap", "bash", "c", "c#", "c++", "css", "diff", "docker", "go", "graphql", "html", "java",
    "javascript", "json", "kotlin", "less", "lua", "makefile", "markdown", "matlab", "objective-c",
    "ocaml", "perl", "php", "plain text", "powershell", "python", "r", "ruby", "rust", "sass",
    "scala", "scss", "shell", "sql", "swift", "typescript", "xml", "yaml",
  ]);
  const normalized = lang.toLowerCase();
  const aliases: Record<string, string> = { js: "javascript", ts: "typescript", py: "python", sh: "shell", "c++": "c++", cpp: "c++", cs: "c#" };
  const resolved = aliases[normalized] ?? normalized;
  return known.has(resolved) ? resolved : "plain text";
}

// Parse a limited set of inline Markdown (bold, italic, code, strikethrough, links) into Notion
// rich text. Falls back to a plain text run when no markup is present.
function inlineMarkdownToRichText(text: string): unknown[] {
  if (!text) return [];
  const tokenRe = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\*[^*]+\*)/g;
  const out: unknown[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const pushPlain = (s: string) => {
    if (s) out.push({ type: "text", text: { content: s } });
  };
  while ((match = tokenRe.exec(text)) !== null) {
    pushPlain(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("[")) {
      const m = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      out.push({ type: "text", text: { content: m[1], link: { url: m[2] } } });
    } else if (token.startsWith("**")) {
      out.push({ type: "text", text: { content: token.slice(2, -2) }, annotations: { bold: true } });
    } else if (token.startsWith("~~")) {
      out.push({ type: "text", text: { content: token.slice(2, -2) }, annotations: { strikethrough: true } });
    } else if (token.startsWith("`")) {
      out.push({ type: "text", text: { content: token.slice(1, -1) }, annotations: { code: true } });
    } else if (token.startsWith("*")) {
      out.push({ type: "text", text: { content: token.slice(1, -1) }, annotations: { italic: true } });
    }
    lastIndex = tokenRe.lastIndex;
  }
  pushPlain(text.slice(lastIndex));
  return out.length > 0 ? out : [{ type: "text", text: { content: text } }];
}

// ---------------------------------------------------------------------------------------------
// API client

export class NotionApi {
  #getToken: () => Promise<string>;
  // Optional: rotate credentials when a request hits 401. Returns a fresh access token.
  #refresh?: () => Promise<string>;

  constructor(getToken: () => Promise<string>, refresh?: () => Promise<string>) {
    this.#getToken = getToken;
    this.#refresh = refresh;
  }

  async #request<T>(method: string, path: string, body?: unknown, version?: string): Promise<T> {
    let token = await this.#getToken();
    let response = await this.#send(method, path, token, body, version);

    // On auth failure, try once to refresh the token, then retry the request. If refresh fails
    // (e.g. no/invalid refresh token), keep the original 401 so the caller sees a clean auth error
    // — the refresh callback is responsible for notifying the Workshop of credential expiry.
    if (response.status === 401 && this.#refresh) {
      try {
        token = await this.#refresh();
        response = await this.#send(method, path, token, body, version);
      } catch {
        // fall through with the original 401 response
      }
    }

    if (!response.ok) {
      const parsed = (await response.json().catch(() => null)) as
        | { code?: string; message?: string }
        | null;
      throw new NotionApiError(
        response.status,
        parsed?.message ?? `${response.status} ${response.statusText}`,
        parsed?.code,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async #send(method: string, path: string, token: string, body: unknown, version?: string): Promise<Response> {
    const headers = new Headers({
      Accept: "application/json",
      "Notion-Version": version ?? NOTION_VERSION,
      Authorization: `Bearer ${token}`,
    });
    let payload: string | undefined;
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      payload = JSON.stringify(body);
    }
    return await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  // --- Observations ---

  async getBotUser(): Promise<NotionUser & { workspaceName?: string }> {
    const me = await this.#request<NotionUserResponse & { bot?: { workspace_name?: string } }>(
      "GET",
      "/v1/users/me",
    );
    return { ...userResponseToUser(me), workspaceName: me.bot?.workspace_name };
  }

  async retrievePage(id: string): Promise<NotionPageResponse> {
    return await this.#request<NotionPageResponse>("GET", `/v1/pages/${id}`);
  }

  /**
   * Get a database (metadata + its data_sources list). Uses the data-source-aware version so it
   * works for multi-source / Meeting Notes / wiki databases that the legacy version rejects.
   */
  async retrieveDatabase(id: string): Promise<NotionDatabaseResponse> {
    return await this.#request<NotionDatabaseResponse>(
      "GET", `/v1/databases/${id}`, undefined, DATA_SOURCE_VERSION);
  }

  /** Get a data source (its row schema lives here, including rollups). */
  async retrieveDataSource(dataSourceId: string): Promise<NotionDataSourceResponse> {
    return await this.#request<NotionDataSourceResponse>(
      "GET", `/v1/data_sources/${dataSourceId}`, undefined, DATA_SOURCE_VERSION);
  }

  /** Determine whether an ID refers to a page or a database (tries database first, then page). */
  async detectKind(id: string): Promise<NotionObjectKind> {
    try {
      await this.retrieveDatabase(id);
      return "database";
    } catch (err) {
      if (err instanceof NotionApiError && (err.status === 404 || err.status === 400)) {
        await this.retrievePage(id);
        return "page";
      }
      throw err;
    }
  }

  async search(body: {
    query?: string;
    filter?: { property: "object"; value: "page" | "database" };
    sort?: { direction: "ascending" | "descending"; timestamp: "last_edited_time" };
    start_cursor?: string;
    page_size?: number;
  }): Promise<NotionListResponse<NotionPageResponse | NotionDatabaseResponse>> {
    return await this.#request("POST", "/v1/search", body);
  }

  async queryDataSource(
    dataSourceId: string,
    body: {
      filter?: unknown;
      sorts?: unknown[];
      start_cursor?: string;
      page_size?: number;
    },
  ): Promise<NotionListResponse<NotionPageResponse>> {
    return await this.#request(
      "POST", `/v1/data_sources/${dataSourceId}/query`, body, DATA_SOURCE_VERSION);
  }

  async listBlockChildren(
    blockId: string,
    startCursor?: string,
    pageSize?: number,
  ): Promise<NotionListResponse<NotionBlockResponse>> {
    const params = new URLSearchParams();
    if (startCursor) params.set("start_cursor", startCursor);
    if (pageSize) params.set("page_size", String(pageSize));
    const qs = params.toString();
    return await this.#request("GET", `/v1/blocks/${blockId}/children${qs ? `?${qs}` : ""}`);
  }

  async retrieveUser(id: string): Promise<NotionUser> {
    return userResponseToUser(await this.#request<NotionUserResponse>("GET", `/v1/users/${id}`));
  }

  async listUsers(
    startCursor?: string,
    pageSize?: number,
  ): Promise<NotionListResponse<NotionUserResponse>> {
    const params = new URLSearchParams();
    if (startCursor) params.set("start_cursor", startCursor);
    if (pageSize) params.set("page_size", String(pageSize));
    const qs = params.toString();
    return await this.#request("GET", `/v1/users${qs ? `?${qs}` : ""}`);
  }

  async listComments(
    blockId: string,
    startCursor?: string,
    pageSize?: number,
  ): Promise<NotionListResponse<{ id: string; rich_text: NotionRichText[]; created_time: string; created_by?: NotionUserResponse }>> {
    const params = new URLSearchParams({ block_id: blockId });
    if (startCursor) params.set("start_cursor", startCursor);
    if (pageSize) params.set("page_size", String(pageSize));
    return await this.#request("GET", `/v1/comments?${params.toString()}`);
  }

  /** Recursively fetch a page's blocks and their children up to MAX_BLOCK_DEPTH. */
  async fetchBlockTree(blockId: string, depth = 0): Promise<BlockWithChildren[]> {
    const out: BlockWithChildren[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listBlockChildren(blockId, cursor);
      for (const block of page.results) {
        const node: BlockWithChildren = { block };
        // Don't descend into child pages/databases — those are separate documents, not inline
        // content. Their bodies would otherwise be duplicated into this page's Markdown.
        const isNestedDoc = block.type === "child_page" || block.type === "child_database";
        if (block.has_children && !isNestedDoc && depth < MAX_BLOCK_DEPTH) {
          node.children = await this.fetchBlockTree(block.id, depth + 1);
        }
        out.push(node);
      }
      cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
    } while (cursor);
    return out;
  }

  // --- Actions ---

  async createPage(body: unknown): Promise<NotionPageResponse> {
    return await this.#request<NotionPageResponse>("POST", "/v1/pages", body);
  }

  async updatePage(id: string, body: unknown): Promise<NotionPageResponse> {
    return await this.#request<NotionPageResponse>("PATCH", `/v1/pages/${id}`, body);
  }

  /** Appends children and returns the IDs of the newly created top-level blocks (used to revert). */
  async appendBlockChildren(blockId: string, children: unknown[]): Promise<string[]> {
    const result = await this.#request<NotionListResponse<NotionBlockResponse>>(
      "PATCH",
      `/v1/blocks/${blockId}/children`,
      { children },
    );
    return result.results.map(b => b.id);
  }

  /** Archives (deletes) a single block. Used to revert appendContent. */
  async deleteBlock(blockId: string): Promise<void> {
    await this.#request("DELETE", `/v1/blocks/${blockId}`);
  }

  async createComment(body: unknown): Promise<void> {
    await this.#request("POST", "/v1/comments", body);
  }
}

/** Map a comment response into the simplified shape. */
export function commentToNotion(c: {
  id: string;
  rich_text: NotionRichText[];
  created_time: string;
  created_by?: NotionUserResponse;
}): NotionComment {
  return {
    id: c.id,
    text: richTextToPlain(c.rich_text),
    author: c.created_by ? userResponseToUser(c.created_by) : null,
    createdAt: new Date(c.created_time),
  };
}

export { iconInputToNotion, plainToRichText, userResponseToUser };
