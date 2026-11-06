// PagerDuty's web addresses: which resource a link names, the link for a resource, and the ID
// grammar every agent-supplied ID is held to before it reaches a request path.

import { RESOURCES, apiOrigin, webOrigin, type Region, type ResourceKind, type Tenant } from "./pagerduty-env";

/** The resource a link names: an account, or one object in it. */
export type ResourceRef = Tenant & (
  | { kind: "account" }
  | { kind: Exclude<ResourceKind, "account">; id: string }
);

/** An object ID, e.g. `PABC123` or `Q2W3E4R5T6Y7U8`. */
export const OBJECT_ID = /^[A-Z0-9]{1,64}$/;
/** An account-wide incident number, e.g. `12345`. */
export const INCIDENT_NUMBER = /^[1-9][0-9]{0,15}$/;

const PATTERNS = (Object.entries(RESOURCES) as [ResourceKind, { urlPattern: string }][])
  .map(([kind, { urlPattern }]) => [kind, new URLPattern(urlPattern)] as const);

/** The path segment each object kind's links use. */
const PATHS: Record<Exclude<ResourceKind, "account">, string> = {
  team: "teams",
  service: "service-directory",
  incident: "incidents",
  schedule: "schedules",
};

/** The resource `url` names, or null for a link that is not a PagerDuty resource. */
export function parseResourceUrl(url: string): ResourceRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  for (const [kind, pattern] of PATTERNS) {
    const match = pattern.exec(parsed.href);
    if (!match) continue;
    const { hostname: { groups: host }, pathname: { groups: path } } = match;
    const region: Region = parsed.hostname.endsWith(".eu.pagerduty.com") ? "eu" : "us";
    const tenant: Tenant = { subdomain: host.subdomain!, region };
    if (kind === "account") return { ...tenant, kind };
    const id = Object.entries(path).find(([name]) => name.endsWith("Id"))?.[1];
    return id && OBJECT_ID.test(id) ? { ...tenant, kind, id } : null;
  }
  return null;
}

/** The canonical link for a resource. */
export function resourceUrl(ref: ResourceRef): string {
  return ref.kind === "account" ? `${webOrigin(ref)}/` : `${webOrigin(ref)}/${PATHS[ref.kind]}/${ref.id}`;
}

/**
 * An agent-supplied object ID, checked before it reaches a request path.
 * @throws Error naming `what` for anything else.
 */
export function objectId(value: string, what: string): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) {
    throw new Error(`${what} must be a PagerDuty ID, such as "PABC123".`);
  }
  return value;
}

/** Whether two tenants are the same account address. */
export function sameTenant(a: Tenant, b: Tenant): boolean {
  return a.region === b.region && a.subdomain === b.subdomain;
}

/**
 * The region an ID token's claims put the account in, or `undefined` when they don't say. PagerDuty
 * lists the account's REST origin, exactly, among the audiences beside the client ID.
 */
export function regionOf(claims: { aud?: string | string[]; region?: unknown }): Region | undefined {
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud ?? [];
  if (audiences.includes(apiOrigin("eu"))) return "eu";
  if (audiences.includes(apiOrigin("us"))) return "us";
  if (typeof claims.region !== "string") return undefined;
  if (/^(us|unitedstates)$/i.test(claims.region)) return "us";
  if (/^(eu|europe|europeanunion)$/i.test(claims.region)) return "eu";
  return undefined;
}
