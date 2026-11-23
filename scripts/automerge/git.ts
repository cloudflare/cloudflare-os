// The one way judge code runs git. Callers name commits by SHA, so a result does not depend on
// what is checked out.

import { execFileSync, spawnSync } from "node:child_process";

/** The largest single read: a pull request's whole diff, every path in a tree, or all its blobs. */
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

/** Runs git in `cwd` and returns its stdout; throws when git fails. */
export function git(args: string[], cwd = process.cwd()): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES });
}

/** Runs git in `cwd` with `input` on its stdin and returns its stdout as bytes, which blobs need. */
export function gitWithInput(args: string[], input: string, cwd = process.cwd()): Buffer {
  return execFileSync("git", args, { cwd, input, maxBuffer: MAX_OUTPUT_BYTES });
}

/**
 * Runs git in `cwd` and returns its stdout, or undefined when git exits with an error: for a
 * question git answers by its exit status.
 */
export function tryGit(args: string[], cwd = process.cwd()): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES });
  return result.status === 0 ? result.stdout : undefined;
}

/** The merge base of two commits. */
export function mergeBase(base: string, head: string, cwd?: string): string {
  return git(["merge-base", base, head], cwd).trim();
}

/** A file's content at a commit, or undefined when the path does not exist there. */
export function fileAt(sha: string, path: string, cwd?: string): string | undefined {
  // `-z` prints the name as it is: without it git quotes a path with non-ASCII bytes, quotes or
  // backslashes, which would then not equal `path`.
  const listed = git(["ls-tree", "-z", "--name-only", sha, "--", path], cwd).replace(/\0$/, "");
  if (listed !== path) return undefined;
  return git(["show", `${sha}:${path}`], cwd);
}
