// Observers: who else may watch a workspace that read SharePoint. SharePoint breaks permission
// inheritance at any level (a folder, a file, a list item), and a listing is trimmed to what the
// reader can open, so one container's ACL never vouches for its contents. Every read therefore
// names the objects it revealed as access units, and a collaborator is shown the read only if their
// own Microsoft 365 account can open every one of them (the kit's tracked-collection strategy).
//
// A unit is probed by stable ID with the observer's token, twenty to a Graph `$batch`. A 403 and a
// 404 both mean "no access": SharePoint answers 404 for an item hidden by broken inheritance and
// 403 when the whole site or drive is closed to the user (verified against a live tenant), and
// neither tells them whether the item exists.
//
// Seeing an object is not the same as reading it, so a read names what it needed, not just what it
// touched. A file's content is its own unit: Restricted View, a block-download policy or an
// unmanaged-device policy can let someone see a file they cannot open, so the probe asks for the
// content itself, which Graph answers with a redirect to the bytes (not followed) or a refusal.
// Version history is its own unit too. And a draft is visible only to editors, while a reader
// opening the same ID is quietly shown the last published version, with a 200: so when the owner
// read a draft (a page with unpublished changes, a minor version, an item awaiting approval) the
// unit pins that version, and the probe passes only if the observer is shown the same one.

import { trackedCollectionObservers, type ObserverKv, type ObserverStrategy } from "@gadgets/gatekeeper-kit/observers";
import { MAX_BATCH_REQUESTS, type BatchRequest, type GraphApi } from "./graph-api";
import type { MicrosoftVerifierApi, StoredIdentity } from "./microsoft-credentials";
import { VENDOR_ID } from "./microsoft-env";
import type { ItemRef, ListRef, PageRef } from "./sharepoint-scope";

/** Something a read revealed, which an observer must be able to open to see that read. */
export type AccessUnit =
  | { kind: "site"; siteId: string }
  | { kind: "drive"; driveId: string }
  | { kind: "item"; driveId: string; itemId: string }
  | { kind: "list"; siteId: string; listId: string }
  | { kind: "listItem"; siteId: string; listId: string; itemId: string }
  | { kind: "page"; siteId: string; pageId: string }
  /** A file's bytes, not just its name and details. */
  | { kind: "content"; driveId: string; itemId: string }
  /** A file's version history. */
  | { kind: "versions"; driveId: string; itemId: string }
  /** A draft the owner saw: the observer must be shown this exact version, not the published one. */
  | { kind: "fileVersion"; driveId: string; itemId: string; version: string }
  | { kind: "listItemVersion"; siteId: string; listId: string; itemId: string; version: string }
  | { kind: "pageVersion"; siteId: string; pageId: string; version: string };

// No ID this gatekeeper stores contains a colon: composite site IDs use commas, drive IDs are
// `b!` + base64url, and the rest are GUIDs or SharePoint's base32 item IDs. Version labels are
// `1.0`-style numbers.
const SEPARATOR = ":";

/** The tracker's collection ID for a unit. */
export function encodeUnit(unit: AccessUnit): string {
  switch (unit.kind) {
    case "site": return ["site", unit.siteId].join(SEPARATOR);
    case "drive": return ["drive", unit.driveId].join(SEPARATOR);
    case "item": return ["item", unit.driveId, unit.itemId].join(SEPARATOR);
    case "list": return ["list", unit.siteId, unit.listId].join(SEPARATOR);
    case "listItem": return ["listItem", unit.siteId, unit.listId, unit.itemId].join(SEPARATOR);
    case "page": return ["page", unit.siteId, unit.pageId].join(SEPARATOR);
    case "content": return ["content", unit.driveId, unit.itemId].join(SEPARATOR);
    case "versions": return ["versions", unit.driveId, unit.itemId].join(SEPARATOR);
    case "fileVersion": return ["fileVersion", unit.driveId, unit.itemId, unit.version].join(SEPARATOR);
    case "listItemVersion": return ["listItemVersion", unit.siteId, unit.listId, unit.itemId, unit.version].join(SEPARATOR);
    case "pageVersion": return ["pageVersion", unit.siteId, unit.pageId, unit.version].join(SEPARATOR);
  }
}

