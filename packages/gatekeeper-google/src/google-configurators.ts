import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { BigQueryApi } from "./bigquery-api";
import { GoogleCalendarApi } from "./calendar-api";
import { ChatApi, chatSpaceIdFromReference, isChatNoAccessError } from "./chat-api";
import type { ChatSpaceInfo } from "./chat-types";
import { GoogleAccessToken } from "./google-api";
import { AccessTokenProvider, AccessTokenRequest } from "./auth-retry";
import { DriveApi, DriveApiDisabledError, FOLDER_MIME_TYPE } from "./drive-api";
import type { BigQueryConfiguratorRpc } from "./configurator/bigquery-configurator-types";
import type { CalendarConfiguratorRpc } from "./configurator/calendar-configurator-types";
import type { GmailConfiguratorRpc } from "./configurator/gmail-configurator-types";
import type { GoogleDocConfiguratorRpc } from "./configurator/google-doc-configurator-types";
import type { GoogleSheetsConfiguratorRpc } from "./configurator/google-sheets-configurator-types";
import type { GoogleSlidesConfiguratorRpc } from "./configurator/google-slides-configurator-types";
import type { ConfiguratorOption } from "./configurator/configurator-option";
import type {
  ChatAccountConfiguratorRpc,
} from "./configurator/chat-account-configurator-types";
import type { ChatSpaceConfiguratorRpc } from "./configurator/chat-space-configurator-types";
import type { ChatThreadConfiguratorRpc } from "./configurator/chat-thread-configurator-types";
import type { DriveAccountConfiguratorRpc } from "./configurator/drive-account-configurator-types";
import type { DriveFileConfiguratorRpc } from "./configurator/drive-file-configurator-types";
import type { DriveFolderConfiguratorRpc } from "./configurator/drive-folder-configurator-types";

/**
 * Mints an access token for a configurator, forwarding `AccessTokenRequest` to the `UserAccount`
 * so a client built on it can heal a 401 by asking for a fresh one.
 */
type ConfiguratorTokenGetter = (opts?: AccessTokenRequest) => Promise<GoogleAccessToken>;

const googleTokenGetters = new WeakMap<object, ConfiguratorTokenGetter>();
const calendarConfiguratorCaches = new WeakMap<object, Promise<ConfiguratorOption[]>>();
const bigQueryConfiguratorCaches = new WeakMap<object, Map<string, ConfiguratorOption[]>>();
const BIGQUERY_CONFIGURATOR_CACHE_MAX_ENTRIES = 200;
const BIGQUERY_CONFIGURATOR_EMPTY_LIST_OPTIONS = { maxPages: 1, maxResults: 200 };
const BIGQUERY_CONFIGURATOR_SEARCH_LIST_OPTIONS = { maxPages: 5, maxResults: 1000 };

function bigQueryConfiguratorListOptions(query: string) {
  return query.trim() ? BIGQUERY_CONFIGURATOR_SEARCH_LIST_OPTIONS : BIGQUERY_CONFIGURATOR_EMPTY_LIST_OPTIONS;
}

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

