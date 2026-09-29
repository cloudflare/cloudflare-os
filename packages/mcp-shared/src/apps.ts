// The MCP Apps (`io.modelcontextprotocol/ui`) vocabulary: what a tool or resource declares, what the
// host promises a sidecar window, and the bounds applied to both.
//
// It is its own module rather than part of `client.ts` because the specification leaves several
// things open and this is where each is decided, in one direction: a host may narrow what a server
// declared and may never widen it. A declared domain is read as one CSP source expression or not at
// all, a declared permission is a presence flag, and a document or a result is capped before
// anything renders it. The account, the JSON-RPC gateway, and the sidecar page all need those same
// answers, so they live here behind no Durable Object, no storage, and no environment.
//
// Nothing in this file knows about a binding, a token, or a request. `apps.ts` is the protocol; the
// parts that authenticate a link or route a message are in `account.ts` and `app-gateway.ts`.

import type { McpTool } from "./client.js";
import type { ToolScope } from "./scope.js";
import type { ServerTrust } from "./tools.js";

/** Extension identifier from the MCP Apps specification. */
export const APP_EXTENSION_ID = "io.modelcontextprotocol/ui";
/** The media type every app document is served as; the specification's type adds a profile. */
export const APP_MEDIA_TYPE = "text/html";
/** The content type the MCP Apps specification defines for a UI resource. */
export const APP_MIME_TYPE = `${APP_MEDIA_TYPE};profile=mcp-app`;
/**
 * The content types this host declares it renders in `initialize`.
 *
 * The bare media type is declared beside the specification's profile because servers written before
 * the profile existed -- the playground servers a user pastes in, in practice -- serve it, and a
 * declaration only listing one type reads as a host that would refuse the other. What makes a
 * document an app is its `ui://` URI and the association that named it, never the type string: both
 * spellings are untrusted and both are rendered in the same sandbox.
 */
export const APP_MIME_TYPES: readonly string[] = [APP_MIME_TYPE, APP_MEDIA_TYPE];
/** Longest `ui://` URI this host accepts, matching the bound the catalog clamps a tool's against. */
export const MAX_UI_URI_CHARS = 2048;
/** Every UI resource URI starts with this. The spec defines nothing past the prefix. */
export const UI_URI_PREFIX = "ui://";
/** MCP Apps protocol version this host speaks, echoed in `ui/initialize`. */
export const APP_PROTOCOL_VERSION = "2026-01-26";
/** JSON-RPC error code for a call the binding is not allowed to make from an app. */
export const APP_ERROR_NOT_PERMITTED = -32001;

// Document and result budgets, chosen against limits the deployment already has. A document over
// half of the transport's `MAX_RESPONSE_BYTES` could not have arrived in one piece anyway, and a
// result at half of the 128 KiB Durable Object value limit leaves the account room to keep one
// beside the token record it is stored in.
/** Largest app document this host renders, in bytes. */
export const MAX_APP_HTML_BYTES = 512 * 1024;
/** Largest tool result a sidecar window is sent, in bytes. */
export const MAX_APP_RESULT_BYTES = 64 * 1024;
// What one resource may declare, per directive and per domain. A declaration is server-controlled,
// and its result is both logged for review and applied as a policy, so it is bounded by construction
// rather than by the server's restraint. Entries past either bound are dropped rather than
// truncated, and a domain that is not a plain origin is dropped too: a half-written source in a
// policy is not the source the server meant, and a policy is only as trustworthy as its worst token.
/** Most declared domains this host accepts for one directive. */
export const MAX_APP_CSP_DOMAINS = 8;
/** Longest declared domain this host accepts, in characters. */
export const MAX_APP_CSP_DOMAIN_CHARS = 256;

const encoder = new TextEncoder();

// Room kept for the result's own JSON: `{"content":[]}` plus the keys a bounded result may carry
// beside it, so the whole value stays inside `MAX_APP_RESULT_BYTES` rather than that plus a tail.
const RESULT_ENVELOPE_BYTES = 64;

