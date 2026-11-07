import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { displayText } from "@gadgets/configurator-ui/options";
import { BigQueryApi, BigQueryApiError } from "./bigquery-api";
import type { BigQueryDataset, BigQueryProject, BigQueryTable } from "./bigquery-types";
import { GoogleCalendarApi } from "./calendar-api";
import { ChatApi, chatSpaceIdFromReference, isChatNoAccessError } from "./chat-api";
import type { ChatSpaceInfo } from "./chat-types";
import { GoogleAccessToken } from "./google-api";
import { AccessTokenProvider, AccessTokenRequest } from "./auth-retry";
import {
  DriveApi, DriveApiDisabledError, FOLDER_MIME_TYPE, SHORTCUT_MIME_TYPE, isFileInvisible,
  isListableFolderFile, isListableFolderNode, type DriveFile, type DriveFileList, type DriveScopeNode,
} from "./drive-api";
import type {
  BigQueryConfiguratorRpc, BigQueryNode, BigQueryNodeKind, BigQueryNodePage,
} from "./configurator/bigquery-configurator-types";
import type { CalendarConfiguratorRpc } from "./configurator/calendar-configurator-types";
import type { GmailConfiguratorRpc } from "./configurator/gmail-configurator-types";
import type { ConfiguratorOption } from "./configurator/configurator-option";
import {
  editorKind, OFFICE_KINDS, OfficeConversion, type OfficeConversionResult, type OfficeFileInspection,
  type OfficeKind,
} from "./office-conversion";
import type {
  ChatAccountConfiguratorRpc,
} from "./configurator/chat-account-configurator-types";
import type { ChatSpaceConfiguratorRpc } from "./configurator/chat-space-configurator-types";
import type { ChatThreadConfiguratorRpc } from "./configurator/chat-thread-configurator-types";
import type {
  DriveConfiguratorRpc, DriveNode, DriveNodeAncestor, DriveNodePage,
} from "./configurator/drive-configurator-types";
import { BIGQUERY_HOST, OFFICE_IMPORT_GRANT, parseResourceUrl, SHARED_DRIVES_GRANT } from "./resources";

/**
 * Mints an access token for a configurator, forwarding `AccessTokenRequest` to the `UserAccount`
 * so a client built on it can heal a 401 by asking for a fresh one.
 */
type ConfiguratorTokenGetter = (opts?: AccessTokenRequest) => Promise<GoogleAccessToken>;

const googleTokenGetters = new WeakMap<object, ConfiguratorTokenGetter>();
const grantChecks = new WeakMap<object, (grant: string) => Promise<boolean>>();
const calendarConfiguratorCaches = new WeakMap<object, Promise<ConfiguratorOption[]>>();
const bigQueryConfiguratorCaches = new WeakMap<object, Map<string, Promise<unknown>>>();
const BIGQUERY_CONFIGURATOR_CACHE_MAX_ENTRIES = 200;
const BIGQUERY_CONFIGURATOR_LIST_OPTIONS = { maxPages: 5, maxResults: 1000 };
/** Must equal `ROOT_ID` in configurator/bigquery-configurator-ui.tsx. */
const BIGQUERY_ROOT_ID = "bigquery";

function googleToken(target: object, opts?: AccessTokenRequest): Promise<GoogleAccessToken> {
  let getToken = googleTokenGetters.get(target);
  if (!getToken) throw new Error("Google configurator is not initialized.");
  return getToken(opts);
}

/** A provider that re-asks on every call, so `fetchWithAuthRetry` can refresh a rejected token. */
function googleTokenProvider(target: object): AccessTokenProvider {
  return async opts => (await googleToken(target, opts)).token;
}

async function withDriveApiEnabled<T>(
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DriveApiDisabledError) {
      throw new Error(message, { cause: error });
    }
    throw error;
  }
}

async function bigQueryApi(target: object): Promise<BigQueryApi> {
  return new BigQueryApi(googleTokenProvider(target));
}

async function calendarApi(target: object): Promise<GoogleCalendarApi> {
  return new GoogleCalendarApi(googleTokenProvider(target));
}

