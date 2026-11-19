// Configuration shared by every part of the Acme Service gatekeeper: the Worker's environment,
// the provider's origins, and the connectable resources with their URL patterns.

import { stripTrailingSlashes, type SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { AuthEnv } from "./acme-auth";

/** The vendor id: the router's `/gatekeeper/acme/` path segment, and the log attribution. */
export const VENDOR_ID = "acme";

/** The Worker's environment. */
export type Env = Cloudflare.Env & AuthEnv & {
  /** This Worker's public base URL, ending in `/gatekeeper/acme`. */
  BASE_URL?: string;
};

// STOP(origins): The provider's API and web origins. If either varies by account (a region, a
// tenant subdomain, a self-hosted instance), carry what selects it in the identity and the
// binding's props instead of a constant.
/** Where API requests go. */
export const API_ORIGIN = "https://api.acme.example";
/** The web app, whose links name resources. */
export const WEB_ORIGIN = "https://acme.example";

/** This Worker's public base URL, without a trailing slash. */
export function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/acme");
}

export function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

/** Props baked into the gatekeeper Durable Object class for one binding. */
export type AcmeGatekeeperImplProps = {
  /** The `UserAccount` Durable Object holding the connection. */
  userObjectId: string;
  itemId: string;
};

// STOP(resources): The connectable resource types. Choose each one's granularity and observer
// strategy first (see the write-gatekeeper skill). An `id` is stored with every binding of its
// type, so it can't change once shipped.
/** One item, by its page in the web app. */
export const ITEM_RESOURCE: SupportedResource = {
  id: "item",
  urlPattern: `${WEB_ORIGIN}/items/:itemId([A-Za-z0-9_-]+){/*}?`,
  title: "Acme Service Item",
  description: "One item: read it, and rename it once you approve.",
};

/** The resources in the order the picker lists them. */
export const ALL_RESOURCES: SupportedResource[] = [ITEM_RESOURCE];
