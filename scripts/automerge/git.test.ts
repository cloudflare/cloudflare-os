import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fileAt } from "./git.ts";
import { createTestRepo } from "./test-repo.ts";

describe("fileAt", () => {
  // git quotes a path with non-ASCII bytes in ls-tree output unless it is asked for -z.
  it("reads a file whose path git would quote", () => {
    const repo = createTestRepo();
    try {
      const sha = repo.commit({ "src/tést.test.ts": "export {};\n" });
      assert.equal(fileAt(sha, "src/tést.test.ts", repo.dir), "export {};\n");
      assert.equal(fileAt(sha, "src/missing.test.ts", repo.dir), undefined);
    } finally {
      repo.remove();
    }
  });
});
