import { FOLDER_MIME_TYPE, type DriveFile, type DriveScopeNode } from "./drive-api";

const MAX_PATH_NODES = 101;

/** Internal root-to-position path; never accepted from an agent. */
export type FolderLocation = {
  rootId: string;
  folderIds: readonly string[];
};

/** The single refusal for folder-scope failures. */
export function outsideScope(): never {
  throw new Error("The requested file is outside this Drive binding.");
}

/** Reads and validates the selected folder root. */
export async function readFolderRoot(
  folderId: string,
  getFile: (fileId: string) => Promise<DriveFile>,
): Promise<DriveFile> {
  if (folderId === "root") outsideScope();
  let file = await getFile(folderId);
  if (file.id !== folderId || file.mimeType !== FOLDER_MIME_TYPE ||
      file.capabilities?.canListChildren !== true || file.trashed !== false) {
    outsideScope();
  }
  return file;
}

/** Refetches and validates every saved edge from the bound root to the current folder. */
export async function readFolderLocation(
  location: FolderLocation,
  getScopeNodes: (fileIds: readonly string[]) => Promise<(DriveScopeNode | undefined)[]>,
): Promise<DriveScopeNode[]> {
  let ids = location.folderIds;
  if (location.rootId === "root" || ids.length === 0 || ids.length > MAX_PATH_NODES ||
      ids[0] !== location.rootId || new Set(ids).size !== ids.length) {
    outsideScope();
  }

  let nodes = await getScopeNodes(ids);
  if (nodes.length !== ids.length) outsideScope();
  let root = nodes[0];
  if (!root) outsideScope();

  for (let index = 0; index < ids.length; index++) {
    let node = nodes[index];
    if (!node || node.id !== ids[index] || node.mimeType !== FOLDER_MIME_TYPE ||
        node.trashed !== false || node.canListChildren !== true ||
        node.driveId !== root.driveId) {
      outsideScope();
    }
    if (index > 0 && (node.parents?.length !== 1 || node.parents[0] !== ids[index - 1])) {
      outsideScope();
    }
  }
  return nodes as DriveScopeNode[];
}

/** Whether a fresh file is a live direct child in the same Drive storage domain. */
export function isDirectChild(file: DriveFile, parent: DriveScopeNode): boolean {
  return file.trashed === false && file.driveId === parent.driveId &&
    file.parents?.length === 1 && file.parents[0] === parent.id;
}
