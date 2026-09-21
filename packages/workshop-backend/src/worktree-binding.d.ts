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
// The agent's `describeBinding` tool serves the agent-facing section of this file as text
// (worktree-binding.txt is a symlink to this file, shipped as a Text module -- the
// agent-spawner-binding.txt pattern), so everything below the marker is written for the agent
// as its audience.

// Everything below the following line is returned to agents via `describeBinding`.
// ---- BEGIN AGENT API ----

/**
 * A worktree binding represents a file tree based on a git commit. You can read and edit files
 * in a worktree using the same tools used to operate on gadget code, targeting the worktree
 * binding instead of a gadget binding. You should prefer those tools when they work. Only use this
 * API when you want to operate on the files more programmatically, or to perform operations other
 * than basic reads and edits.
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
   * may be any commit known to the workspace, e.g. the worktree's base commit to see everything
   * changed since it was created.
   *
   * Returns the diff in a format similar to `git diff`. An empty string means no differences.
   * Paths that cannot be rendered as text (binary/over-limit files, symlinks, submodules)
   * contribute a note instead of a diff.
   */
  diff(commitId?: string): Promise<string>;

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
