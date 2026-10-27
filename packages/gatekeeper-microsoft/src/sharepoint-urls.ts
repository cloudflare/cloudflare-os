// SharePoint and OneDrive URLs, without asking Graph anything: which ones this gatekeeper accepts,
// the canonical URL of "everything", and the `/shares` ID Graph resolves a URL by. Which object a
// URL names is decided by Graph (sharepoint-resolve.ts): SharePoint paths are ambiguous, since
// `/sites/X/Foo` could be a library, a subsite, or a folder.

/**
 * A SharePoint Online host: the tenant's own, or its OneDrive `-my` host. The tenant part is lazy so
 * that `contoso-my` reads as contoso's OneDrive, not as a tenant named `contoso-my`; SharePoint tenant
 * names cannot contain hyphens, so nothing real is read the other way.
 */
const SHAREPOINT_HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}?[a-z0-9])??)(-my)?\.sharepoint\.com$/;

/** The tenant and kind a SharePoint host belongs to. */
export type SharePointHost = { tenant: string; personal: boolean };

/** The tenant a SharePoint host belongs to, or null for any other host. */
export function parseSharePointHost(hostname: string): SharePointHost | null {
  const match = SHAREPOINT_HOST.exec(hostname.toLowerCase());
  if (!match) return null;
  return { tenant: match[1], personal: match[2] !== undefined };
}

/** A URL this gatekeeper may resolve: https, on a SharePoint host, with no credentials or odd port. */
export function parseSharePointUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (url.port !== "" && url.port !== "443") return null;
  if (parseSharePointHost(url.hostname) === null) return null;
  url.hash = "";
  return url;
}

/** The SharePoint start page, which lists every site the user can open: the URL of "everything". */
export function allUrl(tenant: string): string {
  return `https://${tenant}.sharepoint.com/_layouts/15/sharepoint.aspx`;
}

/** Whether a URL names everything: the SharePoint start page, on either host. */
export function isAllUrl(url: URL): boolean {
  return /^\/_layouts\/15\/sharepoint\.aspx$/i.test(url.pathname);
}

/**
 * The managed paths a site collection can live under. A URL whose path is exactly one of these
 * plus a name (or the host root) can only be a site, and is resolved as one first.
 */
const SITE_ROOT = /^\/(?:(?:sites|teams|personal|portals)\/[^/]+)?\/?$/i;

/** Whether a URL's path is a site collection's root, so the URL can name nothing but the site. */
export function isSiteRootPath(url: URL): boolean {
  return SITE_ROOT.test(url.pathname) && url.search === "";
}

/**
 * The URL in the form SharePoint's own browser UI produces, which is the form Graph's `/shares`
 * resolves. A folder view's `?id=` is the folder's server-relative path, and a path pasted after
 * one round of decoding (or encoded twice) is refused by Graph with a 403, so it is normalized to
 * a single round of `encodeURIComponent`. Other query parameters that only steer the browser view
 * are dropped.
 */
export function normalizeForShares(url: URL): string {
  const copy = new URL(url.href);
  const keep = new Map<string, string>();
  for (const [key, value] of copy.searchParams) {
    const lower = key.toLowerCase();
    if (lower === "id" || lower === "sourcedoc" || lower === "file" || lower === "d") keep.set(key, value);
  }
  if (keep.size === 0) {
    copy.search = "";
    return copy.href;
  }
  const query = [...keep].map(([key, value]) => {
    let decoded = value;
    // Undo any extra rounds of encoding before applying exactly one.
    for (let round = 0; round < 3 && /%[0-9a-f]{2}/i.test(decoded); round++) {
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        break;
      }
    }
    return `${key}=${encodeURIComponent(decoded)}`;
  }).join("&");
  return `${copy.origin}${copy.pathname}?${query}`;
}

/** Graph's sharing ID for a URL: `u!` plus the unpadded base64url of the URL. */
export function shareIdFor(url: string): string {
  const bytes = new TextEncoder().encode(url);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `u!${btoa(binary).replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-")}`;
}

/**
 * The web a URL names when it names nothing inside one, for `GET /sites/{host}:/{path}`: the path
 * itself (`/sites/Eng`, `/sites/Eng/Sub`, `/`), or the web of a plain `_layouts` page such as site
 * contents. Null for a link into a web's contents: its libraries, lists, pages and files resolve by
 * their own facets, and one they can't resolve is refused rather than widened to its web.
 */
export function sitePathNamed(url: URL): string | null {
  const segments = url.pathname.split("/").filter(segment => segment !== "");
  // The first segment SharePoint reserves for something other than a web; a OneDrive
  // (`/personal/<user>`) has no webs below it.
  const stop = segments.findIndex((segment, index) =>
    /^(_layouts|_api|_vti_bin|Forms|Lists|SitePages|Shared%20Documents|Shared Documents)$/i.test(segment)
    || (index === 2 && /^personal$/i.test(segments[0]!)));
  if (stop !== -1 && !(/^_layouts$/i.test(segments[stop]!) && url.search === "")) return null;
  return `/${segments.slice(0, stop === -1 ? segments.length : stop).join("/")}`;
}

/** Whether a URL points into a site's pages library. */
export function isSitePagesUrl(url: URL): boolean {
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A stray `%` is a literal one; the encoded path still answers.
  }
  return /\/SitePages\/[^/]+\.aspx$/i.test(path);
}