/**
 * Answers a BigQuery picker request once per frame: the picker asks again for a location it returns
 * to, and the same project list stands behind every lookup. A failed request is asked again.
 */
function cachedBigQuery<T>(target: object, key: string, load: () => Promise<T>): Promise<T> {
  let cache = bigQueryConfiguratorCaches.get(target);
  if (!cache) {
    cache = new Map();
    bigQueryConfiguratorCaches.set(target, cache);
  }
  let cached = cache.get(key);
  if (cached) return cached as Promise<T>;
  if (cache.size >= BIGQUERY_CONFIGURATOR_CACHE_MAX_ENTRIES) {
    let oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  let result = load();
  result.catch(() => cache.delete(key));
  cache.set(key, result);
  return result;
}

function optionMatches(parts: (string | undefined)[], query: string): boolean {
  let lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) return true;
  let corpus = parts.filter(Boolean).join(" ").toLowerCase();
  return lowerQuery.split(/\s+/).every(term => corpus.includes(term));
}

/**
 * When two names would look the same in the picker. First the name as the configurator runtime
 * shows it, so any two the runtime shows identically match; then folded further, past what the
 * runtime strips, because a false match costs only an ID tail.
 */
function sameNameKey(title: string): string {
  return (displayText(title) ?? "").normalize("NFKC").replace(/[\p{C}\p{Z}]/gu, "").toLowerCase();
}

/**
 * Adds the tail of a Drive ID to each node whose name looks like another's in the same page, which
 * is enough to tell them apart. Duplicate names are ordinary, and a node's other columns can match
 * too, so without it the user cannot see which capability they are granting; a distinct name needs
 * no ID.
 */