/** Parses a collection ID back into its unit, or null for one this version does not know. */
export function decodeUnit(id: string): AccessUnit | null {
  const [kind, ...parts] = id.split(SEPARATOR);
  if (parts.some(part => part === "" || part.includes("/"))) return null;
  switch (kind) {
    case "site": return parts.length === 1 ? { kind, siteId: parts[0] } : null;
    case "drive": return parts.length === 1 ? { kind, driveId: parts[0] } : null;
    case "item": return parts.length === 2 ? { kind, driveId: parts[0], itemId: parts[1] } : null;
    case "list": return parts.length === 2 ? { kind, siteId: parts[0], listId: parts[1] } : null;
    case "listItem": return parts.length === 3 ? { kind, siteId: parts[0], listId: parts[1], itemId: parts[2] } : null;
    case "page": return parts.length === 2 ? { kind, siteId: parts[0], pageId: parts[1] } : null;
    case "content":
    case "versions":
      return parts.length === 2 ? { kind, driveId: parts[0], itemId: parts[1] } : null;
    case "fileVersion":
      return parts.length === 3 && VERSION.test(parts[2]) ? { kind, driveId: parts[0], itemId: parts[1], version: parts[2] } : null;
    case "listItemVersion":
      return parts.length === 4 && VERSION.test(parts[3])
        ? { kind, siteId: parts[0], listId: parts[1], itemId: parts[2], version: parts[3] } : null;
    case "pageVersion":
      return parts.length === 3 && VERSION.test(parts[2]) ? { kind, siteId: parts[0], pageId: parts[1], version: parts[2] } : null;
    default: return null;
  }
}

/** Unit constructors, so callers never spell a kind by hand. */
export const units = {
  site: (siteId: string): string => encodeUnit({ kind: "site", siteId }),
  drive: (driveId: string): string => encodeUnit({ kind: "drive", driveId }),
  item: (ref: ItemRef): string => encodeUnit({ kind: "item", ...ref }),
  list: (ref: ListRef): string => encodeUnit({ kind: "list", ...ref }),
  listItem: (ref: ListRef, itemId: string): string => encodeUnit({ kind: "listItem", ...ref, itemId }),
  page: (ref: PageRef): string => encodeUnit({ kind: "page", ...ref }),
  /** Reading a file's bytes, pinned to the version read when it is a draft or awaits approval. */
  fileRead,
  /** Reading a file's version history. */
  versions: (ref: ItemRef): string[] => [encodeUnit({ kind: "item", ...ref }), encodeUnit({ kind: "versions", ...ref })],
  /** Reading a list item, pinned to the version read when it is a draft or awaits approval. */
  listItemRead: (ref: ListRef, itemId: string, version?: string, moderation?: number): string[] => [
    encodeUnit({ kind: "listItem", ...ref, itemId }),
    ...(pinned(version, moderation) ? [encodeUnit({ kind: "listItemVersion", ...ref, itemId, version })] : []),
  ],
  /** Reading a page, pinned to the version read unless it is the published one. */
  pageRead: (ref: PageRef, state?: string, version?: string): string[] => [
    encodeUnit({ kind: "page", ...ref }),
    ...(state !== undefined && state !== "published" && version !== undefined && VERSION.test(version)
      ? [encodeUnit({ kind: "pageVersion", ...ref, version })] : []),
  ],
};

/** A SharePoint version label. */
const VERSION = /^[0-9]{1,6}\.[0-9]{1,6}$/;

/** A major version: what every reader of the item is shown. */
const PUBLISHED = /^[0-9]{1,6}\.0$/;

/**
 * Whether a read must be pinned to the version it saw: a minor version (a draft), or a major one
 * still awaiting approval (`_ModerationStatus` other than 0, approved), which a reader without
 * approval rights is quietly shown the last approved version of instead.
 */
function pinned(version: string | undefined, moderation: number | undefined): version is string {
  return version !== undefined && VERSION.test(version) && (!PUBLISHED.test(version) || (moderation !== undefined && moderation !== 0));
}

/** The units for reading a file's bytes: its details, its content, and the version read when it is a draft or awaits approval. */
function fileRead(ref: ItemRef, version?: string, moderation?: number): string[] {
  return [
    encodeUnit({ kind: "item", ...ref }),
    encodeUnit({ kind: "content", ...ref }),
    ...(pinned(version, moderation) ? [encodeUnit({ kind: "fileVersion", ...ref, version })] : []),
  ];
}

