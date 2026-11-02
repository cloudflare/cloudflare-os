// Configuration shared by every part of the Microsoft 365 gatekeeper: the Worker's environment, the
// Entra ID authority it signs in against, the connectable resources, and the OAuth scopes each needs.

import { stripTrailingSlashes, type SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { PreviewOAuthEnv } from "@gadgets/gatekeeper-kit/preview-oauth";
import { CALENDAR_ACCESS_LEVELS, lowerAccess as lowerCalendarAccess, type CalendarAccessLevel, type CalendarScope } from "./calendar-scope";
import { ACCESS_LEVELS, lowerAccess, type OutlookAccessLevel, type OutlookScope } from "./outlook-scope";
import type { SharePointScope } from "./sharepoint-scope";

/** The vendor id: the router's `/gatekeeper/microsoft/` path segment, and the log attribution. */
export const VENDOR_ID = "microsoft";

/** The Worker's environment. Every value is optional: each has a default or turns a feature off. */
export type Env = Cloudflare.Env & PreviewOAuthEnv & {
  /** This Worker's public base URL, ending in `/gatekeeper/microsoft`. */
  BASE_URL?: string;
  /** The Entra ID app registration's application (client) ID. */
  CLIENT_ID?: string;
  /** The app registration's client secret. */
  CLIENT_SECRET?: string;
  /**
   * The tenant users sign in to: a tenant ID (GUID) or verified domain, or `organizations` for any
   * work or school tenant, which then requires `MICROSOFT_ALLOWED_TENANT_IDS`. Defaults to
   * `organizations`.
   */
  MICROSOFT_TENANT_ID?: string;
  /** Comma-separated tenant IDs a connection may come from, checked after sign-in. */
  MICROSOFT_ALLOWED_TENANT_IDS?: string;
  /** `write` (the default) or `read`: the most this deployment lets agents do in SharePoint. */
  MICROSOFT_SHAREPOINT_ACCESS?: string;
  /**
   * `all` (the default) or `selected`: whether SharePoint access is asked for across every site the
   * user can open (`Sites.Read.All`), or for only the sites a SharePoint admin grants the app
   * (`Sites.Selected`). Either way, a connection works by what its grant turns out to hold.
   */
  MICROSOFT_SHAREPOINT_SITES?: string;
  /**
   * `send` (the default), `draft` or `read`: the most this deployment lets agents do in
   * Outlook. Each binding chooses its own level, up to this.
   */
  MICROSOFT_OUTLOOK_ACCESS?: string;
  /**
   * `schedule` (the default), `edit` or `read`: the most this deployment lets agents do in Outlook
   * calendars. Each binding chooses its own level, up to this.
   */
  MICROSOFT_CALENDAR_ACCESS?: string;
  /** Workers AI, for turning PDFs into text. Optional. */
  AI?: Ai;
};

/** Where every API request goes. */
const GRAPH_ORIGIN = "https://graph.microsoft.com";
/** The Graph version this gatekeeper speaks. */
export const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;
/** Entra ID's sign-in host. */
export const LOGIN_ORIGIN = "https://login.microsoftonline.com";

/** This Worker's public base URL, without a trailing slash. */
export function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/microsoft");
}

/** The path part of the base URL, or `""` when it is the origin's root. */
export function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

/** The OAuth callback registered on the app registration. */
export function getRedirectUri(env: Env): string {
  return `${getBaseUrl(env)}/oauth`;
}

/** A deployment setting that cannot work as written. Shown to whoever tried to connect. */
export class MicrosoftConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicrosoftConfigurationError";
  }
}

const TENANT_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Who may connect: one tenant, or any tenant on an allowlist. */
export type TenantPolicy =
  | { kind: "single"; authority: string }
  | { kind: "allowlist"; authority: "organizations"; tenantIds: ReadonlySet<string> };

/**
 * The sign-in policy the environment describes.
 *
 * `common` and `consumers` are refused outright: a personal Microsoft account has no SharePoint, and
 * `organizations` without an allowlist would let any company's users connect to this deployment.
 * @throws MicrosoftConfigurationError for a setting that cannot work.
 */
