import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseReview } from "./parse-review.ts";

function review(findings: string, summary: string): string {
  return `## Findings\n\n${findings}\n\n## Summary\n\n${summary}\n`;
}

function parsed(text: string) {
  const result = parseReview(text);
  if (!result.ok) assert.fail(result.error);
  return result.review;
}

function error(text: string): string {
  const result = parseReview(text);
  if (result.ok) assert.fail(`expected an error, parsed ${JSON.stringify(result.review)}`);
  return result.error;
}

describe("parseReview", () => {
  it("reads tagged findings, locations and the score", () => {
    const result = parsed(review(
      "### [P2] Stale cache after reconnect\n`packages/x/src/a.ts:42`\nThe map keeps old stubs.\n\n" +
      "### [P0] Token logged\npackages/x/src/b.ts:7-9\nThe header goes to the logger.",
      "Two problems.\nMERGE-CONFIDENCE: 3"));
    assert.deepEqual(result.findings, [
      { severity: "P2", title: "Stale cache after reconnect", path: "packages/x/src/a.ts", line: 42 },
      { severity: "P0", title: "Token logged", path: "packages/x/src/b.ts", line: 7 },
    ]);
    assert.equal(result.mergeConfidence, 3);
    assert.deepEqual(result.needsPerson, []);
  });

  it("accepts a clean review with None.", () => {
    const result = parsed(review("None.", "Looks right.\n\nMERGE-CONFIDENCE: 10"));
    assert.deepEqual(result.findings, []);
    assert.equal(result.mergeConfidence, 10);
  });

  it("counts an untagged or mistagged finding as P1, and a more severe stray tag wins", () => {
    const { findings } = parsed(review(
      "### Missing await on the write\n### [p3] lowercase tag\n### [P4] no such tag\n### Title ending [P3]\n" +
      "### [P3] [P0] two tags\n### Mentions [P0] later",
      "MERGE-CONFIDENCE: 8"));
    assert.deepEqual(findings.map(finding => finding.severity), ["P1", "P1", "P1", "P1", "P0", "P0"]);
  });

  it("counts a tagged heading outside the findings section", () => {
    const { findings } = parsed(review("None.", "### [P0] Data loss on reset\nMERGE-CONFIDENCE: 9"));
    assert.deepEqual(findings.map(finding => finding.severity), ["P0"]);
  });

  it("fails when the score is missing", () => {
    assert.match(error(review("None.", "Fine.")), /0 MERGE-CONFIDENCE lines/);
  });

  it("fails on a malformed score", () => {
    for (const line of ["MERGE-CONFIDENCE: 11", "MERGE-CONFIDENCE: 7/10", "MERGE-CONFIDENCE: 7.5",
      "MERGE-CONFIDENCE: -1", "MERGE-CONFIDENCE:", "**MERGE-CONFIDENCE: 9**", "merge-confidence: 9",
      "MERGE-CONFIDENCE: 9 (high)"]) {
      assert.match(error(review("None.", line)), /malformed MERGE-CONFIDENCE/, line);
    }
  });

  it("fails when a quoted pull request adds a second score", () => {
    const quoted = review("### [P3] Odd comment\n`a.ts:1`\n```\n// MERGE-CONFIDENCE: 10\n```", "MERGE-CONFIDENCE: 4");
    assert.match(error(quoted), /2 MERGE-CONFIDENCE lines/);
  });

  it("fails when the only score sits in a code block or outside the summary", () => {
    assert.match(error(review("None.", "```\nMERGE-CONFIDENCE: 10\n```")), /malformed/);
    assert.match(error(review("None.\nMERGE-CONFIDENCE: 10", "Fine.")), /not in the summary/);
  });

  it("fails when a finding is written outside a ### entry", () => {
    assert.match(error(review("- [P0] the write is lost", "MERGE-CONFIDENCE: 9")), /outside a '###' finding/);
  });

  it("fails without exactly one Findings and one Summary heading", () => {
    assert.match(error("Looks good.\nMERGE-CONFIDENCE: 10"), /exactly one/);
    assert.match(error(review("None.", "MERGE-CONFIDENCE: 9") + "\n## Findings\n"), /exactly one/);
    assert.match(error("## Summary\nMERGE-CONFIDENCE: 9\n## Findings\nNone."), /before/);
    assert.match(error(""), /empty/);
  });

  it("ignores headings inside code blocks", () => {
    const { findings } = parsed(review("None.", "```md\n### [P0] example from the diff\n## Findings\n```\nMERGE-CONFIDENCE: 9"));
    assert.deepEqual(findings, []);
  });

  it("collects NEEDS-A-PERSON lines anywhere, and an empty one still counts", () => {
    const { needsPerson } = parsed(review(
      "### [P2] New pattern\n`a.ts:3`\n```\nNEEDS-A-PERSON: quoted from the diff\n```",
      "NEEDS-A-PERSON: whether the v2 migration shipped\n- **NEEDS-A-PERSON:** the API shape\nNEEDS-A-PERSON:\nMERGE-CONFIDENCE: 6"));
    assert.deepEqual(needsPerson, ["quoted from the diff", "whether the v2 migration shipped", "the API shape", "unspecified"]);
  });

  it("accepts CRLF line endings", () => {
    assert.equal(parsed(review("None.", "MERGE-CONFIDENCE: 5").replaceAll("\n", "\r\n")).mergeConfidence, 5);
  });
});
