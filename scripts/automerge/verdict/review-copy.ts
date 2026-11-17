// Gives a reviewer the head commit's code with every file that steers an agent taken from the base
// commit instead: a fresh copy written from git objects for the Opus runner, or the checkout itself
// for Bonk, which reads the working tree.
import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * File names an agent reads as instructions, matched at any depth and in any case. opencode 1.18.33
 * attaches the nearest AGENTS.md, CLAUDE.md or CONTEXT.md to every file its read tool returns, even
 * with project config disabled (measured 2026-11-02), so a nested one is as live as the root one.
 */
const INSTRUCTION_FILES = new Set(["agents.md", "claude.md", "context.md", "review.md", "contributing.md",
  "opencode.json", "opencode.jsonc"]);
/** Directories an agent loads skills, agents, tools, plugins or config from, matched at any depth. */
const INSTRUCTION_DIRS = new Set([".agents", ".opencode", ".claude"]);
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);
// The largest single read: the whole tree's blobs, which is about 40 MiB at main today.
const MAX_TREE_BYTES = 1024 * 1024 * 1024;

/** Whether the review copy takes this repository path from the base commit rather than the head. */
export function isInstructionPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  return INSTRUCTION_FILES.has(segments[segments.length - 1]) ||
    segments.slice(0, -1).some(segment => INSTRUCTION_DIRS.has(segment));
}

interface TreeEntry {
  mode: string;
  object: string;
  path: string;
}

function listTree(repo: string, commit: string): TreeEntry[] {
  const output = execFileSync("git", ["-C", repo, "ls-tree", "-r", "-z", "--full-tree", commit],
    { encoding: "utf8", maxBuffer: MAX_TREE_BYTES });
  return output.split("\0").filter(record => record !== "").map(record => {
    const tab = record.indexOf("\t");
    const [mode, , object] = record.slice(0, tab).split(" ");
    return { mode, object, path: record.slice(tab + 1) };
  });
}

/** Blob contents by object id, read in one `git cat-file --batch` pass. */
function readBlobs(repo: string, objects: string[]): Map<string, Buffer> {
  if (objects.length === 0) return new Map();
  const output = execFileSync("git", ["-C", repo, "cat-file", "--batch"],
    { input: objects.join("\n") + "\n", maxBuffer: MAX_TREE_BYTES });
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    const [object, type, size] = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (type !== "blob") throw new Error(`git cat-file returned ${type ?? "nothing"} for ${object}`);
    const start = headerEnd + 1;
    const end = start + Number(size);
    blobs.set(object, output.subarray(start, end));
    offset = end + 1;
  }
  return blobs;
}

/** A tree path is written under the output directory only if it cannot step outside it. */
function assertSafePath(path: string): void {
  const segments = path.split("/");
  if (path.startsWith("/") || segments.some(segment => segment === "" || segment === "." || segment === ".." ||
    segment.toLowerCase() === ".git")) {
    throw new Error(`refusing tree path ${JSON.stringify(path)}`);
  }
}

export interface ReviewCopy {
  /** Head paths the copy replaced or removed because they are instruction paths. */
  headInstructionPaths: string[];
  /** Symlinks and submodules, which the copy leaves out. */
  skipped: string[];
}

/**
 * Writes the head tree of `repo` into the empty directory `outDir`, with instruction paths from
 * `baseSha` in place of the head's. Symlinks are left out: one pointing at `/proc/self/environ`
 * would hand the reviewer the gateway token through its read tool. Files are written without
 * their executable bit, since nothing runs them.
 */
export function buildReviewCopy(repo: string, headSha: string, baseSha: string, outDir: string): ReviewCopy {
  if (readdirSync(outDir).length > 0) throw new Error(`${outDir} is not empty`);
  const head = listTree(repo, headSha);
  const skipped = head.filter(entry => !REGULAR_FILE_MODES.has(entry.mode)).map(entry => entry.path);
  const files = [
    ...head.filter(entry => REGULAR_FILE_MODES.has(entry.mode) && !isInstructionPath(entry.path)),
    ...listTree(repo, baseSha).filter(entry => REGULAR_FILE_MODES.has(entry.mode) && isInstructionPath(entry.path)),
  ];
  for (const { path } of files) assertSafePath(path);
  const blobs = readBlobs(repo, [...new Set(files.map(entry => entry.object))]);
  for (const { path, object } of files) {
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    const content = blobs.get(object);
    if (content === undefined) throw new Error(`git cat-file did not return ${object} for ${path}`);
    writeFileSync(target, content, { mode: 0o644 });
  }
  return {
    headInstructionPaths: head.filter(entry => isInstructionPath(entry.path)).map(entry => entry.path),
    skipped,
  };
}

/** Refuses a write whose parent directories are not all real directories inside `root`. */
function assertRealParents(root: string, path: string): void {
  const segments = path.split("/").slice(0, -1);
  for (let depth = 1; depth <= segments.length; depth++) {
    const stat = lstatSync(join(root, ...segments.slice(0, depth)), { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (!stat.isDirectory()) throw new Error(`refusing ${JSON.stringify(path)}: a parent is not a directory`);
  }
}

/**
 * Puts the base commit's instruction files in place of the head's in `worktree`, a checkout of
 * `headSha`, before a reviewer that reads the working tree runs there. Every head instruction path,
 * symlinks among them, is removed; every regular base instruction file is written in its place, and
 * base symlinks are left out. Returns the head paths it removed or replaced.
 *
 * None of this shows in `git status`: the pinned opencode runner commits and pushes a dirty checkout
 * after the review. Tracked head paths are marked skip-worktree, and base files the head does not
 * track are listed in the repository's own exclude file.
 */
export function replaceInstructionFiles(worktree: string, headSha: string, baseSha: string): string[] {
  const head = listTree(worktree, headSha).filter(entry => isInstructionPath(entry.path)).map(entry => entry.path);
  const base = listTree(worktree, baseSha).filter(entry => REGULAR_FILE_MODES.has(entry.mode) && isInstructionPath(entry.path));
  for (const path of [...head, ...base.map(entry => entry.path)]) {
    assertSafePath(path);
    assertRealParents(worktree, path);
    rmSync(join(worktree, path), { recursive: true, force: true });
  }
  const blobs = readBlobs(worktree, [...new Set(base.map(entry => entry.object))]);
  for (const { path, object } of base) {
    const content = blobs.get(object);
    if (content === undefined) throw new Error(`git cat-file did not return ${object} for ${path}`);
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    assertRealParents(worktree, path);
    writeFileSync(join(worktree, path), content, { mode: 0o644 });
  }
  if (head.length > 0) {
    execFileSync("git", ["-C", worktree, "update-index", "--skip-worktree", "-z", "--stdin"], { input: `${head.join("\0")}\0` });
  }
  const tracked = new Set(head);
  const untracked = base.map(entry => entry.path).filter(path => !tracked.has(path));
  if (untracked.length > 0) {
    const exclude = resolve(worktree, execFileSync("git", ["-C", worktree, "rev-parse", "--git-path", "info/exclude"],
      { encoding: "utf8" }).trim());
    mkdirSync(dirname(exclude), { recursive: true });
    // Anchored, with gitignore's special characters escaped, so each line matches only its path.
    appendFileSync(exclude, `\n${untracked.map(path => `/${path.replaceAll(/[\\*?[]/g, "\\$&").replace(/ +$/, spaces =>
      spaces.replaceAll(" ", "\\ "))}`).join("\n")}\n`);
  }
  return head;
}
