import {
  isListableFolderFile, isListableFolderNode, type DriveFile, type DriveScopeNode,
} from "./drive-api";

const MAX_PATH_NODES = 101;

/**
 * Internal root-to-position path; never accepted from an agent.
 *
 * `folderIds[0]` is the bound root, so there is no separate root field to keep in agreement with
 * the path it heads.
 */
export type FolderLocation = {
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
  if (file.id !== folderId || !isListableFolderFile(file)) outsideScope();
  return file;
}

/** Refetches and validates every saved edge from the bound root to the current folder. */
export async function readFolderLocation(
  location: FolderLocation,
  getScopeNodes: (fileIds: readonly string[]) => Promise<(DriveScopeNode | undefined)[]>,
): Promise<DriveScopeNode[]> {
  let ids = location.folderIds;
  if (ids.length === 0 || ids.length > MAX_PATH_NODES || ids[0] === "root" ||
      new Set(ids).size !== ids.length) {
    outsideScope();
  }

  let nodes = await getScopeNodes(ids);
  if (nodes.length !== ids.length) outsideScope();
  let root = nodes[0];
  if (!root) outsideScope();

  for (let index = 0; index < ids.length; index++) {
    let node = nodes[index];
    if (!node || node.id !== ids[index] || !isListableFolderNode(node) ||
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
