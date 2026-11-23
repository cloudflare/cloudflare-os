import {
  isListableFolderFile, isListableFolderNode, SHORTCUT_MIME_TYPE, type DriveFile,
  type DriveScopeNode,
} from "./drive-api";

const MAX_PATH_NODES = 101;

/**
 * Internal root-to-position path; never accepted from an agent.
 *
 * `folderIds[0]` is the bound root, so there is no separate root field to keep in agreement with
 * the path it heads. Each later folder is a direct child of the one before it, or, where
 * `shortcuts` names one for it, the target of that shortcut, a direct child of the one before.
 * Only reads follow shortcuts: a write's saved path carries `folderIds` alone, which a folder
 * reached through one fails to prove.
 */
export type FolderLocation = {
  folderIds: readonly string[];
  /** The shortcut each folder reached through one was opened by, keyed by the folder's ID. */
  shortcuts?: Readonly<Record<string, string>>;
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

/**
 * Refetches and validates every saved edge from the bound root to the current folder, and the
 * shortcut behind each edge that has one, in one batch.
 */
export async function readFolderLocation(
  location: FolderLocation,
  getScopeNodes: (fileIds: readonly string[]) => Promise<(DriveScopeNode | undefined)[]>,
): Promise<DriveScopeNode[]> {
  let ids = location.folderIds;
  if (ids.length === 0 || ids.length > MAX_PATH_NODES || ids[0] === "root" ||
      new Set(ids).size !== ids.length) {
    outsideScope();
  }
  let shortcutIds = ids.map(id => location.shortcuts?.[id]);
  if (shortcutIds[0] !== undefined) outsideScope();
  let viaIds = shortcutIds.filter(id => id !== undefined);

  let nodes = await getScopeNodes([...ids, ...viaIds]);
  if (nodes.length !== ids.length + viaIds.length) outsideScope();
  let vias = nodes.splice(ids.length);

  for (let index = 0; index < ids.length; index++) {
    let node = nodes[index];
    if (!node || node.id !== ids[index] || !isListableFolderNode(node)) outsideScope();
    if (index === 0) continue;
    let parent = nodes[index - 1]!;
    let shortcutId = shortcutIds[index];
    if (shortcutId === undefined) {
      if (!isDirectChild(node, parent)) outsideScope();
    } else {
      let shortcut = vias.shift();
      if (!shortcut || shortcut.id !== shortcutId || !isShortcutChild(shortcut, node.id, parent)) {
        outsideScope();
      }
    }
  }
  return nodes as DriveScopeNode[];
}

/** Whether a fresh node is a live direct child in the same Drive storage domain. */
export function isDirectChild(file: DriveScopeNode, parent: DriveScopeNode): boolean {
  return file.trashed === false && file.driveId === parent.driveId &&
    file.parents?.length === 1 && file.parents[0] === parent.id;
}

/** Whether a fresh node is a live shortcut to `targetId` and a direct child of `parent`. */
export function isShortcutChild(
  node: DriveScopeNode, targetId: string, parent: DriveScopeNode,
): boolean {
  return node.mimeType === SHORTCUT_MIME_TYPE && node.shortcutTargetId === targetId &&
    isDirectChild(node, parent);
}