// Bytes of the block envelope and the marker, reserved before deciding how much text fits: every
// clipped block is `{"type":"text","text":"<prefix>…"}` and nothing else.
const ELLIPSIS = "\u2026";
const TEXT_BLOCK_BYTES = encoder.encode(`{"type":"text","text":""}`).byteLength
  + encoder.encode(ELLIPSIS).byteLength;

/** Everything a read needs about the binding an app belongs to, without the facet that minted it. */
export type AppBinding = {
  /** MCP endpoint URL. */
  endpoint: string;
  /** Display name of the server, for error text. */
  serverName: string;
  /** The grant this binding was created with; every app call is checked against it. */
  scope: ToolScope;
  /** How far this endpoint's self-description is trusted (see `tools.ts`). */
  trust: ServerTrust;
  /**
   * Prefix this endpoint serves its resources under, when it renames them.
   *
   * A portal does: it lists and reads an upstream resource as `{serverId}_{uri}`, so the URI the
   * upstream server declared is answered with "Resource not found" (see `portalResourcePrefix`).
   * Absent for every endpoint that serves a resource under the URI it declared. The declared URI
   * stays the link's identity and the name its window asks for either way.
   */
  resourceUriPrefix?: string;
};

/** The tool call whose result the sidecar opens on. */
export type AppCallSnapshot = {
  toolName: string;
  /** The arguments the agent passed. */
  input: unknown;
  /** The server's result, bounded; absent when it was too large to keep. */
  result?: unknown;
};

/** Everything the sidecar page needs to render, resolved at page-load time. */
export type AppViewPage = {
  /** The `ui://` resource being rendered. */
  uri: string;
  title?: string;
  /** The app's HTML document, straight from the server. */
  html: string;
  /** CSP the sandbox proxy must apply to the app document. */
  csp: string;
  /** `allow` attribute for the app frame, from the resource's declared permissions; absent when none. */
  allow?: string;
  call?: AppCallSnapshot;
};

/** Why a sidecar page could not be rendered. Shown to the user verbatim. */
export type AppViewRefusal = { refusal: string };

/** A serialized JSON-RPC reply, ready to send. */
export type AppRpcReply = { body: string; status: number };

/** The CSP and permissions a `ui://` resource declared under `_meta.ui`. */
export type McpAppResourceMeta = {
  /** Origins the document may load from, by directive. */
  csp?: McpAppResourceCsp;
  /** Browser features the document may request. */
  permissions?: McpAppResourcePermissions;
};

/** The domains a resource declared, each optional. Everything absent is the restrictive default. */
export type McpAppResourceCsp = {
  /** Origins `connect-src` allows: `fetch`, XHR, and WebSocket targets. */
  connectDomains?: string[];
  /** Origins scripts, styles, images, fonts, and media may be loaded from. */
  resourceDomains?: string[];
  /** Origins a nested iframe may be loaded from (`frame-src`). */
  frameDomains?: string[];
  /** Origins a `<base href>` may point at (`base-uri`). */
  baseUriDomains?: string[];
};

/**
 * The browser features a resource asked for.
 *
 * The specification declares one as a bare presence -- `camera: {}` -- while an iframe `allow`
 * attribute is built from a fixed list of feature names, so the wire form is normalized here to a
 * boolean per feature: true for one the resource asked for, false for one it did not mention.
 */
export type McpAppResourcePermissions = {
  camera?: boolean;
  microphone?: boolean;
  geolocation?: boolean;
  clipboardWrite?: boolean;
};

/** The parts of a tool result the app protocol reads. */
export type AppResultLike = {
  /** Result-level metadata; a server may name its UI resource here. */
  _meta?: unknown;
  /** Content blocks, as the server returned them. */
  content?: readonly unknown[];
  /** The server's structured output, when it declared one. */
  structuredContent?: unknown;
  /** True when the tool itself reported failure (the call succeeded; the tool did not). */
  isError?: boolean;
};

