// Reads a pull request's diff: `git diff -U0` (the exact command is `DIFF_ARGS`) and its parser.
// With no context lines, each hunk is one contiguous run of changed lines, and git's default hunk
// header names the last line above it that starts with a letter, `_` or `$`. The lockfile rule
// reads that as the top-level key the hunk sits under, to tell `packages:` from `importers:`. It
// may because readLockfile fails a lockfile with any other line at column 0, and the rule fails a
// hunk that adds or removes one.

import { git } from "../git.ts";

/** Arguments for `git diff` that produce the text `parseDiff` reads. Add `<base>...<head>`. */
const DIFF_ARGS = [
  "-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv",
  "--no-renames", "--src-prefix=a/", "--dst-prefix=b/",
];

/** One run of changed lines. */
export interface Hunk {
  /** The line git printed after the `@@` header, or "" when there was none. */
  section: string;
  removed: string[];
  added: string[];
}

/** One file in the diff. */
export interface FileDiff {
  path: string;
  status: "added" | "deleted" | "modified";
  /** Git printed "Binary files ... differ" instead of hunks. */
  binary: boolean;
  /** The file mode changed, or a new file is not a plain non-executable file (for example a symlink). */
  modeChanged: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/;

/** Parses `git diff` output produced with `DIFF_ARGS`. Throws on anything it does not recognize. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!match || match[1] !== match[2]) throw new Error(`unparseable diff header: ${line}`);
      file = { path: match[2], status: "modified", binary: false, modeChanged: false, hunks: [] };
      hunk = undefined;
      files.push(file);
      continue;
    }
    if (!file) throw new Error(`diff text before the first file header: ${line}`);
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = { section: header[1], removed: [], added: [] };
      file.hunks.push(hunk);
    } else if (hunk && line.startsWith("-")) {
      hunk.removed.push(line.slice(1));
    } else if (hunk && line.startsWith("+")) {
      hunk.added.push(line.slice(1));
    } else if (line === "\\ No newline at end of file") {
      // Says nothing about the content.
    } else if (hunk) {
      throw new Error(`unexpected line inside a hunk of ${file.path}: ${line}`);
    } else if (line.startsWith("new file mode ")) {
      file.status = "added";
      file.modeChanged = line !== "new file mode 100644";
    } else if (line.startsWith("deleted file mode ")) {
      file.status = "deleted";
    } else if (line.startsWith("old mode ") || line.startsWith("new mode ")) {
      file.modeChanged = true;
    } else if (line.startsWith("Binary files ")) {
      file.binary = true;
    } else if (!/^(index |--- |\+\+\+ )/.test(line)) {
      throw new Error(`unexpected diff line for ${file.path}: ${line}`);
    }
  }
  return files;
}

/** The pull request's own change: `base...head`, the diff from their merge base. */
export function pullRequestDiff(base: string, head: string, cwd?: string): FileDiff[] {
  return parseDiff(git([...DIFF_ARGS, `${base}...${head}`], cwd));
}