export function tenantPolicy(env: Env): TenantPolicy {
  const tenant = env.MICROSOFT_TENANT_ID?.trim() || "organizations";
  if (tenant.toLowerCase() === "organizations") {
    const tenantIds = new Set((env.MICROSOFT_ALLOWED_TENANT_IDS ?? "").split(",")
      .map(id => id.trim().toLowerCase()).filter(id => id !== ""));
    if (tenantIds.size === 0) {
      throw new MicrosoftConfigurationError("This Microsoft 365 gatekeeper accepts any organization's " +
        "accounts but names none it trusts. Set MICROSOFT_TENANT_ID to your tenant, or list the tenants " +
        "allowed in MICROSOFT_ALLOWED_TENANT_IDS.");
    }
    for (const id of tenantIds) {
      if (!TENANT_GUID.test(id)) {
        throw new MicrosoftConfigurationError(
          "MICROSOFT_ALLOWED_TENANT_IDS must list tenant IDs (GUIDs), not domains.");
      }
    }
    return { kind: "allowlist", authority: "organizations", tenantIds };
  }
  if (!TENANT_GUID.test(tenant) && !TENANT_DOMAIN.test(tenant)) {
    throw new MicrosoftConfigurationError(tenant === "common" || tenant === "consumers"
      ? "MICROSOFT_TENANT_ID cannot be \"common\" or \"consumers\": personal Microsoft accounts have no " +
        "SharePoint. Use your tenant ID, or \"organizations\" with MICROSOFT_ALLOWED_TENANT_IDS."
      : "MICROSOFT_TENANT_ID must be a tenant ID, a verified domain, or \"organizations\".");
  }
  return { kind: "single", authority: tenant };
}

/**
 * Whether a signed-in tenant is one this deployment accepts, and matches the connection's pin if it
 * has one. A single-tenant authority already refuses other tenants at sign-in; one named by GUID is
 * also compared with the token's `tid` (a domain cannot be). A guest passes, since their token is
 * issued by the resource tenant.
 */
export function acceptsTenant(policy: TenantPolicy, tenantId: string, pinnedTenantId?: string): boolean {
  if (policy.kind === "allowlist") return policy.tenantIds.has(tenantId.toLowerCase());
  if (TENANT_GUID.test(policy.authority) && policy.authority.toLowerCase() !== tenantId.toLowerCase()) return false;
  return pinnedTenantId === undefined || pinnedTenantId === tenantId;
}

/** The OAuth endpoints for an authority. */
export function oauthEndpoints(authority: string): { authorize: string; token: string } {
  const base = `${LOGIN_ORIGIN}/${encodeURIComponent(authority)}/oauth2/v2.0`;
  return { authorize: `${base}/authorize`, token: `${base}/token` };
}

/** What agents may do in SharePoint on this deployment. */
export type SharePointAccess = "read" | "write";

/**
 * Which sites a connection reaches: every one the user can open, or only those a SharePoint admin
 * has granted the app, which Microsoft then enforces.
 */
export type SharePointSites = "all" | "selected";

/** Which sites this deployment asks for. Unrecognized values are `selected`, the safe side; unset is `all`. */
export function sharePointSites(env: Env): SharePointSites {
  const value = env.MICROSOFT_SHAREPOINT_SITES?.trim().toLowerCase();
  if (value === undefined || value === "") return "all";
  return value === "all" ? "all" : "selected";
}

/** The SharePoint access ceiling. Unrecognized values are `read`, the safe side; unset is `write`. */
export function sharePointAccess(env: Env): SharePointAccess {
  const value = env.MICROSOFT_SHAREPOINT_ACCESS?.trim().toLowerCase();
  if (value === undefined || value === "") return "write";
  return value === "write" ? "write" : "read";
}

/**
 * The one SharePoint resource. Every SharePoint and OneDrive for Business URL matches it, and the
 * configurator decides how much of it a binding covers: all of it, or one site, library, folder,
 * file, list or page. See plans/microsoft-365-gatekeeper.md.
 */
export const SHAREPOINT_RESOURCE: SupportedResource = {
  urlPattern: "https://*.sharepoint.com/*",
  title: "SharePoint & OneDrive",
  description: "Find, read and edit files, lists and pages, with your approval for every change. " +
    "Connect everything you can open, or just one site, library, folder, file, list or page.",
  grantable: true,
};

/**
 * The one Outlook resource: one mailbox, the user's or a shared one they can open, which the
 * configurator narrows. See plans/microsoft-outlook.md.
 */
export const OUTLOOK_RESOURCE: SupportedResource = {
  urlPattern: "https://outlook.office.com/*",
  title: "Outlook",
  description: "Read, search and triage mail, draft replies, and send with your approval. Connect your " +
    "whole mailbox or a shared one, or just a folder, a conversation, or mail from certain people.",
  grantable: true,
};

