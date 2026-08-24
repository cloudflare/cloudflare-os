/**
 * The grantable resource types this gatekeeper offers, the OAuth scopes each needs, and the parser
 * that turns a bound resource URL into the parameters its gatekeeper Durable Object takes.
 *
 * A resource's `urlPattern` is permanent identity: it keys admin disable-sets, blueprint
 * `typeUrlPattern`s, and recorded grants. Never change one after deploy.
 */

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { CalendarAvailabilityMode } from "./calendar-types";
import { validateGmailLabelName, validateGmailQueryForGrouping } from "./gmail-validate";

/** Host serving the synthetic BigQuery resource URLs. */
export const BIGQUERY_HOST = "bigquery.googleapis.com";

/**
 * Scopes requested on every connection, to identify the account (name, email, avatar). Tied to no
 * resource type.
 */
export const IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
];


/** A whole Gmail mailbox, optionally narrowed to one search or label. */
export const GMAIL_RESOURCE: SupportedResource = {
  urlPattern: "https://mail.google.com/*",
  title: "Gmail Mailbox",
  description: "Read email and, after approval, send or manage messages, drafts, and labels.",
  grantable: true,
};

/** A single Google Doc. */
export const GOOGLE_DOC_RESOURCE: SupportedResource = {
  urlPattern: "https://docs.google.com/document/d/:docId/*",
  title: "Google Doc",
  description: "Read and edit documents you choose.",
  grantable: true,
};

/** A single Google Sheet. */
export const GOOGLE_SHEETS_RESOURCE: SupportedResource = {
  urlPattern: "https://docs.google.com/spreadsheets/d/:spreadsheetId/*",
  title: "Google Spreadsheet",
  description: "Read values from a spreadsheet you choose.",
  grantable: true,
};

/** A single Google Calendar. */
export const GOOGLE_CALENDAR_RESOURCE: SupportedResource = {
  urlPattern: "https://calendar.google.com/calendar/:calendarId/*",
  title: "Google Calendar",
  description: "Read and manage a Google Calendar.",
  grantable: true,
};

/** A BigQuery project, optionally narrowed to a dataset or table. */
export const BIGQUERY_RESOURCE: SupportedResource = {
  urlPattern: `https://${BIGQUERY_HOST}/:projectId/*`,
  title: "BigQuery",
  description:
      "Choose a Google Cloud project, then optionally narrow access to a dataset or table.",
  grantable: true,
};

/**
 * Files, folders, and read-only native Google Docs and Sheets available to the connected account.
 *
 * Whole-account, not just My Drive: listings set `includeItemsFromAllDrives`, so a shared drive the
 * account belongs to is inside this grant.
 */
export const GOOGLE_DRIVE_RESOURCE: SupportedResource = {
  urlPattern: "https://drive.google.com/drive/my-drive",
  title: "Google Drive Account",
  description:
      "Find files and folders anywhere this Google account can read in Drive, including shared " +
      "drives. Full-text search examines indexed file content, descriptions, and OCR text; search " +
      "results contain metadata only, while native Google Docs and Sheets can be opened read-only.",
  grantable: true,
};

/** Files, folders, and read-only native content in one Google Workspace shared drive. */
export const GOOGLE_SHARED_DRIVE_RESOURCE: SupportedResource = {
  urlPattern: "https://drive.google.com/drive/folders/:driveId",
  title: "Google Workspace Shared Drive",
  description: "Find files and folders, and read native Google Docs and Sheets, in one organization-owned shared drive.",
  grantable: true,
};

/** Metadata and, when native, read-only content for one immutable Drive file ID. */
export const GOOGLE_DRIVE_FILE_RESOURCE: SupportedResource = {
  urlPattern: "https://drive.google.com/file/d/:fileId/view",
  title: "Google Drive File",
  description: "Read metadata and, for a native Google Doc or Sheet, content from one Drive file.",
  grantable: true,
};

