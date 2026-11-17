import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { actionPins, buildBonkVerdict, type BonkInputs } from "./bonk.ts";

// bonk-pr.yml as of ee876fd35, recorded so an unrelated workflow edit cannot break these tests.
const bonkWorkflow = readFileSync(new URL("./testdata/bonk-pr-ee876fd35.yml", import.meta.url), "utf8");

const FINGERPRINT = {
  model: "cloudflare-ai-gateway/openai/gpt-6.1-sol",
  opencode: "1.18.33",
  review_md: "cedfc1a90e550948de007d540e3c05fba44c0994",
  prompt: "0".repeat(64),
  action: "14a1af226388b15b389a0c1b7df9168a940165b6",
};

function inputs(overrides: Partial<BonkInputs>): BonkInputs {
  return { headSha: "h", baseSha: "b", reviewedSha: "h", round: 1, report: null, fingerprint: FINGERPRINT, ...overrides };
}

const CLEAN = "## Findings\n\nNone.\n\n## Summary\n\nNothing to fix.\nMERGE-CONFIDENCE: 9\n";

describe("buildBonkVerdict", () => {
  it("is an error when Bonk's report file is missing, empty or not in the report format", () => {
    for (const [report, reason] of [[null, /wrote no report/], ["", /empty/], ["LGTM!\n", /exactly one/],
      ["## Findings\n\nNone.\n\n## Summary\n\nFine.\n", /MERGE-CONFIDENCE/]] as const) {
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
    assert.match(verdict.details.reason ?? "", /Bonk reviewed newer, not the pull request head h/);
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
    assert.deepEqual(verdict.fingerprint, FINGERPRINT);
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

describe("actionPins", () => {
  it("reads the ask-bonk SHA and opencode version from a recorded bonk-pr.yml", () => {
    assert.deepEqual(actionPins(bonkWorkflow), { action: "14a1af226388b15b389a0c1b7df9168a940165b6", opencode: "1.18.33" });
  });

  it("refuses a revision that pins no action, or two", () => {
    assert.ok("error" in actionPins(bonkWorkflow.replace(/uses: Cloudflare-Studio\/ask-bonk\/github@\w+/, "uses: other/action@v1")));
    assert.ok("error" in actionPins(`${bonkWorkflow}\n      - uses: Cloudflare-Studio/ask-bonk/github@${"a".repeat(40)}\n`));
    assert.ok("error" in actionPins(bonkWorkflow.replace(/opencode_version: \S+/, "")));
  });
});