function tellApartSameNamed(nodes: DriveNode[]): DriveNode[] {
  let keys = nodes.map(node => sameNameKey(node.title));
  let counts = new Map<string, number>();
  for (let key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return nodes.map((node, index) => {
    if (counts.get(keys[index])! < 2) return node;
    let id = parseDriveNodeId(node.id)?.fileId ?? node.id;
    let tail = id.length > 8 ? `…${id.slice(-8)}` : id;
    return { ...node, detail: node.detail ? `${node.detail} · ${tail}` : tail };
  });
}

/** A person's email address, which the picker resolves to the direct message with them. */
const CHAT_EMAIL_RE = /^[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function chatSpaceOption(space: ChatSpaceInfo, title = space.name): ConfiguratorOption {
  const kind = space.type === "directMessage" ? "Direct message"
    : space.type === "groupChat" ? "Group chat" : "Space";
  return {
    value: space.id.slice("spaces/".length),
    title: title ?? kind,
    subtitle: space.lastActiveAt ? `${kind} · Active ${space.lastActiveAt.toLocaleDateString()}` : kind,
  };
}

// RPC interface exposed by Gatekeeper to the resource selection/configuration iframe.
@validateRpc()
export class GmailConfiguratorUI extends RpcTarget implements GmailConfiguratorRpc {}

// RPC interface exposed by Gatekeeper to the resource selection/configuration iframe.
@validateRpc()
export class CalendarConfiguratorUI extends RpcTarget implements CalendarConfiguratorRpc {
  constructor(getToken: () => Promise<GoogleAccessToken>) {
    super();
    googleTokenGetters.set(this, getToken);
  }

  async getPrimaryCalendarId(): Promise<string> {
    let api = await calendarApi(this);
    let calendarId = (await api.getCalendar("primary")).id;
    if (!calendarId || calendarId === "primary") {
      throw new Error("Google Calendar did not return a stable primary calendar ID.");
    }
    return calendarId;
  }

  async canWriteCalendar(calendarId: string): Promise<boolean> {
    return (await calendarApi(this)).canWriteCalendar(calendarId);
  }

  async listCalendars(query: string): Promise<ConfiguratorOption[]> {
    let options = calendarConfiguratorCaches.get(this);
    if (!options) {
      options = (async () => {
        let api = await calendarApi(this);
        let calendars = await api.listCalendars({ maxResults: 250 });
        return calendars.map(calendar => ({
          value: calendar.id,
          title: calendar.summary,
          subtitle: calendar.primary ? "Primary calendar" : calendar.id,
          meta: calendar.accessRole,
        }));
      })();
      // Don't let a transient API error poison the cache permanently.
      options.catch(() => calendarConfiguratorCaches.delete(this));
      calendarConfiguratorCaches.set(this, options);
    }
    let resolved = await options;
    return resolved.filter(option => optionMatches([option.title, option.subtitle, option.value], query));
  }
}

type BigQueryNodeRef = { kind: BigQueryNodeKind; projectId: string; datasetId?: string; tableId?: string };

/** `<kind>:<project>[/<dataset>[/<table>]]`; must mirror `idOf` in configurator/bigquery-configurator-ui.tsx. */
function bigQueryNodeId({ kind, projectId, datasetId, tableId }: BigQueryNodeRef): string {
  return `${kind}:${[projectId, datasetId, tableId].filter(Boolean).join("/")}`;
}

function parseBigQueryNodeId(id: string): BigQueryNodeRef | undefined {
  let colon = id.indexOf(":");
  if (colon < 0) return undefined;
  let kind = id.slice(0, colon);
  let [projectId, datasetId, tableId, ...rest] = id.slice(colon + 1).split("/");
  if (!projectId || rest.length > 0) return undefined;
  if (kind === "project" && datasetId === undefined) return { kind, projectId };
  if (kind === "dataset" && datasetId && tableId === undefined) return { kind, projectId, datasetId };
  if (kind === "table" && datasetId && tableId) return { kind, projectId, datasetId, tableId };
  return undefined;
}

/**
 * `project.dataset.table`, `project.dataset` or a project ID, as BigQuery writes them, where a legacy
 * project ID carries a domain (`example.com:proj`). Dataset and table IDs are BigQuery identifiers.
 */
const BIGQUERY_REFERENCE_RE =
  /^((?:[a-z0-9][a-z0-9.-]*:)?[a-z0-9][a-z0-9-]*)(?:\.([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?)?$/i;

const kindOf = (datasetId?: string, tableId?: string): BigQueryNodeKind =>
  tableId ? "table" : datasetId ? "dataset" : "project";

/**
 * What typing into the picker's search names, when it names a place rather than searches for one: a
 * connection's URL, a Cloud Console link (`?p=<project>&d=<dataset>&t=<table>`), a node id or a
 * reference. `explicit` is false for a bare word, which is as likely a search as a project ID.
 */
function linkedBigQueryNodeRef(input: string): { ref: BigQueryNodeRef; explicit: boolean } | undefined {
  let text = input.trim().replace(/^`(.*)`$/, "$1");
  if (!text) return undefined;
  if (URL.canParse(text)) {
    let url = new URL(text);
    if (url.hostname === BIGQUERY_HOST) {
      try {
        let target = parseResourceUrl(text);
        if (target.kind !== "bigquery") return undefined;
        let { projectId, datasetId, tableId } = target;
        return { ref: { kind: kindOf(datasetId, tableId), projectId, datasetId, tableId }, explicit: true };
      } catch {
        return undefined;
      }
    }
    if (url.hostname === "console.cloud.google.com" && url.pathname.startsWith("/bigquery")) {
      let projectId = url.searchParams.get("p");
      let datasetId = url.searchParams.get("d") ?? undefined;
      let tableId = datasetId ? url.searchParams.get("t") ?? undefined : undefined;
      return projectId ? { ref: { kind: kindOf(datasetId, tableId), projectId, datasetId, tableId }, explicit: true } : undefined;
    }
    return undefined;
  }
  let node = parseBigQueryNodeId(text);
  if (node) return { ref: node, explicit: true };
  let match = BIGQUERY_REFERENCE_RE.exec(text);
  if (!match) return undefined;
  let [, projectId, datasetId, tableId] = match;
  return { ref: { kind: kindOf(datasetId, tableId), projectId, datasetId, tableId }, explicit: datasetId !== undefined };
}

/** BigQuery's answers for what this account cannot see: denied (which also hides existence), unknown, or not a project. */
function isBigQueryNotVisible(error: unknown): boolean {
  return error instanceof BigQueryApiError &&
    (error.status === 404 || error.status === 400 || (error.status === 403 && error.reason === "accessDenied"));
}

const BIGQUERY_TABLE_KINDS: Record<string, string> = {
  VIEW: "View", MATERIALIZED_VIEW: "Materialized view", EXTERNAL: "External table", SNAPSHOT: "Snapshot",
};

const bigQueryProjectCrumb = (projectId: string) =>
  ({ id: bigQueryNodeId({ kind: "project", projectId }), kind: "project" as const, title: projectId });
const bigQueryDatasetCrumb = (projectId: string, datasetId: string) =>
  ({ id: bigQueryNodeId({ kind: "dataset", projectId, datasetId }), kind: "dataset" as const, title: datasetId });

function bigQueryProjectNode(project: BigQueryProject, listed: boolean): BigQueryNode {
  return {
    id: bigQueryNodeId({ kind: "project", projectId: project.projectId }), kind: "project",
    title: project.projectId, subtitle: project.friendlyName, listed,
  };
}

function bigQueryDatasetNode(dataset: BigQueryDataset, listed: boolean): BigQueryNode {
  return {
    id: bigQueryNodeId({ kind: "dataset", projectId: dataset.projectId, datasetId: dataset.datasetId }), kind: "dataset",
    title: dataset.datasetId, subtitle: dataset.friendlyName ?? dataset.description, listed,
    path: [bigQueryProjectCrumb(dataset.projectId)],
  };
}

function bigQueryTableNode(table: BigQueryTable, listed: boolean): BigQueryNode {
  return {
    id: bigQueryNodeId({ kind: "table", projectId: table.projectId, datasetId: table.datasetId, tableId: table.tableId }),
    kind: "table", title: table.tableId, subtitle: BIGQUERY_TABLE_KINDS[table.type], listed,
    path: [bigQueryProjectCrumb(table.projectId), bigQueryDatasetCrumb(table.projectId, table.datasetId)],
  };
}

const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title);

// RPC interface exposed by Gatekeeper to the resource selection/configuration iframe.
@validateRpc()
export class BigQueryConfiguratorUI extends RpcTarget implements BigQueryConfiguratorRpc {
  constructor(getToken: () => Promise<GoogleAccessToken>) {
    super();
    googleTokenGetters.set(this, getToken);
  }

  /** The projects BigQuery lists for this account, by id: those it holds a role in. */
  #heldProjects(): Promise<Map<string, BigQueryProject>> {
    return cachedBigQuery(this, "projects", async () => {
      let api = await bigQueryApi(this);
      let projects = await api.listProjects(BIGQUERY_CONFIGURATOR_LIST_OPTIONS);
      return new Map(projects.map(project => [project.projectId, project]));
    });
  }

  async listProjects(query: string): Promise<ConfiguratorOption[]> {
    let projects = [...(await this.#heldProjects()).values()];
    return projects
      .filter(project => optionMatches([project.projectId, project.friendlyName, project.numericId], query))
      .toSorted((a, b) => a.projectId.localeCompare(b.projectId))
      .slice(0, 100)
      .map(project => ({ value: project.projectId, title: project.projectId, subtitle: project.friendlyName }));
  }

  async listNodes(parentId: string, query: string): Promise<BigQueryNodePage> {
    let linked = linkedBigQueryNodeRef(query);
    if (linked?.explicit) {
      let node = await this.#node(linked.ref);
      return node ? { nodes: [node] } : { nodes: [], notice: "This account can't see what that names, or it doesn't exist." };
    }
    let nodes = await this.#children(parentId);
    let matching = nodes.filter(node => optionMatches([node.title, node.subtitle], query));
    // A project the account holds no role in is never listed, but BigQuery still answers for it
    // when a dataset in it was shared with the account, so a project ID nothing listed matches is
    // looked up.
    if (matching.length === 0 && linked && parentId === BIGQUERY_ROOT_ID) {
      let node = await this.#node(linked.ref);
      if (node) return { nodes: [node] };
    }
    return { nodes: matching };
  }

  async getNode(id: string): Promise<BigQueryNode | null> {
    let ref = parseBigQueryNodeId(id);
    return ref ? this.#node(ref) : null;
  }

  #children(parentId: string): Promise<BigQueryNode[]> {
    return cachedBigQuery(this, `children:${parentId}`, async () => {
      if (parentId === BIGQUERY_ROOT_ID) {
        return [...(await this.#heldProjects()).values()].map(project => bigQueryProjectNode(project, true)).toSorted(byTitle);
      }
      let ref = parseBigQueryNodeId(parentId);
      if (!ref || ref.kind === "table") throw new Error("Unknown BigQuery location.");
      let api = await bigQueryApi(this);
      let listed = (await this.#heldProjects()).has(ref.projectId);
      if (ref.kind === "project") {
        let datasets = await api.listDatasets(ref.projectId, BIGQUERY_CONFIGURATOR_LIST_OPTIONS);
        return datasets.map(dataset => bigQueryDatasetNode(dataset, listed)).toSorted(byTitle);
      }
      let tables = await api.listTables(ref.projectId, ref.datasetId!, BIGQUERY_CONFIGURATOR_LIST_OPTIONS);
      return tables.map(table => bigQueryTableNode(table, listed)).toSorted(byTitle);
    });
  }

  /** The node `ref` names, asked of BigQuery, or null when this account cannot see it. */
  #node(ref: BigQueryNodeRef): Promise<BigQueryNode | null> {
    return cachedBigQuery(this, `node:${bigQueryNodeId(ref)}`, async () => {
      let held = await this.#heldProjects();
      let listed = held.has(ref.projectId);
      let api = await bigQueryApi(this);
      try {
        if (ref.kind === "project") {
          let project = held.get(ref.projectId);
          if (project) return bigQueryProjectNode(project, true);
          // Listing a project's datasets needs no role in it: one that was shared a dataset sees that
          // dataset, and a project the account cannot see at all refuses.
          await api.listDatasets(ref.projectId, { maxPages: 1, maxResults: 1 });
          return bigQueryProjectNode({ projectId: ref.projectId }, false);
        }
        if (ref.kind === "dataset") {
          return bigQueryDatasetNode(await api.getDataset(ref.projectId, ref.datasetId!), listed);
        }
        let { table } = await api.getTable(ref.projectId, ref.datasetId!, ref.tableId!);
        return bigQueryTableNode(table, listed);
      } catch (error) {
        if (isBigQueryNotVisible(error)) return null;
        throw error;
      }
    });
  }
}

// RPC interface exposed by Gatekeeper to the resource selection/configuration iframe.
@validateRpc()
export class ChatAccountConfiguratorUI extends RpcTarget implements ChatAccountConfiguratorRpc {}

// RPC interface exposed by Gatekeeper to the resource selection/configuration iframe.
@validateRpc()
export class ChatThreadConfiguratorUI extends RpcTarget implements ChatThreadConfiguratorRpc {}

// RPC interface exposed by Gatekeeper to the resource selection/configuration iframe.
@validateRpc()
export class ChatSpaceConfiguratorUI extends RpcTarget implements ChatSpaceConfiguratorRpc {
  constructor(getToken: () => Promise<GoogleAccessToken>) {
    super();
    googleTokenGetters.set(this, getToken);
  }

  /**
   * Named conversations this account has joined, matched by name, or the direct message with a
   * person given by email.
   *
   * Chat's own space search only matches named spaces, so scan a bounded five provider pages
   * instead, stopping once the picker has its 100 visible options. DMs and most group chats have
   * no name of their own, and naming them costs a membership read each, so they are reached only
   * by email or by pasting a link.
   */
  async listChatSpaces(query: string): Promise<ConfiguratorOption[]> {
    const api = new ChatApi(googleTokenProvider(this));
    const options: ConfiguratorOption[] = [];
    const email = query.trim();
    if (CHAT_EMAIL_RE.test(email)) {
      const dm = await api.findDirectMessage(email);
      return dm ? [chatSpaceOption(dm, email)] : [];
    }
    // Exact references bypass the bounded discovery scan, including conversations on later pages.
    const exact = chatSpaceIdFromReference(query);
    if (exact !== undefined) {
      try {
        const space = await api.getSpace(`spaces/${exact}`);
        return [chatSpaceOption(space)];
      } catch (error) {
        if (isChatNoAccessError(error)) return [];
        throw error;
      }
    }
    let pageToken: string | undefined;
    for (let pageNumber = 0; pageNumber < 5 && options.length < 100; pageNumber++) {
      const page = await api.listSpaces({ pageSize: query.trim() ? 200 : 100, ...(pageToken ? { pageToken } : {}) });
      options.push(...page.items
        .filter(space => space.name && optionMatches([space.name], query))
        .map(space => chatSpaceOption(space)));
      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
    return options.slice(0, 100);
  }
}

/** The whole account's node in the Drive picker, which binds everything the account can read. */
const DRIVE_ROOT_ID = "drive";
const SHARED_DRIVES: DriveNodeAncestor = { id: "shared-drives", title: "Shared drives" };
const SHARED_WITH_ME: DriveNodeAncestor = { id: "shared-with-me", title: "Shared with me" };
const RECENT: DriveNodeAncestor = { id: "recent", title: "Recent" };
const DRIVE_PAGE_SIZE = 100;
/** Bounds the walk up a pre-filled node's ancestors, which costs one request per level. */
const MAX_DRIVE_PATH_DEPTH = 20;
const DRIVE_BROWSE_DISABLED =
  "Browsing Drive requires the Google Drive API to be enabled for this OAuth project.";

type DriveNodeKind = "folder" | "file" | OfficeKind;
const DRIVE_NODE_ID = new RegExp(`^(folder|file|${Object.keys(OFFICE_KINDS).join("|")}):(.+)$`, "s");

/** The Drive file a folder or file node names. Groupings and the root name none. */
function parseDriveNodeId(id: string): { kind: DriveNodeKind; fileId: string } | undefined {
  let match = DRIVE_NODE_ID.exec(id);
  return match ? { kind: match[1] as DriveNodeKind, fileId: match[2] } : undefined;
}

/** My Drive's root folder id, read afresh: Allow access may reconnect the account as someone else. */
async function myDriveId(drive: DriveApi): Promise<string> {
  return (await drive.getFile("root")).id;
}

/**
 * The picker's node for a listed file. A shortcut stands for its target, as read into `targets`, and
 * outlives it: one whose target is gone, trashed or out of reach is left out. A native Docs, Sheets
 * or Slides file, or an Office file one converts, is named by that kind, which it connects as.
 */
function driveFileNode(
  file: DriveFile, detail?: string, targets?: ReadonlyMap<string, DriveScopeNode | undefined>,
): DriveNode | undefined {
  let { id, mimeType } = file;
  let listable = file.capabilities?.canListChildren === true;
  if (mimeType === SHORTCUT_MIME_TYPE) {
    let targetId = file.shortcutDetails?.targetId;
    let target = targetId ? targets?.get(targetId) : undefined;
    if (target?.trashed !== false) return undefined;
    id = target.id;
    mimeType = target.mimeType;
    // Judged as a folder binding is, so a folder shortcut is offered only when it would connect.
    listable = isListableFolderNode(target);
  }
  let shown = {
    title: file.name,
    ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
    ...(detail ? { detail } : {}),
  };
  if (mimeType === FOLDER_MIME_TYPE) return { id: `folder:${id}`, kind: "folder", listable, ...shown };
  let size = file.size === undefined ? NaN : Number(file.size);
  return {
    id: `${editorKind(mimeType) ?? "file"}:${id}`, kind: "file", ...(mimeType ? { mimeType } : {}), ...shown,
    ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
  };
}

function drivePage(nodes: DriveNode[], nextPageToken: string | undefined): DriveNodePage {
  return { nodes: tellApartSameNamed(nodes), ...(nextPageToken ? { nextCursor: nextPageToken } : {}) };
}

/** A page of listed files. A listing carries nothing of a shortcut's target, so they are read in one batch. */
async function driveFilePage(
  drive: DriveApi,
  { files, nextPageToken }: DriveFileList,
  detail?: (file: DriveFile) => string,
): Promise<DriveNodePage> {
  let targetIds = files.flatMap(file => file.shortcutDetails?.targetId || []);
  let read = await drive.getScopeNodes(targetIds);
  let targets = new Map(targetIds.map((id, index) => [id, read[index]] as const));
  return drivePage(files.flatMap(file => driveFileNode(file, detail?.(file), targets) ?? []), nextPageToken);
}

/**
 * A file's ancestors up to the whole account, outermost first. Undefined when one is out of reach
 * (shared from a folder this account cannot see) or the walk is too deep, since a partial path
 * would misstate where the file lives. My Drive's root is read only for a path that could end there.
 */
async function drivePath(drive: DriveApi, file: DriveFile): Promise<DriveNodeAncestor[] | undefined> {
  let ancestors: DriveFile[] = [];
  let top = file;
  for (let parentId = top.parents?.[0]; parentId; parentId = top.parents?.[0]) {
    if (ancestors.length === MAX_DRIVE_PATH_DEPTH) return undefined;
    try {
      top = await drive.getFile(parentId);
    } catch (error) {
      if (isFileInvisible(error)) return undefined;
      throw error;
    }
    ancestors.unshift(top);
  }
  // Judged as `readFolderRoot` judges a folder binding, so the picker offers only folders that connect.
  let folders = ancestors.map(folder =>
    ({ id: `folder:${folder.id}`, title: folder.name, listable: isListableFolderFile(folder) }));
  if (top.driveId === top.id) return [SHARED_DRIVES, ...folders];
  if (top.driveId === undefined && top.id === await myDriveId(drive)) {
    return folders.map((folder, index) => index === 0 ? { ...folder, title: "My Drive" } : folder);
  }
  return undefined;
}

/**
 * The picker's id for the folder or file a pasted Drive, Docs, Sheets or Slides link names, read as
 * a resource URL is once the index a browser signed in to several accounts adds (`/u/1/`) is
 * dropped. Undefined for anything else, which is searched for by name.
 */
function linkedDriveNodeId(text: string): string | undefined {
  let url = URL.parse(text.trim());
  if (!url) return undefined;
  url.pathname = url.pathname.replace(/\/u\/\d+\//, "/");
  let target;
  try {
    target = parseResourceUrl(url.href);
  } catch {
    return undefined;
  }
  switch (target.kind) {
    case "driveFolder": return `folder:${target.folderId}`;
    case "driveFile": return `file:${target.fileId}`;
    case "doc": return `doc:${target.documentId}`;
    case "sheets": return `sheets:${target.spreadsheetId}`;
    case "slides": return `slides:${target.presentationId}`;
    default: return undefined;
  }
}

@validateRpc()
export class DriveConfiguratorUI extends RpcTarget implements DriveConfiguratorRpc {
  /** `holds` says whether the account holds a grant, asked afresh: one can arrive while the picker is open. */
  constructor(getToken: () => Promise<GoogleAccessToken>, holds: (grant: string) => Promise<boolean>) {
    super();
    googleTokenGetters.set(this, getToken);
    grantChecks.set(this, holds);
  }

  /**
   * Search spans My Drive, "Shared with me" and every shared drive, wherever the picker is open;
   * a folder's listing spans them too, since its id does not say which it lives in. A pasted link
   * is answered with the node the picker would list for what it names.
   */
  async listDriveNodes(parentId: string, query: string, cursor: string | null): Promise<DriveNodePage> {
    let linked = linkedDriveNodeId(query);
    if (linked) {
      let node = await driveNode(this, linked);
      return { nodes: node ? [node] : [] };
    }
    let drive = new DriveApi(googleTokenProvider(this));
    let page = { pageSize: DRIVE_PAGE_SIZE, ...(cursor ? { pageToken: cursor } : {}) };
    return withDriveApiEnabled<DriveNodePage>(DRIVE_BROWSE_DISABLED, async () => {
      if (query.trim()) {
        return driveFilePage(drive,
          await drive.listFiles({ ...page, namePrefix: query, corpus: { kind: "allDrives" } }),
          file => file.driveId
            ? "In a shared drive"
            : file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress ?? "My Drive");
      }
      if (parentId === DRIVE_ROOT_ID) {
        let myDrive = await myDriveId(drive);
        return {
          nodes: [
            { id: `folder:${myDrive}`, title: "My Drive", kind: "folder", listable: true },
            { ...SHARED_DRIVES, kind: "group" },
            { ...SHARED_WITH_ME, kind: "group" },
            { ...RECENT, kind: "group" },
          ],
        };
      }
      if (parentId === SHARED_DRIVES.id) {
        // Drive lists shared drives only under a wider grant than browsing needs, so the picker asks
        // for it when the user first opens them.
        if (!(await grantChecks.get(this)!(SHARED_DRIVES_GRANT))) {
          return { nodes: [], needsGrant: SHARED_DRIVES_GRANT };
        }
        let { drives, nextPageToken } = await drive.listSharedDrives(page);
        return drivePage(
          drives.map(({ id, name }) => ({ id: `folder:${id}`, title: name, kind: "sharedDrive" })),
          nextPageToken);
      }
      if (parentId === SHARED_WITH_ME.id) {
        return driveFilePage(drive,
          await drive.listFiles({ ...page, sharedWithMe: true, orderBy: "folder,name" }));
      }
      if (parentId === RECENT.id) {
        // Files the account created, opened or had shared with it, newest first, as Drive's Recent
        // shows them. Folders are browsed, so Drive leaves them out before paging, where they could
        // empty a page; a shortcut to one is dropped once resolved.
        let recent = await driveFilePage(drive, await drive.listFiles({ ...page, excludeFolders: true }));
        return { ...recent, nodes: recent.nodes.filter(node => node.kind === "file") };
      }
      let folder = parseDriveNodeId(parentId);
      if (folder?.kind !== "folder") throw new Error("Unknown Drive location.");
      return driveFilePage(drive, await drive.listFiles({
        ...page, directParentIds: [folder.fileId], corpus: { kind: "allDrives" }, orderBy: "folder,name",
      }));
    });
  }

  /** A Drive file link (`file:`) keeps its id for a pre-fill, and so binds as a Drive file. */
  async getDriveNode(id: string): Promise<DriveNode | null> {
    let node = await driveNode(this, id);
    return node && parseDriveNodeId(id)?.kind === "file" ? { ...node, id } : node;
  }

  async inspectFile(kind: OfficeKind, fileId: string): Promise<OfficeFileInspection> {
    return officeConversion(this, kind).inspectFile(fileId);
  }

  async hasConversionAccess(): Promise<boolean> {
    return grantChecks.get(this)!(OFFICE_IMPORT_GRANT);
  }

  async convertFile(kind: OfficeKind, fileId: string, opts?: { reuse?: string }): Promise<OfficeConversionResult> {
    return officeConversion(this, kind).convertFile(fileId, opts);
  }
}

function officeConversion(picker: DriveConfiguratorUI, kind: OfficeKind): OfficeConversion {
  return new OfficeConversion(kind, googleTokenProvider(picker), () => grantChecks.get(picker)!(OFFICE_IMPORT_GRANT));
}

/**
 * The node the picker would list for what `id` names, or null when this account cannot see it or it
 * is another kind of node. A Drive file link (`file:`) names any file.
 */
async function driveNode(picker: DriveConfiguratorUI, id: string): Promise<DriveNode | null> {
  let named = parseDriveNodeId(id);
  if (!named) return null;
  let drive = new DriveApi(googleTokenProvider(picker));
  return withDriveApiEnabled<DriveNode | null>(DRIVE_BROWSE_DISABLED, async () => {
    let file: DriveFile;
    try {
      file = await drive.getFile(named.fileId);
    } catch (error) {
      if (isFileInvisible(error)) return null;
      throw error;
    }
    // A folder named as a file, or a shortcut, is not the node the id claims.
    let node = file.trashed ? undefined : driveFileNode(file);
    if (!node) return null;
    if (node.id !== id && (named.kind !== "file" || node.kind !== "file")) return null;
    let path = await drivePath(drive, file);
    return path ? { ...node, path } : node;
  });
}
