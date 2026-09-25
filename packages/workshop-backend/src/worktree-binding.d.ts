// This file declares the type of a worktree binding -- a binding that basically provides access
// to a file tree, with git integration. An agent can create a worktree binding from a git commit,
// then use its regular file-edit tooling to read and write the files in the worktree. It can also
// access the worktree programmatically in `executeCode` tool calls, where the binding has the API
// defined below.
//
// Agents can create a worktree using the `createWorktree` tool call, similar to `createGadget`
// but takes a commit ID. The commit ID can be obtained from various gatekeeper APIs, e.g. the
// GitHub gatekeeper. Commits created on a worktree can then be pushed back to the gatekeeper.
//
// Any code -- gadgets and agents alike -- can also create in-memory worktrees programmatically
// through the `Git` binding, present as `env.GIT` in every environment (see git-binding.ts).
//
// The agent's `describeBinding` tool serves the agent-facing section of this file as text
// (worktree-binding.txt is a symlink to this file, shipped as a Text module -- the
// agent-spawner-binding.txt pattern), so everything below the marker is written for the agent
// as its audience.

// Everything below the following line is returned to agents via `describeBinding`.
// ---- BEGIN AGENT API ----

/**
 * The `env.GIT` binding, available in every gadget's `env` and in the agent's `executeCode` env.
 * Provides programmatic access to the workspace's git objects.
 */
export interface Git {
  /**
   * Create a worktree rooted at the given commit, which must be known to the workspace: e.g. a
   * commit ID obtained from a gatekeeper API, or one produced by an earlier `Worktree.commit()`.
   * The ID must be given in full (40 lowercase hex digits); abbreviated IDs are not accepted.
   *
   * The worktree exists only in memory: nothing is stored when it is created, and uncommitted
   * changes are lost once the returned stub is disposed or its connection breaks. Commits made
   * through it, however, are saved in the workspace's git store, so a commit ID is a durable
   * handle -- store it and pass it back to `newWorktree()` later to pick up where you left off.
   */
  newWorktree(commitId: string): Promise<Worktree>;

  /**
   * Read the metadata of the given commit: its message, author, parents, etc. As with
   * `newWorktree()`, the commit must be known to the workspace and its ID given in full.
   *
   * The result does not describe the commit's files; to read those, create a worktree rooted at
   * the commit with `newWorktree()`.
   */
  readCommit(commitId: string): Promise<CommitMetadata>;
}

/** Result of `Git.readCommit()`. */
export type CommitMetadata = {
  /**
   * IDs of the commit's parent commits, in order: empty for a root commit, more than one for a
   * merge commit.
   */
  parents: string[];

  /** The commit message, as stored (usually with a trailing newline). */
  message: string;

  /** Who wrote the change, and when. */
  author: CommitSignature;

  /** Who created the commit, and when. Often the same as `author`. */
  committer: CommitSignature;
};

/**
 * An identity and timestamp recorded in a commit (git's term; unrelated to cryptographic
 * signing).
 */
export type CommitSignature = {
  /** Human-readable name, e.g. "Jane Doe". */
  name: string;

  /** Email address. */
  email: string;

  /** When the author or committer acted. Git records this with one-second precision. */
  timestamp: Date;

  /**
   * The offset from UTC of the time zone the timestamp was recorded in, in minutes: e.g. -300 for
   * UTC-05:00. Note that the sign is the opposite of JavaScript's `Date.getTimezoneOffset()`.
   */
  utcOffsetMinutes: number;
};

/**
 * A worktree represents a file tree based on a git commit, with an API to read and edit its files
 * and commit the results.
 *
 * A worktree binding in your env created with the `createWorktree` tool can also be read and
 * edited using the same tools used to operate on gadget code, targeting the worktree binding
 * instead of a gadget binding. You should prefer those tools when they work. Only use this API when
 * you want to operate on the files more programmatically, or to perform operations other than
 * basic reads and edits. (Worktrees returned by `Git.newWorktree()` are accessible only through
 * this API.)
 */
export interface Worktree {
  // ---------------------------------------------------------------------------
  // File operations

  /**
   * List the entries of the directory at `path` (the worktree root when omitted), or all of its
   * descendants with `recursive: true`. Every returned path is a full path from the worktree
   * root, suitable for passing back to the other file operations.
   */
  listFiles(path?: string, options?: {recursive?: boolean}): Promise<WorktreeFileEntry[]>;

  /** Read a file as text. */
  readFile(path: string): Promise<string>;

  /**
   * Write a file's entire content, creating it if absent. An edited executable file keeps its
   * executable bit; newly created files are regular non-executable files.
   */
  writeFile(path: string, text: string): Promise<void>;

  /** Delete a file. */
  deleteFile(path: string): Promise<void>;

  /**
   * Search for all lines matching the given regular expression. With `path` omitted, searches
   * every file in the worktree. A string `path` searches that file, or recursively searches that
   * directory. An array searches each listed file/directory (deduplicated), which is more
   * efficient than separate `grep()` calls; an empty array searches nothing.
   *
   * Files that cannot be searched (binary/over-limit files, symlinks, submodules) are skipped
   * with a note, as is a listed path that doesn't exist -- but if *every* listed path fails this
   * way, the call throws instead.
   *
   * Returns results in the format `grep -n` would return, intended to be viewed by a human or
   * agent. This format is useful if you just intend to console.log() it. Do not try to parse this
   * format; if you intend to operate on the result programmatically, use `structuredGrep()`
   * instead.
   */
  grep(pattern: RegExp, path?: string | Array<string>): Promise<string>;

  /**
   * Like grep but returns a structured format useful for analyzing in code. The files `grep()`
   * would skip with a note are reported in `errors`.
   */
  structuredGrep(pattern: RegExp, path?: string | Array<string>): Promise<StructuredGrepResult>;