/**
 * Outlook calendars: every calendar the user has, availability only, or one calendar at a level of
 * detail, which the configurator chooses. See plans/microsoft-calendar.md.
 */
export const CALENDAR_RESOURCE: SupportedResource = {
  urlPattern: "https://outlook.office.com/calendar/*",
  title: "Outlook Calendar",
  description: "See when you and your colleagues are free, read calendars, and schedule with your approval. " +
    "Connect every calendar, one calendar, or just availability.",
  grantable: true,
};

/**
 * The resources in the order the picker lists them. A URL is matched against them in this order
 * and Outlook's pattern also covers calendar URLs, so Calendar comes before Outlook.
 */
export const ALL_RESOURCES: SupportedResource[] = [SHAREPOINT_RESOURCE, CALENDAR_RESOURCE, OUTLOOK_RESOURCE];

/** The Outlook access ceiling. Unrecognized values are `read`, the safe side; unset is `send`. */
export function outlookAccess(env: Env): OutlookAccessLevel {
  const value = env.MICROSOFT_OUTLOOK_ACCESS?.trim().toLowerCase();
  if (value === undefined || value === "") return "send";
  return (ACCESS_LEVELS as readonly string[]).includes(value) ? value as OutlookAccessLevel : "read";
}

/**
 * The Graph permissions Outlook needs at each access level. Shared mailboxes need the `.Shared`
 * variants, plus `User.ReadBasic.All` to learn a shared mailbox's object ID from its address (which
 * `User.Read` can't), requested with the rest so a shared mailbox can be added without reconnecting.
 */
const OUTLOOK_SCOPES: Record<OutlookAccessLevel, readonly string[]> = {
  read: ["Mail.Read", "Mail.Read.Shared", "MailboxSettings.Read", "People.Read", "User.ReadBasic.All"],
  draft: ["Mail.ReadWrite", "Mail.ReadWrite.Shared", "MailboxSettings.ReadWrite", "People.Read", "User.ReadBasic.All"],
  send: ["Mail.ReadWrite", "Mail.ReadWrite.Shared", "MailboxSettings.ReadWrite", "People.Read", "Mail.Send", "Mail.Send.Shared", "User.ReadBasic.All"],
};

/** The Calendar access ceiling. Unrecognized values are `read`, the safe side; unset is `schedule`. */
export function calendarAccess(env: Env): CalendarAccessLevel {
  const value = env.MICROSOFT_CALENDAR_ACCESS?.trim().toLowerCase();
  if (value === undefined || value === "") return "schedule";
  return (CALENDAR_ACCESS_LEVELS as readonly string[]).includes(value) ? value as CalendarAccessLevel : "read";
}

/**
 * The Graph permissions calendars need at each access level: the `.Shared` variants open calendars
 * people share with the user, `User.ReadBasic.All` finds their owner's object ID from an address,
 * and mailbox settings give the user's time zone and working hours. Invitations are sent by
 * Exchange as part of the event, so no `Mail.Send` is needed.
 */
const CALENDAR_SCOPES: Record<CalendarAccessLevel, readonly string[]> = {
  read: ["Calendars.Read", "Calendars.Read.Shared", "MailboxSettings.Read", "People.Read", "User.ReadBasic.All"],
  edit: ["Calendars.ReadWrite", "Calendars.ReadWrite.Shared", "MailboxSettings.Read", "People.Read", "User.ReadBasic.All"],
  schedule: ["Calendars.ReadWrite", "Calendars.ReadWrite.Shared", "MailboxSettings.Read", "People.Read", "User.ReadBasic.All"],
};

/** Scopes every connection carries: sign-in, the user's profile, and a refresh token. */
const BASE_SCOPES = ["openid", "profile", "email", "offline_access", "User.Read"] as const;

/**
 * The Graph permissions SharePoint needs at each access level, by which sites it reaches. Under
 * `Sites.Selected` each site's grant to the app says whether it may write, and the user's own
 * OneDrive, a site of its own that no admin grants one by one, comes from `Files.Read(Write)`, which
 * reaches only the signed-in user's files.
 */
const SHAREPOINT_SCOPES: Record<SharePointSites, Record<SharePointAccess, readonly string[]>> = {
  all: { read: ["Sites.Read.All", "Files.Read.All"], write: ["Sites.ReadWrite.All", "Files.ReadWrite.All"] },
  selected: { read: ["Sites.Selected", "Files.Read"], write: ["Sites.Selected", "Files.ReadWrite"] },
};

