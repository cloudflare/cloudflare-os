/**
 * Descendant-membership proofs for a folder-scoped Drive binding.
 *
 * Drive v3 offers no folder corpus, no folder-scoped token, and no recursive ancestor predicate --
 * `'<id>' in parents` means direct children only. So confinement to a subtree is proved here, from
 * freshly fetched metadata, one parent hop at a time, and nothing survives the operation that
 * proved it: a hierarchy change rotates no credential and bumps no cache generation, so a
 * remembered ancestry would be authority the provider never re-confirmed.
 */

import { FOLDER_MIME_TYPE, type DriveApi, type DriveFile, type DriveScopeNode } from "./drive-api";

/**
 * Parent hops one proof may take.
 *
 * My Drive and shared drives both cap nesting at 100 levels, so one hop past that separates a legal
 * maximum-depth descendant from a chain that does not terminate.
 */
const MAX_PARENT_HOPS = 101;

/** The single refusal every folder-scope failure collapses to. It names nothing it rejected. */
export function outsideScope(): never {
  throw new Error("The requested file is outside this Drive binding.");
}

/** A candidate proven to be the root or one of its live descendants, with the chain that proved it. */
export type FolderProof = {
  file: DriveFile;
  /** The candidate and every ancestor traversed, up to and including the root. */
  path: DriveScopeNode[];
};

/** One candidate's walk toward the root. Absent `parentId` with `proven: false` means rejected. */
type Walk = FolderProof & {
  seen: Set<string>;
  parentId?: string;
  proven: boolean;
};

function scopeNode(file: DriveFile): DriveScopeNode {
  return {
    id: file.id,
    ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
    ...(file.parents ? { parents: file.parents } : {}),
    ...(file.driveId === undefined ? {} : { driveId: file.driveId }),
    ...(file.trashed === undefined ? {} : { trashed: file.trashed }),
  };
}

/**
 * Reads the bound folder and confirms it is still usable as a root, or refuses.
 *
 * The one place a folder ID becomes authority, so `describe()` and the session share it and cannot
 * drift. Identity is the immutable ID: a rename or a move does not retarget the capability. What
 * would retarget it is accepting something that is no longer an ordinary live folder.
 */
export async function readFolderRoot(
  folderId: string,
  getFile: (fileId: string) => Promise<DriveFile>,
): Promise<DriveFile> {
  // The account-relative alias resolves per account, so it names no stable authority. Checked
  // before the fetch, since no read can make it one.
  if (folderId === "root") outsideScope();
  let file = await getFile(folderId);
  if (file.id !== folderId ||
      // A shortcut carries its own MIME type, so this also refuses one aimed at a folder.
      file.mimeType !== FOLDER_MIME_TYPE ||
      file.trashed !== false ||
      // A shared drive's root shares the drive's own ID and is the Shared Drive resource. Serving it
      // here too would make the folder binding a second, weaker name for a whole drive.
      file.id === file.driveId) {
    outsideScope();
  }
  return file;
}

/** Whether both nodes sit in the same storage domain: the same shared drive, or My Drive. */
function sameDomain(node: DriveScopeNode, root: DriveScopeNode): boolean {
  return node.driveId === root.driveId;
}

/** Whether an intermediate node can carry a chain: a live folder in the root's own domain. */
function isTraversableFolder(node: DriveScopeNode, root: DriveScopeNode): boolean {
  return node.trashed === false && node.mimeType === FOLDER_MIME_TYPE && sameDomain(node, root);
}

/** Whether a re-read node still states every fact the proof recorded about it. */
function unchanged(node: DriveScopeNode, recorded: DriveScopeNode): boolean {
  return node.id === recorded.id && node.mimeType === recorded.mimeType &&
    node.driveId === recorded.driveId && node.trashed === recorded.trashed &&
    node.parents?.length === recorded.parents?.length &&
    (node.parents ?? []).every((parent, index) => parent === recorded.parents?.[index]);
}