async function cachedBigQueryOptions(
  target: object,
  key: string,
  load: () => Promise<ConfiguratorOption[]>,
): Promise<ConfiguratorOption[]> {
  let cache = bigQueryConfiguratorCaches.get(target);
  if (!cache) {
    cache = new Map();
    bigQueryConfiguratorCaches.set(target, cache);
  }
  let cached = cache.get(key);
  if (cached) return cached;
  let result = await load();
  if (cache.size >= BIGQUERY_CONFIGURATOR_CACHE_MAX_ENTRIES) {
    let oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
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
 * Enough of a Drive ID to tell same-named results apart and to match against a Drive URL.
 *
 * Duplicate folder and file names are ordinary, and the picker's other columns can be identical
 * too, so without this the user cannot see which capability they are granting. A tail rather than
 * the whole ID because `meta` does not shrink, and a full one would crowd out the subtitle.
 */
function idTail(id: string): string {
  return id.length > 8 ? `…${id.slice(-8)}` : id;
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

async function listDriveFiles(
  target: object,
  query: string,
  mimeType: string,
  resourceName: string,
): Promise<ConfiguratorOption[]> {
  let drive = new DriveApi(googleTokenProvider(target));

  let { files } = await withDriveApiEnabled(
    `${resourceName} search requires the Google Drive API to be enabled for this OAuth project.`,
    () => drive.listFiles({ mimeType, namePrefix: query }),
  );

  return files.map(file => {
    let owner = file.owners?.[0];
    let subtitle = [
      owner?.displayName ?? owner?.emailAddress,
      file.modifiedTime ? `Modified ${new Date(file.modifiedTime).toLocaleDateString()}` : undefined,
    ].filter(Boolean).join(" · ");
    return { value: file.id, title: file.name, subtitle };
  });
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

// RPC interface exposed by Gatekeeper to the resource selection/configuration iframe.
@validateRpc()
export class BigQueryConfiguratorUI extends RpcTarget implements BigQueryConfiguratorRpc {
  constructor(getToken: () => Promise<GoogleAccessToken>) {
    super();
    googleTokenGetters.set(this, getToken);
  }

  async listProjects(query: string): Promise<ConfiguratorOption[]> {
    return cachedBigQueryOptions(this, `projects:${query.trim().toLowerCase()}`, async () => {
      let api = await bigQueryApi(this);
      let projects = await api.listProjects(bigQueryConfiguratorListOptions(query));
      return projects
        .filter(project => optionMatches([project.projectId, project.friendlyName, project.numericId], query))
        .slice(0, 100)
        .map(project => ({
          value: project.projectId,
          title: project.projectId,
          subtitle: project.friendlyName,
        }));
    });
  }

  async listDatasets(projectId: string, query: string): Promise<ConfiguratorOption[]> {
    return cachedBigQueryOptions(this, `datasets:${projectId}:${query.trim().toLowerCase()}`, async () => {
      let api = await bigQueryApi(this);
      let datasets = await api.listDatasets(projectId, bigQueryConfiguratorListOptions(query));
      return datasets
        .filter(dataset => optionMatches([dataset.datasetId, dataset.friendlyName, dataset.description, dataset.location], query))
        .slice(0, 100)
        .map(dataset => ({
          value: dataset.datasetId,
          title: dataset.datasetId,
          subtitle: dataset.friendlyName ?? dataset.description,
          meta: dataset.location,
        }));
    });
  }

  async listTables(projectId: string, datasetId: string, query: string): Promise<ConfiguratorOption[]> {
    return cachedBigQueryOptions(this, `tables:${projectId}:${datasetId}:${query.trim().toLowerCase()}`, async () => {
      let api = await bigQueryApi(this);
      let tables = await api.listTables(projectId, datasetId, bigQueryConfiguratorListOptions(query));
      return tables
        .filter(table => optionMatches([table.tableId, table.friendlyName, table.type], query))
        .slice(0, 100)
        .map(table => ({
          value: table.tableId,
          title: table.tableId,
          subtitle: table.friendlyName,
          meta: table.type,
        }));
    });
  }

}

// RPC interface exposed by Gatekeeper to the resource selection/configuration iframe.
@validateRpc()
export class GoogleDocConfiguratorUI extends RpcTarget implements GoogleDocConfiguratorRpc {
  constructor(getToken: () => Promise<GoogleAccessToken>) {
    super();
    googleTokenGetters.set(this, getToken);
  }

  async listDocs(query: string): Promise<ConfiguratorOption[]> {
    return listDriveFiles(
      this, query, "application/vnd.google-apps.document", "Google Docs",
    );
  }
}

// RPC interface exposed by Gatekeeper to the resource selection/configuration iframe.
@validateRpc()
export class GoogleSheetsConfiguratorUI extends RpcTarget implements GoogleSheetsConfiguratorRpc {
  constructor(getToken: () => Promise<GoogleAccessToken>) {
    super();
    googleTokenGetters.set(this, getToken);
  }

  async listSpreadsheets(query: string): Promise<ConfiguratorOption[]> {
    return listDriveFiles(
      this, query, "application/vnd.google-apps.spreadsheet", "Google Sheets",
    );
  }
}

// RPC interface exposed by Gatekeeper to the resource selection/configuration iframe.
@validateRpc()
export class GoogleSlidesConfiguratorUI extends RpcTarget implements GoogleSlidesConfiguratorRpc {
  constructor(getToken: () => Promise<GoogleAccessToken>) {
    super();
    googleTokenGetters.set(this, getToken);
  }

  async listPresentations(query: string): Promise<ConfiguratorOption[]> {
    return listDriveFiles(
      this, query, "application/vnd.google-apps.presentation", "Google Slides",
    );
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

@validateRpc()
export class DriveAccountConfiguratorUI extends RpcTarget implements DriveAccountConfiguratorRpc {}

@validateRpc()
export class DriveFileConfiguratorUI extends RpcTarget implements DriveFileConfiguratorRpc {
  constructor(getToken: () => Promise<GoogleAccessToken>) {
    super();
    googleTokenGetters.set(this, getToken);
  }

  async listDriveFiles(query: string): Promise<ConfiguratorOption[]> {
    let drive = new DriveApi(googleTokenProvider(this));
    let { files } = await withDriveApiEnabled(
      "Drive file search requires the Google Drive API to be enabled for this OAuth project.",
      () => drive.listFiles({
        namePrefix: query, excludeMimeTypes: [FOLDER_MIME_TYPE],
      }),
    );
    return files.map(file => ({
      value: file.id,
      title: file.name,
      subtitle: [
        file.mimeType,
        file.modifiedTime ? `Modified ${new Date(file.modifiedTime).toLocaleDateString()}` : undefined,
      ].filter(Boolean).join(" · ") || undefined,
      meta: idTail(file.id),
    }));
  }
}

@validateRpc()
export class DriveFolderConfiguratorUI extends RpcTarget implements DriveFolderConfiguratorRpc {
  constructor(getToken: () => Promise<GoogleAccessToken>) {
    super();
    googleTokenGetters.set(this, getToken);
  }

  /**
   * One page of folders this account can list children of, across My Drive, "Shared with me", and
   * every shared drive it belongs to. An interactive search, not an exhaustive enumeration.
   */
  async listDriveFolders(query: string): Promise<ConfiguratorOption[]> {
    let drive = new DriveApi(googleTokenProvider(this));
    let { files } = await withDriveApiEnabled(
      "Drive folder search requires the Google Drive API to be enabled for this OAuth project.",
      () => drive.listFiles({
        mimeType: FOLDER_MIME_TYPE, namePrefix: query, corpus: { kind: "allDrives" },
      }),
    );
    return files.filter(file => file.capabilities?.canListChildren === true).map(file => ({
      value: file.id,
      title: file.name,
      subtitle: file.driveId
        ? "In a shared drive"
        : file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress ?? "My Drive",
      meta: idTail(file.id),
    }));
  }
}
