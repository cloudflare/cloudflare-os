// The web links this gatekeeper binds, parsed and built in one place.

import { WEB_ORIGIN } from "./acme-env";

/** An item ID as the provider writes it. */
export const ITEM_ID = /^[A-Za-z0-9_-]+$/;

/** What a bindable link names; null for any other URL. */
export function parseResourceUrl(input: string): { itemId: string } | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const match = /^\/items\/([A-Za-z0-9_-]+)(?:\/.*)?$/.exec(url.pathname);
  if (url.origin !== WEB_ORIGIN || !match) return null;
  return { itemId: match[1] };
}

/** The canonical link to an item. */
export function itemUrl(itemId: string): string {
  return `${WEB_ORIGIN}/items/${encodeURIComponent(itemId)}`;
}