/** A permission that implies another, for reading a grant. */
const COVERED_BY: Record<string, string> = {
  "sites.read.all": "sites.readwrite.all",
  "files.read.all": "files.readwrite.all",
  "files.read": "files.readwrite",
  "mail.read": "mail.readwrite",
  "mail.read.shared": "mail.readwrite.shared",
  "mailboxsettings.read": "mailboxsettings.readwrite",
  "calendars.read": "calendars.readwrite",
  "calendars.read.shared": "calendars.readwrite.shared",
};

/** Entra's `scope` parameter wants Graph permissions as `https://graph.microsoft.com/<name>`. */
function qualified(scope: string): string {
  return (BASE_SCOPES as readonly string[]).includes(scope) ? scope : `${GRAPH_ORIGIN}/${scope}`;
}

/**
 * The scopes a connection requests.
 * @param resourceUrlPatterns The resource types to grant; omitted grants every type, and `[]` none
 * beyond the base scopes.
 * @throws For a pattern that is not this gatekeeper's.
 */
export function scopesFor(env: Env, resourceUrlPatterns?: readonly string[]): string[] {
  const scopes = new Set<string>(BASE_SCOPES);
  const patterns = resourceUrlPatterns ?? ALL_RESOURCES.map(resource => resource.urlPattern);
  for (const pattern of patterns) {
    const needed = pattern === SHAREPOINT_RESOURCE.urlPattern ? SHAREPOINT_SCOPES[sharePointSites(env)][sharePointAccess(env)]
      : pattern === OUTLOOK_RESOURCE.urlPattern ? OUTLOOK_SCOPES[outlookAccess(env)]
      : pattern === CALENDAR_RESOURCE.urlPattern ? CALENDAR_SCOPES[calendarAccess(env)]
      : undefined;
    if (needed === undefined) throw new Error(`Unknown Microsoft 365 resource type: ${pattern}`);
    for (const scope of needed) scopes.add(scope);
  }
  return [...scopes].map(qualified);
}

/** A granted scope as Entra reports it, `https://graph.microsoft.com/Files.Read.All` or bare, lower-cased. */
function normalizeScope(scope: string): string {
  const lower = scope.toLowerCase();
  const prefix = `${GRAPH_ORIGIN}/`;
  return lower.startsWith(prefix) ? lower.slice(prefix.length) : lower;
}

/** Whether a grant holds `scope` or a wider permission that covers it. */
function holds(granted: ReadonlySet<string>, scope: string): boolean {
  const wanted = scope.toLowerCase();
  return granted.has(wanted) || (COVERED_BY[wanted] !== undefined && granted.has(COVERED_BY[wanted]));
}

/** What SharePoint a grant reaches: which sites, the most agents may do, and the user's own OneDrive. */
export type SharePointGrant = { sites: SharePointSites; access: SharePointAccess; oneDrive: boolean };

/**
 * The SharePoint a grant carries, whatever the deployment asked for, since an admin may consent to
 * less or other than was asked. Every site at `write` takes both ReadWrite permissions. Otherwise
 * `Sites.Selected` means only the sites granted to the app, at whatever each grant allows, which
 * Microsoft enforces; the user's own OneDrive then needs `Files.Read` or `Files.ReadWrite`.
 */
export function grantedSharePoint(grantedScopes: readonly string[]): SharePointGrant | null {
  const granted = new Set(grantedScopes.map(normalizeScope));
  const { all } = SHAREPOINT_SCOPES;
  if (all.write.every(scope => granted.has(scope.toLowerCase()))) return { sites: "all", access: "write", oneDrive: true };
  if (all.read.every(scope => holds(granted, scope))) return { sites: "all", access: "read", oneDrive: true };
  if (granted.has("sites.selected")) return { sites: "selected", access: "write", oneDrive: holds(granted, "files.read") };
  return null;
}

/**
 * The resource types a grant covers. Entra never echoes `offline_access`, and `email`/`profile` are
 * folded into `openid`, so only `User.Read` stands for the base scopes.
 */
export function grantedResourcePatterns(grantedScopes: readonly string[]): string[] {
  const granted = new Set(grantedScopes.map(normalizeScope));
  if (!granted.has("user.read")) return [];
  return [
    ...(grantedSharePoint(grantedScopes) === null ? [] : [SHAREPOINT_RESOURCE.urlPattern]),
    ...(grantedCalendarAccess(grantedScopes) === null ? [] : [CALENDAR_RESOURCE.urlPattern]),
    ...(grantedOutlookAccess(grantedScopes) === null ? [] : [OUTLOOK_RESOURCE.urlPattern]),
  ];
}