/**
 * The resources an account connected before per-resource scope tracking implicitly received.
 *
 * Frozen. Adding an entry short-circuits `ensureResources`, so a legacy account would be reported
 * as already holding a grant it never made and would never be re-prompted for consent.
 */
export const LEGACY_GRANTED_RESOURCE_URL_PATTERNS = [
  GMAIL_RESOURCE.urlPattern,
  GOOGLE_DOC_RESOURCE.urlPattern,
  BIGQUERY_RESOURCE.urlPattern,
];

/**
 * The resources whose grant may still be *inferred* from the OAuth scopes an account holds.
 *
 * Frozen, and for a sharper reason than the list above. Inference cannot tell a resource the user
 * chose from one that merely shares a scope with it: `drive.metadata.readonly` is requested by the
 * Docs and Sheets *pickers*, so inferring from it reports a whole-account Drive grant that nobody
 * made — `ensureResources` then skips the consent screen and the account really does hold the
 * scope to back it. Accounts connected since grants became recorded say what they consented to;
 * this list is only the fallback for the ones that didn't, so every resource added after it must
 * stay out.
 */
export const SCOPE_DERIVED_RESOURCE_URL_PATTERNS = [
  GMAIL_RESOURCE.urlPattern,
  GOOGLE_DOC_RESOURCE.urlPattern,
  GOOGLE_SHEETS_RESOURCE.urlPattern,
  GOOGLE_CALENDAR_RESOURCE.urlPattern,
  BIGQUERY_RESOURCE.urlPattern,
];

