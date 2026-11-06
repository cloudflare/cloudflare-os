// The git reads the proofs make. Every one names commits by SHA, so the result does not depend on
// what is checked out.

import { execFileSync } from "node:child_process";
import { DIFF_ARGS, parseDiff, type FileDiff } from "./diff.ts";

/** Runs git and returns its stdout. */
export function git(args: string[], cwd = process.cwd()): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** The pull request's own change: `base...head`, the diff from their merge base. */
export function pullRequestDiff(base: string, head: string, cwd?: string): FileDiff[] {
  return parseDiff(git([...DIFF_ARGS, `${base}...${head}`], cwd));
}

/** The merge base of two commits. */
export function mergeBase(base: string, head: string, cwd?: string): string {
  return git(["merge-base", base, head], cwd).trim();
}

/** A file's content at a commit, or undefined when the path does not exist there. */
export function fileAt(sha: string, path: string, cwd?: string): string | undefined {
  const listed = git(["ls-tree", "--name-only", sha, "--", path], cwd).trim();
  if (listed !== path) return undefined;
  return git(["show", `${sha}:${path}`], cwd);
}