/**
 * The Calendar access a grant carries: `schedule` (which covers `edit`) with Calendars.ReadWrite,
 * `read` with Calendars.Read. Mailbox settings and the People API are optional: without them times
 * are shown in UTC and findPeople fails.
 */
export function grantedCalendarAccess(grantedScopes: readonly string[]): CalendarAccessLevel | null {
  const granted = new Set(grantedScopes.map(normalizeScope));
  if (!holds(granted, "calendars.read")) return null;
  return granted.has("calendars.readwrite") ? "schedule" : "read";
}

/** Whether a grant can open calendars shared with the user, at `access`. */
export function grantsSharedCalendars(grantedScopes: readonly string[], access: CalendarAccessLevel): boolean {
  const granted = new Set(grantedScopes.map(normalizeScope));
  if (!holds(granted, "calendars.read.shared") || !granted.has("user.readbasic.all")) return false;
  return access === "read" || granted.has("calendars.readwrite.shared");
}

/**
 * The access a Calendar binding has: what it was configured with, the deployment's ceiling, and
 * the connection's grant, the lowest winning. Null when the grant has no calendar access at all.
 */
export function effectiveCalendarAccess(env: Env, grantedScopes: readonly string[], configured: CalendarAccessLevel): CalendarAccessLevel | null {
  const granted = grantedCalendarAccess(grantedScopes);
  if (granted === null) return null;
  return lowerCalendarAccess(lowerCalendarAccess(configured, calendarAccess(env)), granted);
}

/**
 * The Outlook access a grant carries: `send` with Mail.Send, `draft` with
 * Mail.ReadWrite, `read` with Mail.Read. The People API is needed at every level.
 */
export function grantedOutlookAccess(grantedScopes: readonly string[]): OutlookAccessLevel | null {
  const granted = new Set(grantedScopes.map(normalizeScope));
  if (!holds(granted, "mail.read") || !granted.has("people.read")) return null;
  if (!granted.has("mail.readwrite")) return "read";
  return granted.has("mail.send") ? "send" : "draft";
}

/** Whether a grant can open shared mailboxes at `access`. */
export function grantsSharedMailboxes(grantedScopes: readonly string[], access: OutlookAccessLevel): boolean {
  const granted = new Set(grantedScopes.map(normalizeScope));
  if (!holds(granted, "mail.read.shared") || !granted.has("user.readbasic.all")) return false;
  if (access !== "read" && !granted.has("mail.readwrite.shared")) return false;
  return access !== "send" || granted.has("mail.send.shared");
}

/**
 * The access an Outlook binding has: what it was configured with, the deployment's ceiling, and the
 * connection's grant, the lowest winning. Null when the grant has no mail access at all.
 */
export function effectiveOutlookAccess(env: Env, grantedScopes: readonly string[], configured: OutlookAccessLevel): OutlookAccessLevel | null {
  const granted = grantedOutlookAccess(grantedScopes);
  if (granted === null) return null;
  return lowerAccess(lowerAccess(configured, outlookAccess(env)), granted);
}

/**
 * What a connection reaches in SharePoint: its grant, at no more than the deployment's ceiling. A
 * connection made when the ceiling was `write` keeps only `read` once the ceiling is lowered.
 */
export function effectiveSharePoint(env: Env, grantedScopes: readonly string[]): SharePointGrant | null {
  const granted = grantedSharePoint(grantedScopes);
  if (granted === null) return null;
  return sharePointAccess(env) === "read" ? { ...granted, access: "read" } : granted;
}

/** Props baked into the Outlook gatekeeper Durable Object class for one binding. */
export type OutlookGatekeeperProps = {
  /** The `UserAccount` Durable Object holding the connection. */
  userObjectId: string;
  /** What the binding covers, by stable ID. */
  scope: OutlookScope;
};

/** Props baked into the Calendar gatekeeper Durable Object class for one binding. */
export type CalendarGatekeeperProps = {
  /** The `UserAccount` Durable Object holding the connection. */
  userObjectId: string;
  /** What the binding covers, by stable ID. */
  scope: CalendarScope;
};

/** Props baked into the gatekeeper Durable Object class for one binding. */
export type SharePointGatekeeperProps = {
  /** The `UserAccount` Durable Object holding the connection. */
  userObjectId: string;
  /** What the binding covers, by stable ID. */
  scope: SharePointScope;
};