/** The OAuth scopes each grantable resource needs. */
export const RESOURCE_SCOPES: {resource: SupportedResource, scopes: string[]}[] = [
  {
    resource: GMAIL_RESOURCE,
    scopes: [
      "https://www.googleapis.com/auth/gmail.labels",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
  },
  {
    resource: GOOGLE_DOC_RESOURCE,
    scopes: [
      "https://www.googleapis.com/auth/documents",
      // Read-only Drive file metadata, used to power the doc picker when connecting a Google Doc.
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ],
  },
  {
    resource: GOOGLE_SHEETS_RESOURCE,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      // Read-only Drive file metadata, used to power the spreadsheet picker.
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ],
  },
  {
    resource: GOOGLE_CALENDAR_RESOURCE,
    scopes: [
      // Read-only calendar list, used to power the calendar picker when connecting a calendar.
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ],
  },
  {
    resource: GOOGLE_DRIVE_RESOURCE,
    scopes: [
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  },
  {
    resource: GOOGLE_SHARED_DRIVE_RESOURCE,
    // `drive.readonly` (not `drive.metadata.readonly`): the shared-drive picker and the binding's
    // `getScope` use `drives.list`/`drives.get`, which accept nothing narrower. The same scope already
    // authorizes native Docs and Sheets content, so do not add redundant API scopes. It is a
    // restricted scope granting account-wide content access, strictly wider than the authority the
    // shared-drive binding exercises. Narrowing it means dropping both calls: resolving a shared
    // drive's name through `files.get` on the drive root instead, and giving up drive enumeration in
    // the configurator.
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  },
  {
    resource: GOOGLE_DRIVE_FILE_RESOURCE,
    scopes: [
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  },
  {
    resource: BIGQUERY_RESOURCE,
    scopes: [
      // `bigquery` (not `bigquery.readonly`): dry-runs go through `jobs.insert` for scope
      // enforcement, which `readonly` doesn't permit. Read-only is enforced at the API layer.
      "https://www.googleapis.com/auth/bigquery",
    ],
  },
];

const DRIVE_RESOURCE_PATTERNS = new Set([
  GOOGLE_DRIVE_RESOURCE.urlPattern,
  GOOGLE_SHARED_DRIVE_RESOURCE.urlPattern,
  GOOGLE_DRIVE_FILE_RESOURCE.urlPattern,
]);

/** Every grantable resource, in declaration order. */
export const SUPPORTED_RESOURCES: SupportedResource[] = RESOURCE_SCOPES.map(entry => entry.resource);
const KNOWN_RESOURCE_PATTERNS = new Set(SUPPORTED_RESOURCES.map(resource => resource.urlPattern));

/** Whether an account's recorded grant includes any Google Drive resource. */
export function hasDriveResourceGrant(resourceUrlPatterns: readonly string[]): boolean {
  return resourceUrlPatterns.some(pattern => DRIVE_RESOURCE_PATTERNS.has(pattern));
}

/** Rejects any pattern that is not a known grantable resource. */
export function validateResourceUrlPatterns(resourceUrlPatterns: readonly string[]): void {
  let unknown = resourceUrlPatterns.filter(pattern => !KNOWN_RESOURCE_PATTERNS.has(pattern));
  if (unknown.length > 0) {
    throw new Error(`Unknown grantable resource URL pattern(s): ${unknown.join(", ")}`);
  }
}

/** The OAuth scopes required by the explicit grantable resource `urlPattern`s. */
export function resourceUrlPatternsToOAuthScopes(resourceUrlPatterns: readonly string[]): string[] {
  validateResourceUrlPatterns(resourceUrlPatterns);

  let scopes = new Set<string>(IDENTITY_SCOPES);
  for (let entry of RESOURCE_SCOPES) {
    if (resourceUrlPatterns.includes(entry.resource.urlPattern)) {
      for (let scope of entry.scopes) scopes.add(scope);
    }
  }
  return [...scopes];
}

/**
 * The subset of `resourceUrlPatterns` whose every OAuth scope is present in `grantedOAuthScopes`.
 *
 * Fails closed, so a scope the user declined at the consent screen, or dropped on a later
 * reconnect, retracts the grant that needed it.
 */
export function resourcesCoveredByScopes(
    resourceUrlPatterns: readonly string[],
    grantedOAuthScopes: readonly string[]): string[] {
  let granted = new Set(grantedOAuthScopes);
  let requested = new Set(resourceUrlPatterns);
  return RESOURCE_SCOPES
      .filter(entry => requested.has(entry.resource.urlPattern) &&
                       entry.scopes.every(scope => granted.has(scope)))
      .map(entry => entry.resource.urlPattern);
}

/**
 * One connected account's recorded consent, as stored on its Durable Object.
 *
 * Three generations of account, newest first. An account that consented since grants became
 * recorded states both fields. An account that recorded scopes but not resources states only
 * `oauthScopes`. An account from before scope tracking states neither.
 */
export type RecordedResourceGrant = {
  /** The resource `urlPattern`s the user chose, when the account recorded them. */
  resourceUrlPatterns?: readonly string[];
  /** The OAuth scopes Google returned, when the account recorded them. */
  oauthScopes?: readonly string[];
};

/**
 * Every resource this account is known to have consented to, as a reconnect must re-request it.
 *
 * This is the set a reconnect or scope expansion must ask Google for. Filtering a *recorded* intent
 * through the current scopes would silently drop a resource whose scope requirements have grown
 * since it was granted, and the consent screen would then request only what the account already
 * holds, leaving that binding permanently unusable.
 *
 * The two fallbacks are the frozen lists above, for the account generations that recorded less. The
 * scope-only generation is filtered by its own scopes, because there the list is an *inference* and
 * not a statement of intent: unfiltered, a Gmail-only account reconnecting would be asked to grant
 * writable Docs, writable Calendar, Sheets and BigQuery, and would have them recorded once it
 * accepted. That generation cannot express an outgrown grant either — a resource whose scopes it no
 * longer covers is indistinguishable from one it never held — so there is nothing to keep.
 */
export function recordedResourceUrlPatterns(grant: RecordedResourceGrant): string[] {
  if (grant.resourceUrlPatterns !== undefined) return [...grant.resourceUrlPatterns];
  if (grant.oauthScopes === undefined) return [...LEGACY_GRANTED_RESOURCE_URL_PATTERNS];
  return resourcesCoveredByScopes(SCOPE_DERIVED_RESOURCE_URL_PATTERNS, grant.oauthScopes);
}

/**
 * The subset of {@link recordedResourceUrlPatterns} whose every OAuth scope is currently held.
 *
 * This is what `ensureResources` decides against, so it fails closed: a scope the user declined,
 * or one a resource gained after it was granted, retracts the grant that needed it and re-prompts.
 */
export function grantedResourceUrlPatterns(grant: RecordedResourceGrant): string[] {
  if (grant.oauthScopes === undefined) return [...LEGACY_GRANTED_RESOURCE_URL_PATTERNS];
  return resourcesCoveredByScopes(recordedResourceUrlPatterns(grant), grant.oauthScopes);
}

/** A resource URL resolved to the binding parameters its gatekeeper takes. */
export type ResourceTarget =
  | { kind: "gmail"; searchQuery?: string; labelName?: string }
  | { kind: "doc"; documentId: string }
  | { kind: "sheets"; spreadsheetId: string }
  | { kind: "calendar"; calendarId: string; availabilityMode: CalendarAvailabilityMode }
  | { kind: "bigquery"; projectId: string; datasetId?: string; tableId?: string }
  | { kind: "driveAccount" }
  | { kind: "sharedDrive"; driveId: string }
  | { kind: "driveFile"; fileId: string };

/** The grantable resource each {@link ResourceTarget} kind belongs to. */
export const RESOURCE_BY_KIND: Record<ResourceTarget["kind"], SupportedResource> = {
  gmail: GMAIL_RESOURCE,
  doc: GOOGLE_DOC_RESOURCE,
  sheets: GOOGLE_SHEETS_RESOURCE,
  calendar: GOOGLE_CALENDAR_RESOURCE,
  bigquery: BIGQUERY_RESOURCE,
  driveAccount: GOOGLE_DRIVE_RESOURCE,
  sharedDrive: GOOGLE_SHARED_DRIVE_RESOURCE,
  driveFile: GOOGLE_DRIVE_FILE_RESOURCE,
};

/**
 * Parses a bound resource URL into the target its gatekeeper needs.
 *
 * Throws on any URL that does not name a supported resource. There is deliberately no fallback
 * kind: the caller derives the resource — and hence the admin disable check and the recorded
 * `typeUrlPattern` — from what this returns, so guessing would mint a capability the URL never
 * described.
 */
export function parseResourceUrl(url: string): ResourceTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Nothing of an unparseable string is safe to quote back.
    throw new Error("Not a valid resource URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Google resource URLs must use https, not ${parsed.protocol}`);
  }

  switch (parsed.hostname) {
    case "mail.google.com": return parseGmailUrl(parsed);
    case "docs.google.com": return parseDocsUrl(parsed);
    case "calendar.google.com": return parseCalendarUrl(parsed);
    case BIGQUERY_HOST: return parseBigQueryUrl(parsed);
    case "drive.google.com": return parseDriveUrl(parsed);
  }
  throw new Error(`Unsupported Google resource URL host: ${parsed.hostname}`);
}

/**
 * How much of a resource URL is safe to name in an error.
 *
 * A resource URL is caller-supplied and its tail is the sensitive part: a Gmail hash carries a
 * search query, and `href` retains any embedded credentials. These errors reach the Workshop UI and
 * are logged by their catchers, so only the host and path travel. The path still names a document
 * id, which is what makes the error worth reading at all -- but an id the caller just supplied and
 * the recorded binding will hold anyway, not a secret this adds to the trail.
 */
function describeUrl(parsed: URL): string {
  return `${parsed.hostname}${parsed.pathname}`;
}

/**
 * Gmail's own UI writes a hash of `#inbox`, `#search/<query>` or `#label/<name>`.
 *
 * The label is kept as an opaque name and resolved once to a persisted stable ID by the Gmail
 * gatekeeper, so label text can never be interpreted as search syntax or retarget after a rename.
 */
function parseGmailUrl(parsed: URL): ResourceTarget {
  let hash = parsed.hash;
  if (hash.startsWith("#search/")) {
    // Gmail encodes spaces in hash searches as `+`, which decodeURIComponent does not decode.
    let query = decodeURIComponent(hash.slice("#search/".length).replace(/\+/g, " "));
    validateGmailQueryForGrouping(query);
    return { kind: "gmail", searchQuery: query };
  }
  if (hash.startsWith("#label/")) {
    let labelName = decodeURIComponent(hash.slice("#label/".length));
    validateGmailLabelName(labelName);
    return { kind: "gmail", labelName };
  }
  if (hash && hash !== "#inbox") {
    throw new Error(
      "Unsupported Gmail view. Connect the inbox, an explicit search, or an explicit label.");
  }
  return { kind: "gmail" };
}

function parseDocsUrl(parsed: URL): ResourceTarget {
  // Both forms are /<type>/d/<id>/..., so the id is always the third segment.
  let id = parsed.pathname.split("/")[3];
  if (parsed.pathname.startsWith("/document/d/")) {
    if (!id) throw new Error("Invalid Google Docs URL: no document ID found");
    return { kind: "doc", documentId: id };
  }
  if (parsed.pathname.startsWith("/spreadsheets/d/")) {
    if (!id) throw new Error("Invalid Google Sheets URL: no spreadsheet ID found");
    return { kind: "sheets", spreadsheetId: id };
  }
  throw new Error(`Unsupported Google Docs resource URL: ${describeUrl(parsed)}`);
}

function parseCalendarUrl(parsed: URL): ResourceTarget {
  if (!parsed.pathname.startsWith("/calendar/")) {
    throw new Error(`Unsupported Google Calendar resource URL: ${describeUrl(parsed)}`);
  }
  let calendarId = decodeURIComponent(parsed.pathname.split("/")[2] ?? "");
  if (!calendarId) {
    throw new Error("Invalid Google Calendar URL: no calendar ID found");
  }
  if (calendarId === "primary") {
    throw new Error(
      "Google Calendar bindings must use a stable calendar ID, not the account-relative " +
      "\"primary\" alias.");
  }
  // Least privilege unless the URL explicitly opts into all calendars.
  let availabilityMode: CalendarAvailabilityMode =
      parsed.searchParams.get("availability") === "allVisible" ? "allVisible" : "thisCalendar";
  return { kind: "calendar", calendarId, availabilityMode };
}

function parseDriveUrl(parsed: URL): ResourceTarget {
  if (/^\/drive\/my-drive\/?$/.test(parsed.pathname)) return { kind: "driveAccount" };

  let sharedDrive = /^\/drive\/folders\/([^/]+)\/?$/.exec(parsed.pathname);
  if (sharedDrive) return { kind: "sharedDrive", driveId: decodeURIComponent(sharedDrive[1]) };

  let file = /^\/file\/d\/([^/]+)\/view\/?$/.exec(parsed.pathname);
  if (file) return { kind: "driveFile", fileId: decodeURIComponent(file[1]) };

  throw new Error(`Unsupported Google Drive resource URL: ${describeUrl(parsed)}`);
}

function parseBigQueryUrl(parsed: URL): ResourceTarget {
  if (parsed.search || parsed.hash) {
    throw new Error("BigQuery resource URLs must not include query strings or fragments.");
  }

  // Synthetic path: /<projectId>/<datasetId>/<tableId> (each segment optional after the first).
  let segments = parsed.pathname.split("/").filter(Boolean).map(s => decodeURIComponent(s));
  if (segments.length > 3) {
    throw new Error(
        "BigQuery resource URLs must be /<projectId>, /<projectId>/<datasetId>, " +
        "or /<projectId>/<datasetId>/<tableId>.");
  }
  let [projectId, datasetId, tableId] = segments;
  if (!projectId) {
    throw new Error("BigQuery resource URLs must include a project ID.");
  }
  if (tableId && !datasetId) {
    throw new Error("Cannot scope to a table without specifying a dataset.");
  }
  return { kind: "bigquery", projectId, datasetId, tableId };
}
