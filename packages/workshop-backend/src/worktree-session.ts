// The programmatic Worktree binding: the RpcTarget behind a worktree's env entry in the agent's
// executeCode sandbox (worktree-binding.d.ts defines the agent-facing contract).
//
// A session is minted per executeCode run by the overseer's binding-loopback dispatch
// (startGatekeeperSession, target type "worktree") and lives exactly as long as the execution:
// every operation resolves against the running turn's state through WorktreeTurnAccess
// (agent.ts), so binding operations and file-tool operations see one consistent worktree, and
// writes and commits buffer into the same step and become durable at the same barrier. The git
// side -- base-tree walks, blob reads, commit writes -- goes through the host's WorkspaceGitCache
// and GitStore, the same plumbing the file tools' lazy reads use.
//
// The env.GIT binding (git-binding.ts) serves this same class for its in-memory worktrees,
// substituting a single object holding the worktree's state for both the turn and the host.
//
// Content rules match the file tools': regular files of either mode are operable (an edited
// executable keeps its bit), symlink/gitlink/directory paths throw their descriptive errors,
// and unreadable *content* (oversized/binary) is distinguished from path-shape errors by
// UnreadableContentError -- writeFile falls back to a whole-file `set` on it, while grep
// reports it as a structured error entry (a "(skipped: ...)" note in the freeform format) and
// diff likewise (a "(cannot diff ...)" note).

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { structuredPatch } from "diff";
import type {
  DiffFile, DiffFileKind, DiffHunk, DiffLine, StructuredDiffResult, StructuredGrepResult, Worktree,
  WorktreeFileEntry,
} from "./worktree-binding";
import type { AiChatAuthorInfo, WorkpieceId } from "@gadgets/workshop-shared/api";
import { diffFiles, type FileChange } from "@gadgets/workshop-shared/code-change";

import { UnreadableContentError, type WorkspaceGitCache } from "./git-cache";
import { commitIdentityForAuthor, type GitStore } from "./git-store";
import { formatUnifiedDiff, type WorktreeTurnAccess } from "./agent";
import { formatGrep, matchLines, scanWorkpieceForGrep } from "./grep";

/**
 * What the session needs from the overseer: the git plumbing and the worktree's registry record
 * (whose headCommit the step barrier owns). Structurally satisfied by OverseerImpl.
 */
export interface WorktreeSessionHost {
  gitCache: WorkspaceGitCache;
  gitStore: GitStore;
  getWorktreeRecord(id: WorkpieceId): WorktreeRecordView;
}

/** The slice of the worktree registry record the session reads. */
export interface WorktreeRecordView {
  /** The last explicit commit -- what the API reports as HEAD and what commit() parents on. */
  headCommit: string;
}

/**
 * The Worktree binding served to executeCode. One instance per (execution, worktree); see the
 * module doc for how state splits between the turn (`turn`) and the workspace (`host`).
 */
@validateRpc()
export class WorktreeSessionImpl extends RpcTarget implements Worktree {
  /**
   * `author` resolves who commits are attributed to. It is called only by commit(), so a session
   * that never commits never pays for resolving it (env.GIT's may need an RPC to the owner's DO).
   */
  constructor(private host: WorktreeSessionHost, private worktreeId: WorkpieceId,
              private turn: WorktreeTurnAccess, private author: () => Promise<AiChatAuthorInfo>) {
    super();
  }

