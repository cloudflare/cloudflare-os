// Builds the directory the verdict reviewer reads: the head commit's tree, with every file that
// steers an agent taken from the base commit instead. Written from git objects, never from a
// checkout, so head `.gitattributes` and hooks play no part.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** File names an agent reads as instructions, matched at any depth and in any case. */
const INSTRUCTION_FILES = new Set(["agents.md", "claude.md", "review.md", "contributing.md", "opencode.json", "opencode.jsonc"]);
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
