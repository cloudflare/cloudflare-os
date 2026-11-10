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

const bonkWorkflow = readFileSync(new URL("../../../.github/workflows/bonk-pr.yml", import.meta.url), "utf8");

/** The step names of bonk-pr.yml's `bonk` job, in order. */
function bonkSteps(): string[] {
  const job = bonkWorkflow.slice(bonkWorkflow.indexOf("\n  bonk:\n"));
  return [...job.matchAll(/^ {6}- name: (.+)$/gm)].map(match => match[1].trim());
}

describe("bonk-pr.yml", () => {
  it("replaces instruction files before Bonk runs and writes the verdict after", () => {
    const steps = bonkSteps();
    const at = (name: string) => steps.indexOf(name);
    assert.ok(at("Prepare the review") > at("Set up Vite+, Node.js and dependencies"));
    assert.ok(at("Prepare the review") < at("Run Bonk"));
    assert.ok(at("Run Bonk") < at("Write the verdict") && at("Write the verdict") < at("Upload the verdict"));
    assert.match(bonkWorkflow, /run: node scripts\/automerge\/verdict\/bonk\.ts prepare/);
    assert.match(bonkWorkflow, /run: node scripts\/automerge\/verdict\/bonk\.ts verdict/);
  });

  // The verdict records BONK_MODEL as the model; it must be exactly what Bonk was given.
  it("passes Bonk the model input the verdict records", () => {
    assert.match(bonkWorkflow, /^ {6}BONK_MODEL: cloudflare-ai-gateway\/\$\{\{ vars\.BONK_MODEL \}\}$/m);
    assert.match(bonkWorkflow, /^ {10}model: \$\{\{ env\.BONK_MODEL \}\}$/m);
  });
});
