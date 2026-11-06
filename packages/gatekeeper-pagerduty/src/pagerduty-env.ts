// Configuration shared by every part of the PagerDuty gatekeeper: the Worker's environment,
// PagerDuty's endpoints, the connectable resources with their URL patterns, and the OAuth scopes a
// connection needs.

import { stripTrailingSlashes, type SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { PreviewOAuthEnv } from "@gadgets/gatekeeper-kit/preview-oauth";

/** The vendor id: the router's `/gatekeeper/pagerduty/` path segment, and the log attribution. */
export const VENDOR_ID = "pagerduty";

/** The Worker's environment. The OAuth client is required; everything else is optional. */
export type Env = Cloudflare.Env & PreviewOAuthEnv & {
  /** This Worker's public base URL, ending in `/gatekeeper/pagerduty`. */
  BASE_URL?: string;
  /** The Scoped OAuth app's client ID. */
  CLIENT_ID?: string;
  /** The Scoped OAuth app's client secret. */
  CLIENT_SECRET?: string;
  /**
   * The signing secret of the account's Generic Webhook (v3) subscription, which delivers to
   * `{BASE_URL}/webhook`. Hooks are refused while it is unset.
   */
  PAGERDUTY_WEBHOOK_SECRET?: string;
};

/** The browser-facing authorization page, shared by every region. */
export const AUTHORIZE_URL = "https://identity.pagerduty.com/oauth/authorize";
/** The token endpoint, for code exchange and refresh. PagerDuty documents no revocation endpoint. */
export const TOKEN_URL = "https://identity.pagerduty.com/oauth/token";
/** Who signs the ID tokens that say which user, account and region a grant belongs to. */
export const ID_TOKEN_ISSUER = "https://identity.pagerduty.com/global/oauth/anonymous";
/** The issuer's signing keys. */
export const ID_TOKEN_JWKS_URL = `${ID_TOKEN_ISSUER}/jwks`;

/** The two regions an account can live in; each has its own REST and web hosts. */
export type Region = "us" | "eu";

/** An account, as its web address names it. */
export type Tenant = { region: Region; subdomain: string };

/** Where REST requests for an account in `region` go. */
export function apiOrigin(region: Region): string {
  return region === "eu" ? "https://api.eu.pagerduty.com" : "https://api.pagerduty.com";
}

/** The account's web app, e.g. `https://acme.eu.pagerduty.com`. */
export function webOrigin({ region, subdomain }: Tenant): string {
  return `https://${subdomain}${region === "eu" ? ".eu" : ""}.pagerduty.com`;
}

/** This Worker's public base URL, without a trailing slash. */
export function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/pagerduty");
}

export function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

/** The OAuth callback registered with the PagerDuty app. */
export function getRedirectUri(env: Env): string {
  return `${getBaseUrl(env)}/oauth`;
}

/** The kinds of resource a binding can be. */
export type ResourceKind = "account" | "team" | "service" | "incident" | "schedule";

/** Props baked into the gatekeeper Durable Object class for one binding. */
export type PagerDutyGatekeeperImplProps = Tenant & {
  /** The `UserAccount` Durable Object holding the connection. */
  userObjectId: string;
} & (
  | { resourceKind: "account" }
  | { resourceKind: "team" | "service" | "incident" | "schedule"; id: string }
);

/** Every account host, US or EU. */
const HOST = "https://:subdomain{.eu}?.pagerduty.com";
/** A PagerDuty object ID, e.g. `PABC123`, with any page beneath it. */
const object = (path: string, group: string) => `${HOST}/${path}/:${group}([A-Z0-9]+){/*}?`;

const ACCOUNT_PATTERN = `${HOST}/`;

/**
 * The connectable resources. They share the account's connect card, since one configurator picks
 * any of them; each is granted with the same scopes, so a connection holds all five or none.
 */
export const RESOURCES: Record<ResourceKind, SupportedResource> = {
  account: {
    urlPattern: ACCOUNT_PATTERN,
    title: "PagerDuty Account",
    description: "Every incident, service, team and on-call schedule you can see, and acting on " +
      "incidents and schedules as you.",
  },
  team: {
    urlPattern: object("teams", "teamId"),
    title: "PagerDuty Team",
    description: "One team's services and their incidents, its schedules and members.",
    groupedWith: ACCOUNT_PATTERN,
  },
  service: {
    urlPattern: object("service-directory", "serviceId"),
    title: "PagerDuty Service",
    description: "One service and its incidents, and opening new incidents on it.",
    groupedWith: ACCOUNT_PATTERN,
  },
  incident: {
    urlPattern: object("incidents", "incidentId"),
    title: "PagerDuty Incident",
    description: "One incident: read it, acknowledge, resolve, reassign, and add notes.",
    groupedWith: ACCOUNT_PATTERN,
  },
  schedule: {
    urlPattern: object("schedules", "scheduleId"),
    title: "PagerDuty Schedule",
    description: "One on-call schedule: who is on call when, and its overrides.",
    groupedWith: ACCOUNT_PATTERN,
  },
};

/** The resources in the order the picker lists them: whole account first. */
export const ALL_RESOURCES: SupportedResource[] = Object.values(RESOURCES);

/**
 * The scopes every connection asks for: exactly what the endpoints this gatekeeper calls require.
 * PagerDuty drops a scope the app was not granted without saying so, so the granted list is
 * checked against this one (see `missingScopes`).
 */
export const SCOPES = [
  "incidents.read", "incidents.write", "services.read", "teams.read", "users.read",
  "schedules.read", "schedules.write", "oncalls.read", "priorities.read", "escalation_policies.read",
] as const;

/** The required scopes a grant lacks. */
export function missingScopes(granted: readonly string[]): string[] {
  const have = new Set(granted);
  return SCOPES.filter(scope => !have.has(scope));
}
