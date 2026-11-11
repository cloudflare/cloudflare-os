import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { replayCase } from "./backtest.ts";
import { createTestRepo } from "./test-repo.ts";

describe("replayCase", () => {
  it("records a commit it cannot fetch on that case instead of stopping the run", () => {
    const repo = createTestRepo();
    try {
      const head = repo.commit({ "REVIEW.md": "rules", "src/a.ts": "1\n" });
      const missing = "0".repeat(40);
      const record = replayCase(repo.dir, { id: "gone", title: "t", headSha: head, baseSha: missing, linesChanged: 1, catchable: true },
        head, "/nonexistent/opencode", { CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_GATEWAY_ID: "g", CLOUDFLARE_API_TOKEN: "t" });
      assert.equal(record.case, "gone");
      assert.match(record.runner_error ?? "", /fetch/);
      assert.equal(record.verdict.status, "error");
    } finally {
      repo.remove();
    }
  });
});