/** The MCP-shaped tool result a sidecar window receives, bounded to what it can render. */
export type AppToolResult = {
  /** Content blocks, in the order the server returned them. */
  content: unknown[];
  /** The server's structured output, when it fitted beside the content. */
  structuredContent?: unknown;
  isError?: boolean;
};

/** Whether a URI names a `ui://` resource. The specification defines nothing past the prefix. */
export function isUiUri(uri: string): boolean {
  return uri.startsWith(UI_URI_PREFIX);
}

/**
 * The URI to read one app resource by, on the binding that minted its link.
 *
 * A link names a resource the way its server declared it, and that is the name its window asks for;
 * this is only what the binding has to send to reach the same resource, which differs for an
 * endpoint that renames (see `AppBinding.resourceUriPrefix`).
 */
export function appResourceUri(binding: AppBinding, uri: string): string {
  return `${binding.resourceUriPrefix ?? ""}${uri}`;
}

/**
 * Whether a resource's declared content type names a document this host renders.
 *
 * Compared on the media type alone, so the specification's profile type, a bare `text/html`, and
 * either carrying a `charset` parameter all read as the same document.
 */
export function isAppMimeType(mimeType: string | undefined): boolean {
  return mimeType !== undefined && mediaType(mimeType) === APP_MEDIA_TYPE;
}

// The media type out of a declared content type, without its parameters. Split by hand rather than
// by index access so it needs no non-null assertion.
function mediaType(declared: string): string {
  const separator = declared.indexOf(";");
  return (separator === -1 ? declared : declared.slice(0, separator)).trim().toLowerCase();
}

// A value that names a resource this host will mint a link for. Bounded as well as prefixed: the URI
// is written to the action that produced it and into the token record for its link, and a server
// chooses its length. A URI past the bound is ignored rather than truncated, since the prefix that
// survived would name a different resource than the server meant.
function usableUri(value: unknown): string | undefined {
  return typeof value === "string" && isUiUri(value) && value.length <= MAX_UI_URI_CHARS
    ? value
    : undefined;
}

/**
 * The `ui://` resource a tool renders its results with, if it declared one.
 *
 * `clampToolDefinition` folds the deprecated flat `_meta["ui/resourceUri"]` into the nested field,
 * so this reads one spelling. A value that is not a `ui://` URI is ignored rather than refused: a
 * tool with a broken association is still a working tool.
 */
export function toolUiResourceUri(tool: McpTool): string | undefined {
  const uri = tool.ui?.resourceUri;
  return uri !== undefined && isUiUri(uri) ? uri : undefined;
}

/**
 * The `ui://` resource a result points at, if it points at one.
 *
 * Result-level metadata wins over a content block: it is the server's statement about the result,
 * where a block is only the data the tool happened to return. Only `ui://` URIs count, so a result
 * that carries an ordinary resource cannot mint a sidecar link.
 */
export function uiResourceUriInResult(result: AppResultLike): string | undefined {
  const declared = usableUri(asRecord(asRecord(result._meta)?.ui)?.resourceUri);
  if (declared !== undefined) return declared;

  for (const block of result.content ?? []) {
    const content = asRecord(block);
    let uri: unknown;
    if (content?.type === "resource") uri = asRecord(content.resource)?.uri;
    else if (content?.type === "resource_link") uri = content.uri;
    const usable = usableUri(uri);
    if (usable !== undefined) return usable;
  }
  return undefined;
}

/** Whether a tool may appear in the agent's tool list. Absent visibility means both sides. */
export function toolVisibleToModel(tool: McpTool): boolean {
  const visibility = tool.ui?.visibility;
  return visibility === undefined || visibility.includes("model");
}

/** Whether a tool may be called from an app. Absent visibility means both sides. */
export function toolVisibleToApp(tool: McpTool): boolean {
  const visibility = tool.ui?.visibility;
  return visibility === undefined || visibility.includes("app");
}

