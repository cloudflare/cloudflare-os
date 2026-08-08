import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { BigQueryApi } from "./bigquery-api";
import { GoogleCalendarApi } from "./calendar-api";
import { GoogleAccessToken } from "./google-api";
import type { BigQueryConfiguratorRpc } from "./configurator/bigquery-configurator-types";
import type { CalendarConfiguratorRpc } from "./configurator/calendar-configurator-types";
import type { DriveFolderConfiguratorRpc } from "./configurator/drive-folder-configurator-types";
import type { GmailConfiguratorRpc } from "./configurator/gmail-configurator-types";
import type { GoogleDocConfiguratorRpc } from "./configurator/google-doc-configurator-types";
import type { GoogleSheetsConfiguratorRpc } from "./configurator/google-sheets-configurator-types";

type ConfiguratorOption = { value: string; title: string; subtitle?: string; meta?: string };
const googleTokenGetters = new WeakMap<object, () => Promise<GoogleAccessToken>>();
const calendarConfiguratorCaches = new WeakMap<object, Promise<ConfiguratorOption[]>>();
const bigQueryConfiguratorCaches = new WeakMap<object, Map<string, ConfiguratorOption[]>>();
const BIGQUERY_CONFIGURATOR_CACHE_MAX_ENTRIES = 200;
const BIGQUERY_CONFIGURATOR_EMPTY_LIST_OPTIONS = { maxPages: 1, maxResults: 200 };
const BIGQUERY_CONFIGURATOR_SEARCH_LIST_OPTIONS = { maxPages: 5, maxResults: 1000 };

function bigQueryConfiguratorListOptions(query: string) {
  return query.trim() ? BIGQUERY_CONFIGURATOR_SEARCH_LIST_OPTIONS : BIGQUERY_CONFIGURATOR_EMPTY_LIST_OPTIONS;
}

function googleToken(target: object): Promise<GoogleAccessToken> {
  let getToken = googleTokenGetters.get(target);
  if (!getToken) throw new Error("Google configurator is not initialized.");
  return getToken();
}

async function bigQueryApi(target: object): Promise<BigQueryApi> {
  let token = await googleToken(target);
  return new BigQueryApi(() => Promise.resolve(token.token));
}

async function calendarApi(target: object): Promise<GoogleCalendarApi> {
  let token = await googleToken(target);
  return new GoogleCalendarApi(() => Promise.resolve(token.token));
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
  let token = await googleToken(target);
  let url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("fields", "files(id,name,modifiedTime,owners(displayName,emailAddress))");
  url.searchParams.set("orderBy", "modifiedTime desc");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  let q = `mimeType = '${mimeType}' and trashed = false`;
  let trimmed = query.trim();
  if (trimmed) {
    // Drive query strings use single-quoted literals; Google documents escaping ' as \'.
    let escaped = trimmed.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    q += ` and name contains '${escaped}'`;
  }
  url.searchParams.set("q", q);

  let response = await fetch(url.toString(), {
    headers: { "Authorization": `Bearer ${token.token}` },
  });
  if (!response.ok) {
    let text = await response.text();
    if (response.status === 403 && text.includes("Google Drive API has not been used")) {
      throw new Error(
        `${resourceName} search requires the Google Drive API to be enabled for this OAuth project.`,
      );
    }
    throw new Error(`Failed to search ${resourceName}: ${response.status} ${text}`);
  }
  let body = await response.json<{
    files?: {
      id: string,
      name: string,
      modifiedTime?: string,
      owners?: { displayName?: string, emailAddress?: string }[],
    }[],
  }>();
  return (body.files ?? []).map(file => {
    let owner = file.owners?.[0];
    let subtitleParts = [
      owner?.displayName ?? owner?.emailAddress,
      file.modifiedTime ? `Modified ${new Date(file.modifiedTime).toLocaleDateString()}` : undefined,
    ].filter(Boolean);
    return {
      value: file.id,
      title: file.name,
      subtitle: subtitleParts.join(" · "),
    };
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
export class DriveFolderConfiguratorUI extends RpcTarget implements DriveFolderConfiguratorRpc {
  constructor(getToken: () => Promise<GoogleAccessToken>) {
    super();
    googleTokenGetters.set(this, getToken);
  }

  async listFolders(query: string): Promise<ConfiguratorOption[]> {
    return listDriveFiles(
      this, query, "application/vnd.google-apps.folder", "Google Drive folders",
    );
  }
}