  // ---------------------------------------------------------------------------
  // Git operations

  /**
   * Commit the contents of the worktree to git, returning the new commit ID, and updating the head
   * commit to point at it.
   *
   * There is no separate staging. All changes you have made in this worktree will be included in
   * the git commit.
   */
  commit(message: string): Promise<string>;

  /**
   * Diff the worktree content against the given commit (defaults to the current head commit --
   * the last commit() made here, initially the commit the worktree was created from). `commitId`
   * may be any commit known to the workspace, given in full (abbreviated IDs are not accepted),
   * e.g. the worktree's base commit to see everything changed since it was created.
   *
   * Returns the diff in a format similar to `git diff`. An empty string means no differences.
   * Paths that cannot be rendered as text (binary/over-limit files, symlinks, submodules)
   * contribute a note instead of a diff.
   *
   * This format is intended to be viewed by a human or agent. Do not try to parse it; if you
   * intend to operate on the result programmatically, use `structuredDiff()` instead.
   */
  diff(commitId?: string): Promise<string>;

  /**
   * Like diff but returns a structured format useful for analyzing in code. The paths `diff()`
   * would render as a note are reported in `errors`.
   */
  structuredDiff(commitId?: string): Promise<StructuredDiffResult>;

  // TODO(someday):
  // - merge?
  // - soft reset? (hard reset is better-accomplished by creating a new worktree)
}

/** One entry of a `listFiles()` result. */
export type WorktreeFileEntry = {
  /** Full path from the worktree root. */
  path: string;

  /**
   * What the entry is. "file" and "executable" are regular files -- readable and editable, and an
   * edited executable keeps its executable bit. "dir" is a directory.
   *
   * As of this writing, operating on "symlink" and "submodule" entries is not yet supported. File
   * operations on them throw a descriptive error (naming the symlink's target or the submodule's
   * pinned commit), and searches skip them. This will change in the future.
   */
  kind: "file" | "executable" | "dir" | "symlink" | "submodule";
};

/** Result of `structuredGrep()`. */
export type StructuredGrepResult = {
  /** All matching lines, ordered by file path. */
  matches: GrepMatch[];

  /**
   * Files that could not be searched: symlinks, submodules, binary or over-limit content, and
   * listed paths that don't exist.
   */
  errors: GrepFileError[];
};

/** One unsearchable file reported by `structuredGrep()`. */
export type GrepFileError = {
  /** Full path of the file that could not be searched. */
  file: string;

  /** Human-readable description of why (the text `grep()` renders as a `(skipped: ...)` note). */
  error: string;
};

/** One match returned by `structuredGrep()`. */
export type GrepMatch = {
  /** Full path of the file containing a match. */
  file: string;

  /** Text line number (1 based) of the match. */
  line: number;

  /** Contents of the line that matched. */
  text: string;
};

/** Result of `structuredDiff()`. */
export type StructuredDiffResult = {
  /**
   * Every file that differs, ordered by path. A path whose type changed appears twice: its
   * removal, then its addition (see `DiffFile.status`).
   */
  files: DiffFile[];

  /**
   * Paths that differ but could not be diffed as text: symlinks, submodules, and binary or
   * over-limit content (on either side).
   */
  errors: DiffFileError[];
};

/** One path reported by `structuredDiff()` as impossible to diff. */
export type DiffFileError = {
  /** Full path from the worktree root. */
  file: string;

  /** Human-readable description of why (the text of `diff()`'s `(cannot diff ...)` note). */
  error: string;
};

/** One changed file returned by `structuredDiff()`. */
export type DiffFile = {
  /** Full path from the worktree root. */
  path: string;

  /**
   * "added" if the file is absent from the commit diffed against, "removed" if it is absent from
   * the worktree, otherwise "modified". Renames are not detected: they appear as a removal plus
   * an addition. Likewise a "modified" file never changes type -- only its content or its
   * executable bit -- so a path whose type changes (e.g. a file replaced by a symlink) is
   * reported as a removal followed by an addition, as `git diff` reports it.
   */
  status: "added" | "modified" | "removed";

  /**
   * The file's kind (as `listFiles()` reports it) in the commit diffed against. Present unless
   * `status` is "added".
   */
  oldKind?: DiffFileKind;

  /** The file's kind in the worktree. Present unless `status` is "removed". */
  newKind?: DiffFileKind;

  /**
   * The changed regions, in file order, each with up to 3 lines of surrounding context. Empty
   * when an empty file was added or removed, or when only the executable bit changed (`oldKind`
   * and `newKind` differ).
   */
  hunks: DiffHunk[];
};

/**
 * The kind of a file reported by `structuredDiff()`: a regular file, with or without its
 * executable bit. (Other kinds of entry are reported in `errors`, for now.)
 */
export type DiffFileKind = "file" | "executable";

/** One hunk inside a changed file. */
export type DiffHunk = {
  /** The hunk's `@@ -oldStart,oldCount +newStart,newCount @@` line, as `diff()` renders it. */
  header: string;

  /** The hunk's lines, in order. */
  lines: DiffLine[];
};

/** One line inside a diff hunk. */
export type DiffLine = {
  /**
   * "added" lines exist only in the worktree, "removed" lines only in the commit diffed against,
   * and "context" lines in both.
   */
  kind: "context" | "added" | "removed";

  /**
   * The line's content, without its newline. As in `git diff`, a final line missing its newline
   * is followed by a "context" line with the text `\ No newline at end of file`, which has no
   * line numbers.
   */
  text: string;

  /** Line number (1 based) in the commit diffed against; present on "removed" and "context". */
  oldLineNumber?: number;

  /** Line number (1 based) in the worktree; present on "added" and "context". */
  newLineNumber?: number;
};
