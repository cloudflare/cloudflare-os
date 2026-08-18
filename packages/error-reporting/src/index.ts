import {
  MAX_MESSAGE_CHARS,
  MAX_STACK_CHARS,
  MAX_STRING_CHARS,
  serializeException,
  type ErrorExceptionV1,
} from "./serialize-exception.js";

export {
  MAX_MESSAGE_CHARS,
  MAX_STACK_CHARS,
  MAX_STRING_CHARS,
  serializeException,
  type ErrorExceptionV1,
} from "./serialize-exception.js";

/** Maximum retained scalar attributes in a Worker-side event. */
export const MAX_ATTRIBUTE_KEYS = 32;
/** Message discriminator used by trusted, opaque-origin UI frames. */
export const FRONTEND_ERROR_MESSAGE_TYPE = "gadgets.frontend-error.v1";

/** A bounded, vendor-neutral error occurrence sent to an internal Reporter. */
export type ErrorEventV1 = Readonly<{
  schemaVersion: 1;
  occurrenceId: string;
  occurredAt: string;
  failureSite: string;
  severity: "warning" | "error" | "fatal";
  handled: boolean;
  exception?: ErrorExceptionV1;
  correlation?: Readonly<{ rayId?: string; requestId?: string }>;
  http?: Readonly<{
    kind: "server" | "client";
    method?: string;
    routeTemplate?: string;
    responseStatusCode?: number;
  }>;
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
  truncated?: true;
}>;

/** Trusted producer metadata configured on each Reporter service binding. */
export type ErrorReporterProps = Readonly<{
  service: string;
  release?: string;
  environment?: string;
}>;

/** Optional Worker-side context already available at an explicit capture site. */
export type ErrorReportOptions = Readonly<{
  handled?: boolean;
  severity?: ErrorEventV1["severity"];
  correlation?: ErrorEventV1["correlation"];
  http?: ErrorEventV1["http"];
  attributes?: Readonly<Record<string, unknown>>;
}>;

/** A trusted UI surface that can produce frontend error reports. */
export type FrontendErrorSurface = "workshop" | "gatekeeper-app" | "configurator";

/** How a frontend failure was captured. */
export type FrontendCaptureMechanism =
  | "window.error"
  | "unhandledrejection"
  | "react"
  | "explicit";

/** Coarse browser telemetry for issue triage; never authoritative for identity or access. */
export type FrontendBrowserFacts = Readonly<{
  family?: "Chromium" | "Firefox" | "Safari" | "Other";
  platform?: "Windows" | "macOS" | "Linux" | "Android" | "iOS" | "Other";
  mobile?: boolean;
}>;

/** Untrusted, bounded browser telemetry; no field in this report conveys authority. */
export type FrontendErrorReportV1 = Readonly<{
  schemaVersion: 1;
  failureSite: string;
  severity: ErrorEventV1["severity"];
  handled: boolean;
  captureMechanism: FrontendCaptureMechanism;
  surface: FrontendErrorSurface;
  sessionId?: string;
  /**
   * Origin and pathname of the host page where the failure was captured.
   *
   * Rebuilt by `normalizePageLocation`, so credentials, query and fragment are all excluded and
   * URL-borne secrets never leave the tab — notably the `#share=` bearer capability.
   */
  pageLocation?: string;
  /**
   * Diagnostic user identifier as *reported* by the client, which is what the name records. Not
   * authoritative: it is an unverified claim, and nothing may read it to make a decision or grant
   * access.
   */
  reportedUserId?: string;
  exception?: ErrorExceptionV1;
  gadgetId?: string;
  gatekeeperVendorId?: string;
  browser?: FrontendBrowserFacts;
  truncated?: true;
}>;

/** Failure data owned by a trusted opaque-origin frame. */
export type FrontendFrameErrorReportV1 = Pick<
  FrontendErrorReportV1,
  "failureSite" | "severity" | "handled" | "captureMechanism" | "exception"
>;

type BrowserFamily = NonNullable<FrontendBrowserFacts["family"]>;
type BrowserPlatform = NonNullable<FrontendBrowserFacts["platform"]>;

const severities = new Set<ErrorEventV1["severity"]>(["warning", "error", "fatal"]);
const mechanisms = new Set<FrontendCaptureMechanism>([
  "window.error", "unhandledrejection", "react", "explicit",
]);
const surfaces = new Set<FrontendErrorSurface>(["workshop", "gatekeeper-app", "configurator"]);
const browserFamilies = new Set<BrowserFamily>(["Chromium", "Firefox", "Safari", "Other"]);
const browserPlatforms = new Set<BrowserPlatform>([
  "Windows", "macOS", "Linux", "Android", "iOS", "Other",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(object: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(object, key)?.value;
}

function allowlistedString<T extends string>(
    value: unknown, allowed: ReadonlySet<T>): T | undefined {
  return typeof value === "string" && allowed.has(value as T) ? value as T : undefined;
}

function clipped(value: string, maximum: number): { value: string; truncated: boolean } {
  return value.length <= maximum
    ? { value, truncated: false }
    : { value: value.slice(0, maximum), truncated: true };
}

/**
 * Reduces a URL to its origin and pathname, or `undefined` when it is not an ordinary page URL.
 *
 * Rebuilt from the parsed URL rather than trimmed as text, because an `href` retains any
 * `user:password@` credentials, which a textual strip of the query and fragment would carry
 * through to the Reporter. Only `http(s)` survives, which is what makes the concatenation safe:
 * every other scheme either has an opaque origin that serializes to a meaningless `"null"` prefix,
 * or keeps its content in the path, as `data:` does.
 */
export function normalizePageLocation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return `${url.origin}${url.pathname}`;
}

function boundedString(
    value: unknown, maximum: number, mark: () => void): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const result = clipped(value, maximum);
  if (result.truncated) mark();
  return result.value;
}

