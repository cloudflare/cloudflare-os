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
// Content rules match the file tools': regular files of either mode are operable (an edited
// executable keeps its bit), symlink/gitlink/directory paths throw their descriptive errors,
// and unreadable *content* (oversized/binary) is distinguished from path-shape errors by
// UnreadableContentError -- writeFile falls back to a whole-file `set` on it, while grep
// reports it as a structured error entry (a "(skipped: ...)" note in the freeform format) and
// diff renders it as a skip note.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  GrepFileError, StructuredGrepResult, Worktree, WorktreeFileEntry,
} from "./worktree-binding";
import type { AiChatAuthorInfo, WorkpieceId } from "@gadgets/workshop-shared/api";
import { diffFiles, type FileChange } from "@gadgets/workshop-shared/code-change";
import type { GitOid } from "@gadgets/workshop-shared/gatekeeper";
import {
  GitObjectTooLargeError,
  MAX_GIT_OBJECT_SIZE,
  UnreadableContentError,
  type WorkspaceGitCache,
} from "./git-cache";
import { commitIdentityForAuthor, type GitStore } from "./git-store";
import { formatUnifiedDiff, type WorktreeTurnAccess } from "./agent";

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

// One file to search: an overlay path (text in hand) or a base tree entry (blob by oid).
type GrepCandidate = { path: string, oid?: GitOid };

/**
 * The Worktree binding served to executeCode. One instance per (execution, worktree); see the
 * module doc for how state splits between the turn (`turn`) and the workspace (`host`).
 */
@validateRpc()
export class WorktreeSessionImpl extends RpcTarget implements Worktree {
  constructor(private host: WorktreeSessionHost, private worktreeId: WorkpieceId,
              private turn: WorktreeTurnAccess, private initiator: AiChatAuthorInfo) {
    super();
  }