  // The base commit the overlay is expressed against: the chat pin's base while the worktree is
  // pinned, else its accepted commit (see WorktreeTurnAccess.getBaseCommit).
  #pinBase(): string {
    let base = this.turn.getBaseCommit(this.worktreeId);
    if (base === undefined) {
      throw new Error("This worktree is not part of the current session.");
    }
    return base;
  }

  // The worktree's HEAD -- the last explicit commit: one buffered earlier in this turn, else
  // the registry record's (advanced at each step's barrier).
  #head(): string {
    return this.turn.getBufferedHead(this.worktreeId)
        ?? this.host.getWorktreeRecord(this.worktreeId).headCommit;
  }

  async listFiles(path?: string, options?: { recursive?: boolean })
      : Promise<WorktreeFileEntry[]> {
    let base = this.#pinBase();
    let scope = path ?? "";
    let recursive = options?.recursive ?? false;
    let overlay = this.turn.getOverlayFiles(this.worktreeId);
    let removed = this.turn.getRemovedPaths(this.worktreeId);

    if (overlay.has(scope)) throw new Error(`${scope} is not a directory`);
    let baseScope = scope === "" || !removed.has(scope)
        ? await this.host.gitCache.pathEntryAtCommit(base, scope) : undefined;
    if (baseScope !== undefined && baseScope.kind !== "dir") {
      throw new Error(`${scope} is not a directory`);
    }

    // Base entries first (removed files drop out, and directories those removals hollowed out
    // prune with them -- git has no empty directories, so a directory whose files are all
    // tombstoned no longer exists, matching the tree commit() would write), then overlay paths:
    // a touched base file keeps its base kind -- an edited executable stays "executable" --
    // while overlay-only paths are new regular files, plus the directories their paths imply.
    let prefix = scope === "" ? "" : `${scope}/`;
    // Any deletion under the scope can hollow out a directory, and judging that takes the full
    // subtree, so it forces the recursive walk even for a non-recursive listing.
    let removedInScope = [...removed].some(removedPath => removedPath.startsWith(prefix));
    let entries = new Map<string, WorktreeFileEntry["kind"]>();
    if (baseScope !== undefined) {
      let listing = await this.host.gitCache.listCommitTreePaths(
          base, scope === "" ? undefined : scope, { recursive: recursive || removedInScope });
      for (let entry of listing) {
        if (!recursive && entry.path.slice(prefix.length).includes("/")) continue;
        if ((entry.kind === "file" || entry.kind === "executable") &&
            removed.has(entry.path)) {
          continue;
        }
        entries.set(entry.path, entry.kind);
      }
      if (removedInScope) {
        // A directory survives only if some non-directory entry under it does (symlinks and
        // submodules always do -- they can't be deleted). Overlay additions under a pruned
        // directory re-add it below.
        let survivors = listing.filter(
            entry => entry.kind !== "dir" && !removed.has(entry.path));
        for (let [entryPath, kind] of entries) {
          if (kind === "dir" &&
              !survivors.some(survivor => survivor.path.startsWith(`${entryPath}/`))) {
            entries.delete(entryPath);
          }
        }
      }
    }
    for (let overlayPath of overlay.keys()) {
      if (prefix !== "" && !overlayPath.startsWith(prefix)) continue;
      let segments = overlayPath.slice(prefix.length).split("/");
      let depth = recursive ? segments.length : Math.min(segments.length, 2);
      for (let i = 1; i < depth; i++) {
        let dir = prefix + segments.slice(0, i).join("/");
        if (!entries.has(dir)) entries.set(dir, "dir");
      }
      if ((recursive || segments.length === 1) && !entries.has(overlayPath)) {
        entries.set(overlayPath, "file");
      }
    }
    // Nothing at all under the scope: absent from the base (or hollowed out entirely) and no
    // overlay path either. The root always exists, even over an emptied worktree.
    if (scope !== "" && entries.size === 0) {
      throw new Error(`${scope}: no such directory`);
    }
    return [...entries]
        .map(([entryPath, kind]) => ({ path: entryPath, kind }))
        .toSorted((a, b) => a.path < b.path ? -1 : 1);
  }

  async readFile(path: string): Promise<string> {
    this.#pinBase();
    let text = await this.turn.readFile(this.worktreeId, path);
    if (text === undefined) throw new Error(`${path}: no such file`);
    return text;
  }

  async writeFile(path: string, text: string): Promise<void> {
    let base = this.#pinBase();
    let overlay = this.turn.getOverlayFiles(this.worktreeId);
    let before: string | undefined;
    if (overlay.has(path)) {
      before = overlay.get(path);
    } else if (!this.turn.getRemovedPaths(this.worktreeId).has(path)) {
      // The base entry is still live: reject symlink/gitlink/directory targets with the
      // descriptive read errors (the same rule as the writeFile tool), then read the base text
      // -- faulting it into the session content, so the diffed edit below applies against it.
      // Unreadable *content* is fine: a whole-file set is coherent against any base.
      await this.host.gitCache.assertWorktreePathWritable(base, path);
      try {
        before = await this.turn.readFile(this.worktreeId, path);
      } catch (err) {
        if (!(err instanceof UnreadableContentError)) throw err;
      }
    }
    if (before === text) return;  // no-op: nothing to record

    // A readable existing file gets a minimal diffed edit (fast-diff via diffFiles), keeping
    // rows and composed changes bounded by changed regions; a new file -- and an unreadable
    // base -- gets a whole-file `set`.
    let change: FileChange = { set: text };
    if (before !== undefined) {
      let one = (value: string) => new Map([[this.worktreeId, new Map([[path, value]])]]);
      change = diffFiles(one(before), one(text))[this.worktreeId][0][1];
    }
    this.turn.appendChange(this.worktreeId, path, change);
  }

  async deleteFile(path: string): Promise<void> {
    let base = this.#pinBase();
    if (!this.turn.getOverlayFiles(this.worktreeId).has(path)) {
      if (this.turn.getRemovedPaths(this.worktreeId).has(path)) {
        throw new Error(`${path}: no such file`);
      }
      // Same base-entry rules as writes: symlink/gitlink/directory paths throw their
      // descriptive errors (deleting a directory's last *file* prunes the directory at commit
      // instead). Unreadable content is deletable -- only the entry's shape matters.
      await this.host.gitCache.assertWorktreePathWritable(base, path);
      if (await this.host.gitCache.pathEntryAtCommit(base, path) === undefined) {
        throw new Error(`${path}: no such file`);
      }
    }
    this.turn.appendChange(this.worktreeId, path, { remove: true });
  }

  async grep(pattern: RegExp, path?: string | string[]): Promise<string> {
    let scan = await scanWorkpieceForGrep(
        this.host.gitCache, this.turn, this.worktreeId, this.#pinBase(), path);
    return formatGrep(scan, pattern, Infinity);
  }

  async structuredGrep(pattern: RegExp, path?: string | string[])
      : Promise<StructuredGrepResult> {
    let { files, errors } = await scanWorkpieceForGrep(
        this.host.gitCache, this.turn, this.worktreeId, this.#pinBase(), path);
    return {
      matches: files.flatMap(file =>
          matchLines(file.text, pattern).map(match => ({ file: file.path, ...match }))),
      errors,
    };
  }


  async commit(message: string): Promise<string> {
    // Resolved first: it may be an RPC, and the worktree state read below shouldn't go stale
    // across it.
    let author = commitIdentityForAuthor(await this.author());
    let base = this.#pinBase();
    let previousHead = this.#head();

    // The current content is by definition pinBase's tree with the epoch's overlay applied, so
    // the tree builds from (treeBase: pinBase, overlay) directly -- no diff computation -- while
    // the *parent* is the last explicit commit: if accepts have advanced the pin through
    // auto-commits since, they simply never appear in this commit's ancestry (squash semantics;
    // see WorktreeRecord). The overlay may include lazily-read untouched files; content
    // addressing makes rewriting them a no-op that reuses their blob oids and modes.
    let changes = new Map<string, string | null>();
    for (let [path, text] of this.turn.getOverlayFiles(this.worktreeId)) {
      changes.set(path, text);
    }
    for (let path of this.turn.getRemovedPaths(this.worktreeId)) {
      changes.set(path, null);
    }
    let commit = await this.host.gitStore.writeChangedFilesAsCommit(changes, {
      treeBase: base,
      parents: [previousHead],
      author,
      message,
      timestamp: new Date(),
    });

    // The record's pinBase and the epoch's rows are deliberately untouched: the rows remain the
    // single durable record of the overlay, so replaying them on top of the unchanged base
    // cannot double-apply. Only the head advances -- in memory now, durably at the step's
    // barrier (see WorktreeTurnAccess.appendCommit) -- and a worktree not yet pinned in the
    // chat pins at its (unchanged) base, so the advancement is a revertable proposed change.
    this.turn.appendCommit(this.worktreeId, commit, previousHead);
    return commit;
  }

  async diff(commitId?: string): Promise<string> {
    let parts: string[] = [];
    for (let file of await this.#changedFiles(commitId)) {
      if (file.note !== undefined) {
        parts.push(`(cannot diff ${file.path}: ${file.note})`);
        continue;
      }
      // An executable's mode is spelled as git spells it, ahead of the content diff (if any): a
      // mode change, or an added/removed executable. (Git also spells out the default 100644 of
      // an added/removed regular file; that is left implied here, to keep the common case terse.)
      let modeLines = gitModeLines(file);
      if (modeLines.length > 0) {
        parts.push([`diff --git a/${file.path} b/${file.path}`, ...modeLines].join("\n"));
        if (file.oldText === file.newText) continue;  // only the mode changed
      }
      let diff = formatUnifiedDiff(file.path, file.oldText ?? "", file.newText ?? "",
                                   file.oldText !== undefined, file.newText !== undefined);
      if (diff !== undefined) parts.push(diff);
    }
    return parts.join("\n");
  }

  async structuredDiff(commitId?: string): Promise<StructuredDiffResult> {
    let result: StructuredDiffResult = { files: [], errors: [] };
    for (let file of await this.#changedFiles(commitId)) {
      if (file.note !== undefined) {
        result.errors.push({ file: file.path, error: file.note });
        continue;
      }
      let status: DiffFile["status"] = file.oldText === undefined ? "added"
          : file.newText === undefined ? "removed" : "modified";
      let entry: DiffFile = { path: file.path, status,
                              hunks: structuredHunks(file.oldText ?? "", file.newText ?? "") };
      if (file.oldKind !== undefined) entry.oldKind = file.oldKind;
      if (file.newKind !== undefined) entry.newKind = file.newKind;
      result.files.push(entry);
    }
    return result;
  }

  // The paths that differ between the worktree and `commitId` (default HEAD), in path order:
  // each with its text on both sides (undefined where absent), or a note explaining why it
  // cannot be diffed as text.
  async #changedFiles(commitId?: string): Promise<ChangedFile[]> {
    let base = this.#pinBase();
    let target = commitId !== undefined
        ? this.host.gitCache.resolveCommitId(commitId) : this.#head();
    let overlay = this.turn.getOverlayFiles(this.worktreeId);
    let removed = this.turn.getRemovedPaths(this.worktreeId);

    // Candidate paths: the oid-level tree diff between the target and the pin base, plus the
    // overlay's touches -- bounded by activity on both sides, never the tree's size.
    let paths = await this.host.gitCache.changedFilePathsBetween(target, base);
    for (let path of overlay.keys()) paths.add(path);
    for (let path of removed) paths.add(path);

    // A side that cannot be rendered as text -- a symlink or submodule entry, or unreadable
    // (oversized/binary) content -- contributes a note carrying its descriptive error instead
    // of a diff. Only those expected shapes degrade to notes: the entry's kind is resolved
    // first and the text read catches exactly UnreadableContentError, so an operational
    // failure (a pull outage, a corrupt object) still fails the diff rather than silently
    // rendering an incomplete one.
    let readSide = async (commit: string, path: string): Promise<DiffSide> => {
      let entry = await this.host.gitCache.pathEntryAtCommit(commit, path);
      if (entry === undefined || entry.kind === "dir") return {};
      if (entry.kind === "submodule") {
        return { note: `${path} is a submodule (gitlink) pointing at commit ${entry.oid}` };
      }
      try {
        let text = await this.host.gitCache.readTextBlob(entry.oid, entry.referencedBy, path);
        // A symlink's blob is its target, so the note names it (the shape readFile throws).
        return entry.kind === "symlink" ? { note: `${path} is a symlink to ${text}` }
            : { text, kind: entry.kind };
      } catch (err) {
        if (err instanceof UnreadableContentError) return { note: err.message };
        throw err;
      }
    };

    let files: ChangedFile[] = [];
    for (let path of [...paths].toSorted()) {
      let oldSide = await readSide(target, path);
      let newSide: DiffSide;
      if (overlay.has(path)) {
        // An overlay file keeps its base entry's mode (the one a commit would write, see
        // GitStore.writeChangedFilesAsCommit); a new one is a regular file.
        let baseEntry = await this.host.gitCache.pathEntryAtCommit(base, path);
        newSide = { text: overlay.get(path),
                    kind: baseEntry?.kind === "executable" ? "executable" : "file" };
      } else if (removed.has(path)) {
        newSide = {};  // removed: no current text
      } else {
        newSide = await readSide(base, path);
      }
      if (oldSide.note !== undefined || newSide.note !== undefined) {
        files.push({ path, note: oldSide.note ?? newSide.note });
      } else if (oldSide.text !== newSide.text || oldSide.kind !== newSide.kind) {
        files.push({ path, oldText: oldSide.text, newText: newSide.text,
                     oldKind: oldSide.kind, newKind: newSide.kind });
      }
    }
    return files;
  }
}