/**
 * Bounds a captured page location, reduced to origin and pathname.
 *
 * The Workshop producer already sends that shape, but this is the trust boundary: the endpoint
 * carries no credential, so any client can claim any string, and it is dropped here rather than
 * relying on every present and future producer to have dropped it.
 */
function boundedPageLocation(value: unknown, mark: () => void): string | undefined {
  // Normalize before bounding so a long query never consumes the budget for the part we keep, and
  // so a policy strip is not reported as a truncated value.
  return boundedString(normalizePageLocation(value), MAX_STRING_CHARS, mark);
}

function boundedContent(
    value: unknown, maximum: number, mark: () => void): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = clipped(value, maximum);
  if (result.truncated) mark();
  return result.value;
}

function normalizeException(value: unknown, mark: () => void): ErrorExceptionV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    const exception = serializeException(value);
    if (exception.truncated) mark();
    return exception;
  }

  let truncated = ownValue(value, "truncated") === true;
  const markException = () => { truncated = true; };
  const type = boundedString(ownValue(value, "type"), MAX_STRING_CHARS, markException) ?? "Error";
  const message = boundedContent(ownValue(value, "message"), MAX_MESSAGE_CHARS, markException);
  const stack = boundedContent(ownValue(value, "stack"), MAX_STACK_CHARS, markException);
  if (truncated) mark();
  return {
    type,
    ...(message !== undefined && { message }),
    ...(stack !== undefined && { stack }),
    ...(truncated && { truncated: true }),
  };
}

function normalizeFrameReport(
    input: unknown,
    fallbackSite: string,
    mark: () => void = () => {},
): FrontendFrameErrorReportV1 | null {
  if (!isRecord(input)) return null;
  const handledValue = ownValue(input, "handled");
  const exception = normalizeException(ownValue(input, "exception"), mark);
  return {
    failureSite: boundedString(ownValue(input, "failureSite"), MAX_STRING_CHARS, mark)
      ?? fallbackSite,
    severity: allowlistedString(ownValue(input, "severity"), severities) ?? "error",
    handled: typeof handledValue === "boolean" ? handledValue : true,
    captureMechanism: allowlistedString(ownValue(input, "captureMechanism"), mechanisms)
      ?? "explicit",
    ...(exception && { exception }),
  };
}

function normalizeBrowser(value: unknown): FrontendBrowserFacts | undefined {
  if (!isRecord(value)) return undefined;
  const mobileValue = ownValue(value, "mobile");
  const family = allowlistedString(ownValue(value, "family"), browserFamilies);
  const platform = allowlistedString(ownValue(value, "platform"), browserPlatforms);
  const mobile = typeof mobileValue === "boolean" ? mobileValue : undefined;
  if (family === undefined && platform === undefined && mobile === undefined) return undefined;
  return {
    ...(family !== undefined && { family }),
    ...(platform !== undefined && { platform }),
    ...(mobile !== undefined && { mobile }),
  };
}

/** Normalizes an untrusted frontend HTTP report into a fresh, bounded allowlisted object. */
export function normalizeFrontendErrorReport(input: unknown): FrontendErrorReportV1 | null {
  try {
    if (!isRecord(input) || ownValue(input, "schemaVersion") !== 1) return null;
    let truncated = ownValue(input, "truncated") === true;
    const mark = () => { truncated = true; };
    const frame = normalizeFrameReport(input, "browser.unknown", mark);
    if (!frame) return null;
    const surfaceValue = ownValue(input, "surface");
    const sessionId = boundedString(ownValue(input, "sessionId"), MAX_STRING_CHARS, mark);
    const pageLocation = boundedPageLocation(ownValue(input, "pageLocation"), mark);
    const reportedUserId = boundedString(ownValue(input, "reportedUserId"), MAX_STRING_CHARS, mark);
    const gadgetId = boundedString(ownValue(input, "gadgetId"), MAX_STRING_CHARS, mark);
    const gatekeeperVendorId = boundedString(
      ownValue(input, "gatekeeperVendorId"), MAX_STRING_CHARS, mark,
    );
    const browser = normalizeBrowser(ownValue(input, "browser"));
    return {
      schemaVersion: 1,
      ...frame,
      surface: allowlistedString(surfaceValue, surfaces) ?? "workshop",
      ...(sessionId && { sessionId }),
      ...(pageLocation && { pageLocation }),
      ...(reportedUserId && { reportedUserId }),
      ...(gadgetId !== undefined && { gadgetId }),
      ...(gatekeeperVendorId !== undefined && { gatekeeperVendorId }),
      ...(browser && { browser }),
      ...(truncated && { truncated: true }),
    };
  } catch {
    return null;
  }
}

/** Extracts a normalized report from an untrusted frame-message envelope. */
export function extractFrontendFrameReport(value: unknown): FrontendFrameErrorReportV1 | null {
  try {
    if (!isRecord(value) || ownValue(value, "type") !== FRONTEND_ERROR_MESSAGE_TYPE) return null;
    return normalizeFrameReport(ownValue(value, "report"), "frame.unknown");
  } catch {
    return null;
  }
}