function startWalk(file: DriveFile, root: DriveScopeNode): Walk | undefined {
  let node = scopeNode(file);
  // The candidate is the one node whose type is unconstrained: a leaf may be any file, a shortcut
  // included -- it is disclosed as a shortcut and never followed.
  if (node.trashed !== false || !sameDomain(node, root)) return undefined;
  if (node.id === root.id) {
    return { file, path: [root], seen: new Set([root.id]), proven: true };
  }
  // A Drive file has one current parent. `parents` is an array anyway, so anything else is either a
  // malformed response or a shape whose containment this cannot decide.
  if (node.parents?.length !== 1) return undefined;
  return { file, path: [node], seen: new Set([node.id]), parentId: node.parents[0], proven: false };
}

/** Follows one walk to the ancestor it was waiting on, or abandons it. */
function step(walk: Walk, node: DriveScopeNode | undefined, root: DriveScopeNode): void {
  let parentId = walk.parentId;
  walk.parentId = undefined;
  if (parentId === undefined || node === undefined || walk.seen.has(parentId)) return;
  walk.seen.add(parentId);
  walk.path.push(node);
  if (parentId === root.id) {
    walk.proven = true;
    return;
  }
  if (node.parents?.length !== 1) return;
  walk.parentId = node.parents[0];
}

export class FolderScope {
  #api: Pick<DriveApi, "getScopeNodes">;

  constructor(api: Pick<DriveApi, "getScopeNodes">) {
    this.#api = api;
  }

  /**
   * The subset of `files` that is the root or one of its live descendants, in provider order.
   *
   * Batched by level rather than per candidate: one `files.get` batch resolves the whole frontier's
   * parents, so even a full page of maximum-depth candidates costs one subrequest per level. A
   * missing or inaccessible parent, several parents, a non-folder or trashed ancestor, a hop into
   * another storage domain, a cycle, or depth exhaustion all mean "not a member" rather than an
   * error: on a broad page those are ordinary neighbours the binding must not disclose.
   */
  async prove(files: readonly DriveFile[], rootFile: DriveFile): Promise<FolderProof[]> {
    let root = scopeNode(rootFile);
    let walks: Walk[] = [];
    for (let file of files) {
      let walk = startWalk(file, root);
      if (walk) walks.push(walk);
    }

    // Ancestors resolved during this proof, and only during it. `undefined` records a parent that
    // was fetched and rejected, so a shared subtree costs one lookup however many walks cross it.
    let ancestors = new Map<string, DriveScopeNode | undefined>([[root.id, root]]);
    for (let hop = 0; hop < MAX_PARENT_HOPS; hop++) {
      let pending = walks.filter(walk => walk.parentId !== undefined);
      if (pending.length === 0) break;
      let wanted = [...new Set(pending.map(walk => walk.parentId!))]
        .filter(id => !ancestors.has(id));
      if (wanted.length > 0) {
        let nodes = await this.#api.getScopeNodes(wanted);
        for (let [index, node] of nodes.entries()) {
          ancestors.set(wanted[index], node && isTraversableFolder(node, root) ? node : undefined);
        }
      }
      for (let walk of pending) step(walk, ancestors.get(walk.parentId!), root);
    }

    return walks.filter(walk => walk.proven).map(({ file, path }) => ({ file, path }));
  }

  /**
   * Re-reads every node the proofs rested on and refuses if any recorded fact has changed.
   *
   * A proof spans many round trips, so its earliest hops are the stalest thing authorizing the
   * disclosure. This is a second look immediately before that disclosure, not a lock: Drive has no
   * ancestry-plus-content transaction, and a move landing after it is caught by the next read.
   *
   * Moving the bound folder itself also fails here, since its own `parents` is compared like any
   * other node's even though the root's container cannot affect membership. The retry succeeds, and
   * exempting one field from this comparison would cost more review than it saves.
   */
  async recheck(proofs: readonly FolderProof[]): Promise<void> {
    let recorded = new Map<string, DriveScopeNode>();
    for (let proof of proofs) {
      for (let node of proof.path) recorded.set(node.id, node);
    }
    if (recorded.size === 0) return;
    let ids = [...recorded.keys()];
    let nodes = await this.#api.getScopeNodes(ids);
    for (let [index, node] of nodes.entries()) {
      if (!node || !unchanged(node, recorded.get(ids[index])!)) outsideScope();
    }
  }
}