/** One side of a path being diffed: its text and kind (absent where it doesn't exist), or a note. */
type DiffSide = { text?: string, kind?: DiffFileKind, note?: string };

/** One path found to differ by WorktreeSessionImpl's diff operations. */
type ChangedFile = {
  path: string,
  oldText?: string,
  newText?: string,
  oldKind?: DiffFileKind,
  newKind?: DiffFileKind,
  note?: string,
};

/** The git tree modes of the diffable kinds, as a diff's mode lines spell them. */
const GIT_FILE_MODES: Record<DiffFileKind, string> = { file: "100644", executable: "100755" };

/**
 * The git-style mode lines diff() renders for a file: for a mode change, or for an added or
 * removed executable. None otherwise.
 */
function gitModeLines({ oldKind, newKind }: ChangedFile): string[] {
  if (oldKind !== undefined && newKind !== undefined) {
    return oldKind === newKind ? []
        : [`old mode ${GIT_FILE_MODES[oldKind]}`, `new mode ${GIT_FILE_MODES[newKind]}`];
  }
  if (newKind === "executable") return [`new file mode ${GIT_FILE_MODES[newKind]}`];
  if (oldKind === "executable") return [`deleted file mode ${GIT_FILE_MODES[oldKind]}`];
  return [];
}

/**
 * One file's before/after as structured hunks: the same jsdiff hunks (and options)
 * formatUnifiedDiff renders, numbered line by line, with headers spelled exactly as the rendered
 * diff spells them -- including git's convention that a zero-count side names the line it
 * attaches after, where jsdiff's structured starts point one past it.
 */
function structuredHunks(oldText: string, newText: string): DiffHunk[] {
  let patch = structuredPatch("", "", oldText, newText, undefined, undefined, { context: 3 });
  return patch.hunks.map(hunk => {
    let oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart;
    let newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart;
    let oldLine = oldStart;
    let newLine = newStart;
    let lines = hunk.lines.map((raw): DiffLine => {
      let text = raw.slice(1);
      switch (raw[0]) {
        case "+": return { kind: "added", text, newLineNumber: newLine++ };
        case "-": return { kind: "removed", text, oldLineNumber: oldLine++ };
        // The `\ No newline at end of file` marker: kept whole, and numbered on neither side.
        case "\\": return { kind: "context", text: raw };
        default:
          return { kind: "context", text, oldLineNumber: oldLine++, newLineNumber: newLine++ };
      }
    });
    return { header: `@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`, lines };
  });
}