/**
 * Reads a resource's `_meta.ui` as the fields this host understands, dropping everything else.
 *
 * A declared domain is kept only as a string list; anything else reads as "not declared", which the
 * policy below treats as the restrictive default. The values themselves are checked where they are
 * used, since a string list is not yet a list of source expressions.
 */
export function clampResourceMeta(value: unknown): McpAppResourceMeta | undefined {
  const declared = asRecord(value);
  if (!declared) return undefined;
  const csp = asRecord(declared.csp);
  const permissions = asRecord(declared.permissions);
  return {
    csp: csp && {
      connectDomains: clampDomains(csp.connectDomains),
      resourceDomains: clampDomains(csp.resourceDomains),
      frameDomains: clampDomains(csp.frameDomains),
      baseUriDomains: clampDomains(csp.baseUriDomains),
    },
    permissions: permissions && {
      camera: declaredPermission(permissions.camera),
      microphone: declaredPermission(permissions.microphone),
      geolocation: declaredPermission(permissions.geolocation),
      clipboardWrite: declaredPermission(permissions.clipboardWrite),
    },
  };
}

// A permission is declared as a present value -- the specification writes `camera: {}` -- so
// anything present and not explicitly refused counts as asked for.
function declaredPermission(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/**
 * The CSP the sandbox proxy applies to an app document.
 *
 * The specification's defaults are the floor and a declaration is the only way up: each directive
 * starts where the server declared nothing, and a declared domain is appended as a single source.
 * That is what keeps a declaration from widening the policy past itself -- a value carrying a space
 * or a semicolon is not one source expression, and is dropped rather than allowed to end its
 * directive and write another.
 */
export function viewCsp(meta: McpAppResourceMeta | undefined): string {
  const csp = meta?.csp;
  const resources = cspSources(csp?.resourceDomains);
  const connections = cspSources(csp?.connectDomains);
  const frames = cspSources(csp?.frameDomains);
  const bases = cspSources(csp?.baseUriDomains);
  return [
    // Naming every directive the app may use is what makes this an allow-list: anything the document
    // tries that is not spelled out here falls through to `default-src 'none'`.
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${resources}`,
    `style-src 'self' 'unsafe-inline'${resources}`,
    `img-src 'self' data:${resources}`,
    `media-src 'self' data:${resources}`,
    // Only declared origins reach `font-src`, without `'self'`: the specification's default list
    // names no source for it, so `'none'` is the default and `'self'` would be a widening the server
    // never asked for.
    `font-src${resources || " 'none'"}`,
    connections ? `connect-src${connections}` : "connect-src 'none'",
    frames ? `frame-src${frames}` : "frame-src 'none'",
    bases ? `base-uri${bases}` : "base-uri 'self'",
    // Unconditional, and the one directive nothing may widen: an app document has no business
    // loading a plugin, whatever it declares.
    "object-src 'none'",
  ].join("; ");
}

// The iframe feature each declared permission maps to, in a fixed order so that one declaration
// always renders one attribute.
const ALLOW_FEATURES: ReadonlyArray<[keyof McpAppResourcePermissions, string]> = [
  ["camera", "camera"],
  ["microphone", "microphone"],
  ["geolocation", "geolocation"],
  ["clipboardWrite", "clipboard-write"],
];

/** The app frame's `allow` attribute, when the resource declared any permission at all. */
export function viewAllowAttribute(meta: McpAppResourceMeta | undefined): string | undefined {
  const permissions = meta?.permissions;
  if (!permissions) return undefined;
  const features = ALLOW_FEATURES
    .filter(([declared]) => permissions[declared] === true)
    .map(([, feature]) => feature);
  return features.length > 0 ? features.join("; ") : undefined;
}

/**
 * Bounds one tool result for a sidecar window.
 *
 * The window renders what it is given and holds it in memory twice over (once as blocks, once as the
 * JSON-RPC frame), so a server-controlled result is capped before it is sent. Whole blocks are kept
 * while they fit and the walk stops at the first that does not, so what a window shows is always a
 * prefix of what the server returned: a result with a hole in the middle would read as a complete
 * one. Structured output is offered only out of what the content left, since a window that receives
 * content and no structured output still renders something and the reverse is an empty frame.
 */
export function clampAppResult(result: AppResultLike): AppToolResult {
  const content: unknown[] = [];
  // The budget bounds the whole result, not just its content: the envelope below costs a fixed
  // handful of bytes and is reserved up front rather than allowed to overshoot.
  let remaining = MAX_APP_RESULT_BYTES - RESULT_ENVELOPE_BYTES;
  for (const block of result.content ?? []) {
    const size = encodedBytes(block) + 1;
    if (size > remaining) {
      const clipped = clipTextBlock(block, remaining);
      if (clipped !== undefined) content.push(clipped);
      remaining = 0;
      break;
    }
    remaining -= size;
    content.push(block);
  }

  const structuredContent = result.structuredContent !== undefined
    && encodedBytes(result.structuredContent) + 1 <= remaining
    ? result.structuredContent
    : undefined;
  const bounded: AppToolResult = { content };
  if (structuredContent !== undefined) bounded.structuredContent = structuredContent;
  if (typeof result.isError === "boolean") bounded.isError = result.isError;
  return bounded;
}

// A text block that does not fit is clipped into the room left; any other block is dropped whole,
// since half an image is not a smaller image. The replacement carries only its text: a clipped block
// is a summary of the server's, and keeping its annotations would keep fields nothing here reads.
function clipTextBlock(block: unknown, budget: number): { type: "text"; text: string } | undefined {
  const record = asRecord(block);
  if (record?.type !== "text" || typeof record.text !== "string") return undefined;
  const prefix = clipToBytes(record.text, budget - TEXT_BLOCK_BYTES);
  return prefix.length > 0 ? { type: "text", text: `${prefix}${ELLIPSIS}` } : undefined;
}

// Longest prefix of `text` that fits in `maxBytes` once encoded. Byte-accurate rather than a
// character count, because the cap exists to bound what a window is sent and non-ASCII text costs up
// to four bytes per character.
function clipToBytes(text: string, maxBytes: number): string {
  let low = 0;
  let high = Math.min(text.length, Math.max(0, maxBytes));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(text.slice(0, middle)).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

// Serialized size of one value as it would cross the JSON-RPC endpoint.
function encodedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? "").byteLength;
}

// One CSP source expression: a scheme, an optional wildcard subdomain, a host, and an optional port.
// Anchored, so nothing else reaches a directive -- `*` would allow every origin on the network,
// `data:` a script from the document itself, and a token carrying a semicolon would end the directive
// and let the server write directives of its own.
const CSP_ORIGIN = /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i;

// A directive's declared sources as they will be written, each with the space that separates it, or
// an empty string when nothing usable was declared so the caller falls back to its own default. Only
// the first `MAX_APP_CSP_DOMAINS` entries are read at all: the list behind them may be as long as
// the response cap allows, and nothing past the bound could reach a policy anyway.
function cspSources(domains: string[] | undefined): string {
  const sources: string[] = [];
  for (const domain of (domains ?? []).slice(0, MAX_APP_CSP_DOMAINS)) {
    if (typeof domain === "string" && domain.length <= MAX_APP_CSP_DOMAIN_CHARS
      && CSP_ORIGIN.test(domain)) {
      sources.push(` ${domain}`);
    }
  }
  return sources.join("");
}

// A declared list of strings, or nothing: a metadata field that is a string, a number, or an object
// is not a list of domains, and reads as "not declared".
function clampDomains(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const domains = value.filter((domain): domain is string => typeof domain === "string");
  return domains.length > 0 ? domains : undefined;
}

// Untrusted JSON reaches this module as `unknown`, so one narrowing is shared rather than repeated.
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
