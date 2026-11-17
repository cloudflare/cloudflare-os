import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildBonkVerdict, type BonkInputs } from "./bonk.ts";

const MODEL = "cloudflare-ai-gateway/openai/gpt-6.1-sol";

function inputs(overrides: Partial<BonkInputs>): BonkInputs {
  return { headSha: "h", baseSha: "b", reviewedSha: "h", round: 1, report: null, model: MODEL, ...overrides };
}

const CLEAN = "## Findings\n\nNone.\n\n## Summary\n\nNothing to fix.\nMERGE-CONFIDENCE: 9\n";

describe("buildBonkVerdict", () => {
  it("is an error when Bonk's report file is missing, empty or not in the report format", () => {
    const cases: [string | null, RegExp][] = [[null, /wrote no report/], ["", /empty/], ["LGTM!\n", /exactly one/],
      ["## Findings\n\nNone.\n\n## Summary\n\nFine.\n", /MERGE-CONFIDENCE/]];
    for (const [report, reason] of cases) {
      const verdict = buildBonkVerdict(inputs({ report }));
      assert.equal(verdict.status, "error", String(report));
      assert.equal(verdict.merge_confidence, null);
      assert.match(verdict.details.reason ?? "", reason);
    }
  });

  // The pinned opencode runner checks out the pull request's branch by name, which a push during
  // the job moves past the head this artifact is bound to.
  it("is an error when the checkout Bonk reviewed is not the event's head", () => {
    const verdict = buildBonkVerdict(inputs({ report: CLEAN, reviewedSha: "newer" }));
    assert.equal(verdict.status, "error");
    assert.equal(verdict.head_sha, "h");
    assert.equal(verdict.merge_confidence, null);
    assert.match(verdict.details.reason ?? "", /newer/);
  });

  it("turns a clean review with no findings into an ok verdict", () => {
    const verdict = buildBonkVerdict(inputs({ report: CLEAN }));
    assert.equal(verdict.status, "ok");
    assert.equal(verdict.name, "bonk");
    assert.deepEqual(verdict.findings, []);
    assert.deepEqual(verdict.needs_person, []);
    assert.equal(verdict.merge_confidence, 9);
    assert.equal(verdict.review_from_sha, null);
    assert.equal(verdict.details.reason, null);
    assert.equal(verdict.model, MODEL);
  });

  it("keeps findings and NEEDS-A-PERSON lines from the report", () => {
    const verdict = buildBonkVerdict(inputs({ report:
      "## Findings\n\n### [P1] Lost write\n`src/a.ts:3`\nThe await is missing.\n\n## Summary\n\nNEEDS-A-PERSON: the API shape\nMERGE-CONFIDENCE: 3\n" }));
    assert.deepEqual(verdict.findings, [{ severity: "P1", title: "Lost write", path: "src/a.ts", line: 3 }]);
    assert.deepEqual(verdict.needs_person, ["the API shape"]);
  });

  it("carries the round limit from round 4, as the Opus runner does", () => {
    assert.deepEqual(buildBonkVerdict(inputs({ report: CLEAN, round: 3 })).needs_person, []);
    const limited = buildBonkVerdict(inputs({ report: CLEAN, round: 4 }));
    assert.equal(limited.status, "ok");
    assert.equal(limited.round, 4);
    assert.deepEqual(limited.needs_person, ["round limit"]);
    assert.deepEqual(buildBonkVerdict(inputs({ report: CLEAN, round: 6 })).needs_person, ["round limit"]);
  });
});
