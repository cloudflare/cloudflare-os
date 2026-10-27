// Pure helpers: raw Canva responses -> the shapes declared in types.d.ts, and the id parsers the
// session accepts. Nothing here touches the network or storage.

import type {
  CanvaDesignResponse,
  CanvaDesignTypeRequest,
  CanvaFolderItemResponse,
  CanvaFolderResponse,
  CanvaImageAssetResponse,
  CanvaThumbnailResponse,
} from "./canva-api";
import type {
  CanvaDesign,
  CanvaDesignType,
  CanvaFolder,
  CanvaFolderItem,
  CanvaImageAsset,
  CanvaThumbnail,
} from "./types";

// Canva timestamps are Unix seconds; the agent-facing API uses ISO 8601 strings.
function isoFromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function normalizeThumbnail(thumbnail: CanvaThumbnailResponse | undefined): CanvaThumbnail | null {
  return thumbnail ? { width: thumbnail.width, height: thumbnail.height, url: thumbnail.url } : null;
}

export function normalizeDesign(design: CanvaDesignResponse): CanvaDesign {
  return {
    id: design.id,
    title: design.title ?? null,
    owner: design.owner ? { userId: design.owner.user_id, teamId: design.owner.team_id } : null,
    thumbnail: normalizeThumbnail(design.thumbnail),
    editUrl: design.urls.edit_url,
    viewUrl: design.urls.view_url,
    pageCount: design.page_count ?? null,
    createdAt: isoFromUnixSeconds(design.created_at),
    updatedAt: isoFromUnixSeconds(design.updated_at),
  };
}

export function normalizeFolder(folder: CanvaFolderResponse): CanvaFolder {
  return {
    id: folder.id,
    name: folder.name,
    thumbnail: normalizeThumbnail(folder.thumbnail),
    createdAt: isoFromUnixSeconds(folder.created_at),
    updatedAt: isoFromUnixSeconds(folder.updated_at),
  };
}

export function normalizeImageAsset(image: CanvaImageAssetResponse): CanvaImageAsset {
  const { width, height } = image.metadata ?? {};
  return {
    id: image.id,
    name: image.name,
    tags: image.tags ?? [],
    owner: image.owner ? { userId: image.owner.user_id, teamId: image.owner.team_id } : null,
    dimensions: width !== undefined && height !== undefined ? { width, height } : null,
    thumbnail: normalizeThumbnail(image.thumbnail),
    createdAt: isoFromUnixSeconds(image.created_at),
    updatedAt: isoFromUnixSeconds(image.updated_at),
  };
}

export function normalizeFolderItem(item: CanvaFolderItemResponse): CanvaFolderItem {
  switch (item.type) {
    case "folder": return { type: "folder", folder: normalizeFolder(item.folder) };
    case "design": return { type: "design", design: normalizeDesign(item.design) };
    case "image": return { type: "image", image: normalizeImageAsset(item.image) };
  }
}

// Canva ids are short URL-safe strings ("DAFVztcvd9z", "FAFxyz", "root").
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The path segment following `kind` in a canva.com URL, or null when `input` is not such a URL. */
function idFromCanvaUrl(input: string, kind: "design" | "folder"): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!/(^|\.)canva\.com$/.test(url.hostname)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const idx = segments.indexOf(kind);
  const candidate = idx >= 0 ? segments[idx + 1] : undefined;
  return candidate && ID_PATTERN.test(candidate) ? candidate : null;
}

// The temporary id of a design or asset a pending action makes (see canva-simulation.ts).
const PROVISIONAL_ID_PATTERN = /^~[0-9]+$/;

/** A design id from a bare id, the temporary id of a pending design, or a canva.com/design URL, or null. */
export function parseDesignId(input: string): string | null {
  const trimmed = input.trim();
  if (ID_PATTERN.test(trimmed) || PROVISIONAL_ID_PATTERN.test(trimmed)) return trimmed;
  return idFromCanvaUrl(trimmed, "design");
}

/** A folder id from a bare id (including "root" and "uploads") or a canva.com/folder URL, or null. */
export function parseFolderId(input: string): string | null {
  const trimmed = input.trim();
  if (ID_PATTERN.test(trimmed)) return trimmed;
  return idFromCanvaUrl(trimmed, "folder");
}

/**
 * The wire form of a design type, built from its known members only. Nothing else a caller's
 * object carried reaches Canva or escapes the approval card.
 */
export function designTypeToWire(designType: CanvaDesignType): CanvaDesignTypeRequest {
  return typeof designType === "string"
    ? { type: "preset", name: designType }
    : { type: "custom", width: designType.width, height: designType.height };
}

/** A design type as approval prose names it, e.g. "a presentation" or "a custom 1080×1080px design". */
export function describeDesignType(designType: CanvaDesignType): string {
  return typeof designType === "string"
    ? `a ${designType}`
    : `a custom ${designType.width}×${designType.height}px design`;
}