/** The Graph GET that proves access to a unit; `$select` keeps the answer tiny. */
function probePath(unit: AccessUnit): string {
  switch (unit.kind) {
    case "site": return `sites/${unit.siteId}?$select=id`;
    case "drive": return `drives/${unit.driveId}?$select=id`;
    case "item": return `drives/${unit.driveId}/items/${unit.itemId}?$select=id`;
    case "list": return `sites/${unit.siteId}/lists/${unit.listId}?$select=id`;
    case "listItem": return `sites/${unit.siteId}/lists/${unit.listId}/items/${unit.itemId}?$select=id`;
    case "page": return `sites/${unit.siteId}/pages/${unit.pageId}?$select=id`;
    // Answered with a 302 to the bytes, which a batch never follows: nothing is downloaded.
    case "content": return `drives/${unit.driveId}/items/${unit.itemId}/content`;
    case "versions": return `drives/${unit.driveId}/items/${unit.itemId}/versions?$top=1&$select=id`;
    case "fileVersion": return `drives/${unit.driveId}/items/${unit.itemId}/listItem/fields?$select=_UIVersionString`;
    case "listItemVersion": return `sites/${unit.siteId}/lists/${unit.listId}/items/${unit.itemId}/fields?$select=_UIVersionString`;
    case "pageVersion": return `sites/${unit.siteId}/pages/${unit.pageId}/microsoft.graph.sitePage?$select=id,publishingState`;
  }
}

/** Whether a probe's successful answer shows the observer what the owner saw. */
function shows(unit: AccessUnit, body: unknown): boolean {
  const json = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  switch (unit.kind) {
    case "fileVersion":
    case "listItemVersion":
      return json._UIVersionString === unit.version;
    case "pageVersion": {
      const state = typeof json.publishingState === "object" && json.publishingState !== null
        ? json.publishingState as Record<string, unknown> : {};
      return state.versionId === unit.version;
    }
    default:
      return true;
  }
}

/** A probe answer Graph gave that is neither access nor its absence: the check could not be made. */
export class AccessProbeError extends Error {
  constructor(status: number) {
    super(`Microsoft Graph could not check access (HTTP ${status}).`);
    this.name = "AccessProbeError";
  }
}

/**
 * Whether `api`'s user can open each unit, in order. A unit this version cannot parse is denied,
 * as is one Graph says is missing or forbidden. Anything else (throttling that outlasted the
 * batch's own retries, an outage) throws, which the tracker counts against the observer.
 */
export async function probeUnits(api: GraphApi, ids: readonly string[]): Promise<boolean[]> {
  const verdicts = Array.from({ length: ids.length }, () => false);
  const requests: { index: number; unit: AccessUnit; request: BatchRequest }[] = [];
  ids.forEach((id, index) => {
    const unit = decodeUnit(id);
    if (unit !== null) requests.push({ index, unit, request: { id: String(index), method: "GET", url: probePath(unit) } });
  });
  for (let start = 0; start < requests.length; start += MAX_BATCH_REQUESTS) {
    const chunk = requests.slice(start, start + MAX_BATCH_REQUESTS);
    const answers = await api.batch(chunk.map(entry => entry.request));
    for (const { index, unit, request } of chunk) {
      const answer = answers.get(request.id);
      if (answer === undefined) throw new AccessProbeError(502);
      const { status } = answer;
      const opens = status >= 200 && status < 300 || (unit.kind === "content" && status === 302);
      if (opens) verdicts[index] = shows(unit, answer.body);
      else if (status !== 401 && status !== 403 && status !== 404 && status !== 400) throw new AccessProbeError(status);
    }
  }
  return verdicts;
}

/** The most distinct objects one binding tracks while staying shareable. */
const MAX_TRACKED_UNITS = 2000;

/**
 * The binding's observer strategy. Admission needs a working connection in the owner's own tenant;
 * every read's units are then checked per observer as the read is made.
 * @param owner The connection owner's identity, read when an observer joins.
 */
export function sharePointObservers(kv: ObserverKv, owner: () => Promise<StoredIdentity>): ObserverStrategy {
  return trackedCollectionObservers<MicrosoftVerifierApi>({
    kv,
    collectionPrefix: "observedUnit:",
    maxTrackedCollections: MAX_TRACKED_UNITS,
    verifyBaseline: async verifier => {
      const [observer, me] = await Promise.all([verifier.getIdentity(), owner()]);
      if (observer === null) {
        throw new Error("This collaborator has no working Microsoft 365 connection with SharePoint access. " +
          "They need to connect (or reconnect) Microsoft 365 before they can observe this workspace.");
      }
      if (observer.tenantId !== me.tenantId) {
        throw new Error("This collaborator's Microsoft 365 account is in a different organization than the " +
          "one this workspace read SharePoint from, so they can't observe it.");
      }
    },
    hasCollectionAccess: (verifier, ids) => verifier.canAccess([...ids]),
    denyMessage: () => "This collaborator can't open something in SharePoint that this workspace has read, " +
      "so they can't observe it.",
    vendorId: VENDOR_ID,
  });
}
