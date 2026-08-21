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
import type { BigQueryResourceScope } from "./bigquery-resource";
import {
  BIGQUERY_HOST, BIGQUERY_PUBLIC_HOST, BIGQUERY_PUBLIC_RESOURCE_URL_PATTERN,
  BIGQUERY_RESOURCE_URL_PATTERN, parseBigQueryResourceUrl,
} from "./bigquery-resource";

/**
 * Scopes requested on every connection, to identify the account (name, email, avatar). Tied to no
 * resource type.
 */
export const IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
];

/**
 * Scopes for sign-in only, where the resulting grant is transient. Identical to
 * {@link IDENTITY_SCOPES}: verifying an email needs no resource access.
 */
export const AUTH_SCOPES = IDENTITY_SCOPES;

/** A whole Gmail mailbox, optionally narrowed to one search or label. */
export const GMAIL_RESOURCE: SupportedResource = {
  urlPattern: "https://mail.google.com/*",
  title: "Gmail Mailbox",
  description: "Read emails and apply labels.",
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
  urlPattern: BIGQUERY_RESOURCE_URL_PATTERN,
  title: "BigQuery",
  description:
      "Choose a Google Cloud project, then optionally narrow access to a dataset or table.",
  grantable: true,
};

/** A curated public BigQuery project, billed to a project of the user's own. */
export const BIGQUERY_PUBLIC_RESOURCE: SupportedResource = {
  urlPattern: BIGQUERY_PUBLIC_RESOURCE_URL_PATTERN,
  title: "BigQuery Public Data",
  description:
      "Query Google's public datasets. Billed to a project you choose, but unable to read that " +
      "project's own data.",
  grantable: true,
};

/**
 * The resources an account connected before per-resource scope tracking implicitly received.
 *
 * Frozen with one deliberate exception. Adding an entry short-circuits `ensureResources`, so a
 * legacy account would be reported as already holding a grant it never made and would never be
 * re-prompted for consent — which is exactly why BigQuery Public Data may be listed: it needs no
 * scope beyond the one a BigQuery grant already carries, so the reported grant is one the account
 * really did make.
 */
export const LEGACY_GRANTED_RESOURCE_URL_PATTERNS = [
  GMAIL_RESOURCE.urlPattern,
  GOOGLE_DOC_RESOURCE.urlPattern,
  BIGQUERY_RESOURCE.urlPattern,
  BIGQUERY_PUBLIC_RESOURCE.urlPattern,
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
    resource: BIGQUERY_RESOURCE,
    scopes: [
      // `bigquery` (not `bigquery.readonly`): dry-runs go through `jobs.insert` for scope
      // enforcement, which `readonly` doesn't permit. Read-only is enforced at the API layer.
      "https://www.googleapis.com/auth/bigquery",
    ],
  },
  {
    resource: BIGQUERY_PUBLIC_RESOURCE,
    // Deliberately the same single scope as BIGQUERY_RESOURCE: reading a public project needs no
    // additional authority, only a project to bill. Because the sets are identical,
    // `grantedResourcesFromScopes` hands this resource to anyone who has already granted BigQuery,
    // so the new connection type needs no re-consent — and records no grant wider than the one
    // actually made.
    scopes: [
      "https://www.googleapis.com/auth/bigquery",
    ],
  },
];

/** Every grantable resource, in declaration order. */
export const SUPPORTED_RESOURCES: SupportedResource[] = RESOURCE_SCOPES.map(entry => entry.resource);

/** Rejects any pattern that is not a known grantable resource. */
export function validateResourceUrlPatterns(resourceUrlPatterns?: string[]): void {
  if (resourceUrlPatterns === undefined) return;

  let known = new Set(RESOURCE_SCOPES.map(entry => entry.resource.urlPattern));
  let unknown = resourceUrlPatterns.filter(pattern => !known.has(pattern));
  if (unknown.length > 0) {
    throw new Error(`Unknown grantable resource URL pattern(s): ${unknown.join(", ")}`);
  }
}

/**
 * The OAuth scopes to request for the given grantable resource `urlPattern`s.
 *
 * `undefined` means every resource, which is distinct from `[]` (identity scopes only).
 */
export function resourceUrlPatternsToOAuthScopes(resourceUrlPatterns?: string[]): string[] {
  validateResourceUrlPatterns(resourceUrlPatterns);

  let scopes = new Set<string>(IDENTITY_SCOPES);
  for (let entry of RESOURCE_SCOPES) {
    if (resourceUrlPatterns === undefined ||
        resourceUrlPatterns.includes(entry.resource.urlPattern)) {
      for (let scope of entry.scopes) scopes.add(scope);
    }
  }
  return [...scopes];
}

/**
 * The resources fully covered by a set of granted scopes.
 *
 * Fails closed: a resource whose scopes are only partially present is not reported as granted.
 */
export function grantedResourcesFromScopes(grantedOAuthScopes: string[]): string[] {
  let granted = new Set(grantedOAuthScopes);
  return RESOURCE_SCOPES
      .filter(entry => entry.scopes.every(scope => granted.has(scope)))
      .map(entry => entry.resource.urlPattern);
}

/** A resource URL resolved to the binding parameters its gatekeeper takes. */
export type ResourceTarget =
  | { kind: "gmail"; searchQuery?: string; labelName?: string }
  | { kind: "doc"; documentId: string }
  | { kind: "sheets"; spreadsheetId: string }
  | { kind: "calendar"; calendarId: string; availabilityMode: CalendarAvailabilityMode }
  // Both BigQuery kinds carry the same {@link BigQueryResourceScope} fields — a data project, a
  // billing project, and an optional narrowing. They are separate kinds only because they are
  // separate grantable resources, which is what {@link RESOURCE_BY_KIND} has to tell apart; the
  // scope's own `private`/`public` discriminant is dropped here so there is one source of truth.
  | ({ kind: "bigquery" | "bigqueryPublic" } & Omit<BigQueryResourceScope, "kind">);

/** The grantable resource each {@link ResourceTarget} kind belongs to. */
export const RESOURCE_BY_KIND: Record<ResourceTarget["kind"], SupportedResource> = {
  gmail: GMAIL_RESOURCE,
  doc: GOOGLE_DOC_RESOURCE,
  sheets: GOOGLE_SHEETS_RESOURCE,
  calendar: GOOGLE_CALENDAR_RESOURCE,
  bigquery: BIGQUERY_RESOURCE,
  bigqueryPublic: BIGQUERY_PUBLIC_RESOURCE,
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
    case BIGQUERY_HOST:
    case BIGQUERY_PUBLIC_HOST: return parseBigQueryTarget(url, parsed);
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
 * The label is kept as an opaque name and resolved to an ID at session start, so label text can
 * never be interpreted as search syntax.
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

/**
 * Both BigQuery hosts. The grammar itself lives in `bigquery-resource.ts`, which is pure and
 * dependency-free so the configurators' inline copies of it can be pinned against one unit test;
 * this only maps the scope it returns onto the resource kind it belongs to.
 */
function parseBigQueryTarget(url: string, parsed: URL): ResourceTarget {
  let scope = parseBigQueryResourceUrl(url);
  if (!scope) {
    // Unreachable: the caller only dispatches here on the two hosts the parser recognizes.
    throw new Error(`Unsupported Google resource URL host: ${parsed.hostname}`);
  }
  let { kind, ...rest } = scope;
  return { kind: kind === "public" ? "bigqueryPublic" : "bigquery", ...rest };
}
