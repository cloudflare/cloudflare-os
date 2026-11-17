// A throwaway git repository under the OS temp directory, for tests that need real commits.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TestRepo {
  dir: string;
  /** Replaces the working tree with `files` (a string is file content, `{ link }` a symlink) and commits. */
  commit(files: Record<string, string | { link: string }>): string;
  /** Runs git in the repository and returns its trimmed output. */
  git(...args: string[]): string;
  /** The blob id of `path` at `commit`. */
  blob(commit: string, path: string): string;
  remove(): void;
}

export function createTestRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "verdict-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  return {
    dir,
    commit(files) {
      git("rm", "-rq", "--ignore-unmatch", ".");
      for (const [path, content] of Object.entries(files)) {
        const target = join(dir, path);
        mkdirSync(dirname(target), { recursive: true });
        if (typeof content === "string") writeFileSync(target, content);
        else symlinkSync(content.link, target);
      }
      git("add", "-A");
      git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "commit", "--allow-empty");
      return git("rev-parse", "HEAD");
    },
    git,
    blob(commit, path) {
      return git("rev-parse", `${commit}:${path}`);
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
