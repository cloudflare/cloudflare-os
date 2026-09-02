import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { BigQueryApi } from "./bigquery-api";
import { GoogleCalendarApi } from "./calendar-api";
import { GoogleAccessToken } from "./google-api";
import { AccessTokenProvider, AccessTokenRequest } from "./auth-retry";
import { DriveApi, DriveApiDisabledError } from "./drive-api";
import type { BigQueryConfiguratorRpc } from "./configurator/bigquery-configurator-types";
import type { CalendarConfiguratorRpc } from "./configurator/calendar-configurator-types";
import type { GmailConfiguratorRpc } from "./configurator/gmail-configurator-types";
import type { GoogleDocConfiguratorRpc } from "./configurator/google-doc-configurator-types";
import type { GoogleSheetsConfiguratorRpc } from "./configurator/google-sheets-configurator-types";
import type { ConfiguratorOption } from "./configurator/configurator-option";
import type { DriveAccountConfiguratorRpc } from "./configurator/drive-account-configurator-types";
import type { DriveFileConfiguratorRpc } from "./configurator/drive-file-configurator-types";
import type { SharedDriveConfiguratorRpc } from "./configurator/shared-drive-configurator-types";

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

@validateRpc()
export class DriveAccountConfiguratorUI extends RpcTarget implements DriveAccountConfiguratorRpc {}

@validateRpc()
export class SharedDriveConfiguratorUI extends RpcTarget implements SharedDriveConfiguratorRpc {
  constructor(getToken: () => Promise<GoogleAccessToken>) {
    super();
    googleTokenGetters.set(this, getToken);
  }

  async listSharedDrives(query: string): Promise<ConfiguratorOption[]> {
    let drive = new DriveApi(googleTokenProvider(this));
    let drives = await withDriveApiEnabled(
      "Shared-drive search requires the Google Drive API to be enabled for this OAuth project.",
      () => drive.listAllDrives({ namePrefix: query }),
    );
    return drives.map(item => ({ value: item.id, title: item.name, subtitle: item.id }));
  }
}

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
        namePrefix: query, excludeMimeTypes: ["application/vnd.google-apps.folder"],
      }),
    );
    return files.map(file => ({
      value: file.id,
      title: file.name,
      subtitle: [
        file.mimeType,
        file.modifiedTime ? `Modified ${new Date(file.modifiedTime).toLocaleDateString()}` : undefined,
      ].filter(Boolean).join(" · ") || undefined,
    }));
  }
}