  // The chat pin's base commit: what the current epoch's overlay is expressed against.
  #pinBase(): string {
    let base = this.turn.getPinBase(this.worktreeId);
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
    let { files, errors, single } = await this.#grepFiles(path);
    let out: string[] = [];
    for (let file of files) {
      for (let match of matchLines(file.text, pattern)) {
        out.push(single
            ? `${match.line}:${match.text}`
            : `${file.path}:${match.line}:${match.text}`);
      }
    }
    if (out.length === 0) out.push("(no matches)");
    out.push(...errors.map(error => `(skipped: ${error.error})`));
    return out.join("\n");
  }

  async structuredGrep(pattern: RegExp, path?: string | string[])
      : Promise<StructuredGrepResult> {
    let { files, errors } = await this.#grepFiles(path);
    return {
      matches: files.flatMap(file =>
          matchLines(file.text, pattern).map(match => ({ file: file.path, ...match }))),
      errors,
    };
  }

  // Resolves a grep path argument to the searchable files' text. Each listed scope is a file or
  // a directory to scan recursively in the overlay-over-base view (undefined means the whole
  // tree); unsearchable files -- symlinks, submodules, oversized and binary blobs -- and listed
  // paths that don't exist degrade to error entries, except that when *every* listed scope
  // fails, the whole call throws (so a lone bad path is an exception, not an easily-missed
  // one-line result). Missing base blobs are filled in one batched pull across all scopes --
  // the reason the argument accepts an array -- never a serial walk-and-fetch; an oversized
  // blob (measured, or omitted by the pull's own filter) drops out of the batch with an error
  // entry rather than failing it.
  async #grepFiles(pathArg: string | string[] | undefined): Promise<{
    files: { path: string, text: string }[],
    errors: GrepFileError[],
    single: boolean,
  }> {
    let base = this.#pinBase();
    let overlay = this.turn.getOverlayFiles(this.worktreeId);
    let removed = this.turn.getRemovedPaths(this.worktreeId);

    // Overlapping scopes (["src", "src/util.js"]) resolve to one candidate per path, and one
    // error entry per unsearchable file, no matter how many scopes cover it.
    let scopes = [...new Set(typeof pathArg === "string" ? [pathArg] : pathArg ?? [""])];
    let candidates = new Map<string, GrepCandidate>();
    let errorByFile = new Map<string, string>();
    let failedScopes = new Map<string, string>();
    // Scopes that named a base file directly: unreadable *content* (oversized/binary),
    // discovered only after the batched pull, still counts as the scope failing.
    let namedFiles = new Set<string>();
    let single = false;

    for (let scope of scopes) {
      let overlayText = overlay.get(scope);
      if (scope !== "" && overlayText !== undefined) {
        candidates.set(scope, { path: scope });
        single = typeof pathArg === "string";
        continue;
      }
      let entry = scope !== "" && removed.has(scope)
          ? undefined : await this.host.gitCache.pathEntryAtCommit(base, scope);
      if (entry !== undefined && entry.kind !== "dir") {
        if (entry.kind === "symlink" || entry.kind === "submodule") {
          failedScopes.set(scope, `${scope} is a ${entry.kind}`);
          continue;
        }
        candidates.set(scope, { path: scope, oid: entry.oid });
        namedFiles.add(scope);
        single = typeof pathArg === "string";
        continue;
      }

      // A directory scope: its base entries (when it exists in the base) plus the overlay's
      // paths under it. A scope with neither doesn't exist.
      let prefix = scope === "" ? "" : `${scope}/`;
      let found = false;
      if (entry !== undefined) {
        found = true;
        for (let treeEntry of await this.host.gitCache.listCommitTreePaths(
            base, scope === "" ? undefined : scope, { recursive: true })) {
          if (treeEntry.kind === "dir") continue;
          if (treeEntry.kind === "symlink" || treeEntry.kind === "submodule") {
            errorByFile.set(treeEntry.path, `${treeEntry.path} is a ${treeEntry.kind}`);
            continue;
          }
          if (removed.has(treeEntry.path) || overlay.has(treeEntry.path)) continue;
          candidates.set(treeEntry.path, { path: treeEntry.path, oid: treeEntry.oid });
        }
      }
      for (let overlayPath of overlay.keys()) {
        if (prefix === "" || overlayPath.startsWith(prefix)) {
          candidates.set(overlayPath, { path: overlayPath });
          found = true;
        }
      }
      if (!found) failedScopes.set(scope, `${scope}: no such file or directory`);
    }

    // One batched fetch for every missing base blob, across all scopes. Paths with identical
    // content share one blob oid, so each oid maps to every path holding it: an oversized blob
    // then notes each of those files, keeping the one-error-per-skipped-file promise.
    let missing = new Map<GitOid, string[]>();
    for (let candidate of candidates.values()) {
      if (candidate.oid !== undefined && !this.host.gitCache.hasLocalObject(candidate.oid)) {
        let missingPaths = missing.get(candidate.oid);
        if (missingPaths === undefined) missing.set(candidate.oid, missingPaths = []);
        missingPaths.push(candidate.path);
      }
    }
    let skipped = new Set<GitOid>();
    while (missing.size > 0) {
      try {
        await this.host.gitCache.ensureGitObjects([...missing.keys()], {
          type: "blob",
          commitHistory: { kind: "depth", depth: 1 },
          filterBlobSize: MAX_GIT_OBJECT_SIZE + 1,
        });
        break;
      } catch (err) {
        if (err instanceof GitObjectTooLargeError && missing.has(err.oid)) {
          for (let missingPath of missing.get(err.oid)!) {
            errorByFile.set(missingPath, `${missingPath} is too large to read`);
          }
          skipped.add(err.oid);
          missing.delete(err.oid);
          continue;  // retry the rest of the batch (already-pulled blobs are skipped)
        }
        throw err;
      }
    }

    let files: { path: string, text: string }[] = [];
    for (let candidate of [...candidates.values()]
        .toSorted((a, b) => a.path < b.path ? -1 : 1)) {
      if (candidate.oid === undefined) {
        files.push({ path: candidate.path, text: overlay.get(candidate.path)! });
        continue;
      }
      if (skipped.has(candidate.oid)) continue;
      try {
        files.push({
          path: candidate.path,
          text: await this.host.gitCache.readTextBlob(candidate.oid, base, candidate.path),
        });
      } catch (err) {
        if (err instanceof UnreadableContentError) {
          errorByFile.set(candidate.path, err.message);
          continue;
        }
        throw err;
      }
    }

    // The all-listed-scopes-failed throw. A directly named file whose content proved unreadable
    // failed its scope too; a scope that resolved (the root always does) succeeded even if it
    // yielded nothing searchable. An empty array lists nothing, so it fails nothing: an empty
    // result.
    for (let scope of namedFiles) {
      let message = errorByFile.get(scope);
      if (message !== undefined) failedScopes.set(scope, message);
    }
    if (scopes.length > 0 && failedScopes.size === scopes.length) {
      throw new Error([...failedScopes.values()].join("; "));
    }
    for (let [file, message] of failedScopes) errorByFile.set(file, message);

    let errors = [...errorByFile]
        .map(([file, message]) => ({ file, error: message }))
        .toSorted((a, b) => a.file < b.file ? -1 : 1);
    return { files, errors, single };
  }

  async commit(message: string): Promise<string> {
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
      // The turn's initiator: in a collaborative chat, a collaborator's work is attributed to
      // the collaborator, matching how accepted commits use the acting user's profile.
      author: commitIdentityForAuthor(this.initiator),
      message,
      timestamp: new Date(),
    });

    // The chat's pin, the record's pinBase, and the epoch's rows are all deliberately
    // untouched: the rows remain the single durable record of the overlay, so replaying them
    // on top of the unchanged pin cannot double-apply. Only the head advances -- in memory now,
    // durably at the step's barrier (see WorktreeTurnAccess.appendCommit).
    this.turn.appendCommit(this.worktreeId, commit, previousHead);
    return commit;
  }

  async diff(commitId?: string): Promise<string> {
    let base = this.#pinBase();
    let target = commitId !== undefined
        ? this.host.gitCache.resolveCommitRef(commitId) : this.#head();
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
    let readSide = async (commit: string, path: string)
        : Promise<{ text?: string, note?: string }> => {
      let entry = await this.host.gitCache.pathEntryAtCommit(commit, path);
      if (entry === undefined || entry.kind === "dir") return {};
      if (entry.kind === "submodule") {
        return { note: `${path} is a submodule (gitlink) pointing at commit ${entry.oid}` };
      }
      try {
        let text = await this.host.gitCache.readTextBlob(entry.oid, entry.referencedBy, path);
        // A symlink's blob is its target, so the note names it (the shape readFile throws).
        return entry.kind === "symlink" ? { note: `${path} is a symlink to ${text}` } : { text };
      } catch (err) {
        if (err instanceof UnreadableContentError) return { note: err.message };
        throw err;
      }
    };

    let parts: string[] = [];
    for (let path of [...paths].toSorted()) {
      let oldSide = await readSide(target, path);
      let newSide: { text?: string, note?: string };
      if (overlay.has(path)) {
        newSide = { text: overlay.get(path) };
      } else if (removed.has(path)) {
        newSide = {};  // removed: no current text
      } else {
        newSide = await readSide(base, path);
      }
      if (oldSide.note !== undefined || newSide.note !== undefined) {
        parts.push(`(cannot diff ${path}: ${oldSide.note ?? newSide.note})`);
        continue;
      }
      if (oldSide.text === newSide.text) continue;
      let diff = formatUnifiedDiff(path, oldSide.text ?? "", newSide.text ?? "",
                                   oldSide.text !== undefined, newSide.text !== undefined);
      if (diff !== undefined) parts.push(diff);
    }
    return parts.join("\n");
  }
}

// The lines of `text` matching `pattern`, 1-based, in order. The RegExp arrived over RPC
// (structured clone); match against a fresh copy with lastIndex reset per line, so a sticky or
// global flag can't skip lines.
function matchLines(text: string, pattern: RegExp): { line: number, text: string }[] {
  let re = new RegExp(pattern.source, pattern.flags);
  let lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let out: { line: number, text: string }[] = [];
  for (let [index, line] of lines.entries()) {
    re.lastIndex = 0;
    if (re.test(line)) out.push({ line: index + 1, text: line });
  }
  return out;
}
