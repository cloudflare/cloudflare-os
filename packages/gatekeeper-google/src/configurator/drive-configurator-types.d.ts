import type { OfficeConversionResult, OfficeFileInspection, OfficeKind } from "../office-conversion";
export type { OfficeConversionResult, OfficeFileInspection, OfficeKind };

/**
 * The chosen node, by its {@link DriveNode.id}, or null when nothing is chosen; and, when it is a
 * Google Docs, Sheets or Slides file, the same id once it is known to connect as it is.
 */
export type DriveConfiguratorValues = { target?: string | null; checked?: string | null };

/** An ancestor of a {@link DriveNode}, outermost first below the whole account. */
export type DriveNodeAncestor = Pick<DriveNode, "id" | "title" | "listable">;

/** A grouping, shared drive, folder or file the Drive picker shows. */
export type DriveNode = {
  /**
   * `folder:<id>` for a folder or a shared drive's root; `doc:<id>`, `sheets:<id>` or `slides:<id>`
   * for a native Google file of that kind or an Office file that converts into one; `file:<id>` for
   * any other file, or for a file named by a Drive file link; or `shared-drives` / `shared-with-me` /
   * `recent` for a grouping, which is not a resource.
   */
  id: string;
  title: string;
  kind: "group" | "sharedDrive" | "folder" | "file";
  /** For a folder: whether this account can list its children, without which it cannot be bound. */
  listable?: boolean;
  /** For a file. */
  mimeType?: string;
  modifiedTime?: string;
  /** For a file Drive reports a size for, in bytes. */
  size?: number;
  /** Who a search result belongs to, plus an ID tail when names in the page look the same. */
  detail?: string;
  /** For a node looked up rather than listed, when every ancestor up to the account is known. */
  path?: DriveNodeAncestor[];
};

export type DriveNodePage = {
  nodes: DriveNode[];
  nextCursor?: string;
  /**
   * The grant to ask for with `ensureResources` when this location cannot be listed without it
   * (shared drives); the page then has no nodes.
   */
  needsGrant?: string;
};

export interface DriveConfiguratorRpc {
  /**
   * One page of a location's nodes: the whole account's (`drive`) groupings, a grouping's or a
   * folder's children, or, when `query` is not empty, every node anywhere whose name contains it.
   */
  listDriveNodes(parentId: string, query: string, cursor: string | null): Promise<DriveNodePage>;
  /** The folder or file a node id names, or null if this account cannot see it. */
  getDriveNode(id: string): Promise<DriveNode | null>;
  /** Whether `fileId` is a native file of `kind`, an Office file that converts into one, or neither. */
  inspectFile(kind: OfficeKind, fileId: string): Promise<OfficeFileInspection>;
  /** Whether the account holds the grant `convertFile` needs; asked again after a consent pop-up. */
  hasConversionAccess(): Promise<boolean>;
  /** Makes a native `kind` copy of Office file `fileId`, or confirms and returns the copy `reuse` names. */
  convertFile(kind: OfficeKind, fileId: string, opts?: { reuse?: string }): Promise<OfficeConversionResult>;
}
