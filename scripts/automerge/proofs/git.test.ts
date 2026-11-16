import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileAt, filesIn } from "./git.ts";

describe("fileAt", () => {
  // git quotes a path with non-ASCII bytes in ls-tree output unless it is asked for -z.
  it("reads a file whose path git would quote", () => {
    const dir = mkdtempSync(join(tmpdir(), "automerge-git-test-"));
    try {
      const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
      run("init", "-q");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "tést.test.ts"), "export {};\n");
      run("add", ".");
      run("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "x");
      const sha = run("rev-parse", "HEAD");
      assert.equal(fileAt(sha, "src/tést.test.ts", dir), "export {};\n");
      assert.equal(fileAt(sha, "src/missing.test.ts", dir), undefined);
      // Clanky on #987: a listing without -z quoted this name, so proof-actions skipped the file.
      assert.deepEqual(filesIn(sha, "src/", dir), ["src/tést.test.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
