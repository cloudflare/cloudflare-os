import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(new URL("../../../.github/workflows/review-verdict.yml", import.meta.url), "utf8");

describe("review-verdict.yml", () => {
  // The job holds the gateway token and writes the verdict, so a head working tree that setup or
  // the scripts read (package.json `packageManager`, `.npmrc`, a script) could forge the verdict.
  it("checks out only the base commit and reads the head through git fetch", () => {
    const refs = [...workflow.matchAll(/^\s+ref: (.+)$/gm)].map(match => match[1].trim());
    assert.deepEqual(refs, ["${{ github.event.pull_request.base.sha }}"]);
    const headUses = workflow.split("\n").filter(line => line.includes("pull_request.head.sha"));
    assert.deepEqual(headUses.map(line => line.trim()), ["HEAD_SHA: ${{ github.event.pull_request.head.sha }}"]);
    assert.match(workflow, /fetch --no-tags origin "\$HEAD_SHA"/);
  });
});
