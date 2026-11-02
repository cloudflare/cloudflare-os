import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { evaluateActions, tagTargetsFromLsRemote, type ActionsInput } from "./actions.ts";
import { DEPENDABOT_EMAIL, DEPENDABOT_LOGIN } from "./deps.ts";
import { parseDiff } from "./diff.ts";

// Real Dependabot github-actions pull requests merged into main (`git diff -U0` of the squash
// commit), and the `git ls-remote` answers for their new tags, recorded 2026-11-02.
// `pr784-workshop-evals-only.diff` is #784's diff limited to its one unguarded workflow.
const testdata = (name: string) => readFileSync(new URL(`./testdata/actions/${name}`, import.meta.url), "utf8");

function input(diff: string): ActionsInput {
  return {
    author: DEPENDABOT_LOGIN,
    headRef: "dependabot/github_actions/github-actions-recorded",
    commitEmails: [DEPENDABOT_EMAIL],
    files: parseDiff(testdata(diff)),
    tagTargets: {
      "actions/upload-artifact@v7.0.2":
        tagTargetsFromLsRemote(testdata("ls-remote-actions-upload-artifact-v7.0.2.txt"), "v7.0.2"),
      "actions/download-artifact@v8.0.2":
        tagTargetsFromLsRemote(testdata("ls-remote-actions-download-artifact-v8.0.2.txt"), "v8.0.2"),
    },
  };
}

describe("proof-actions on recorded Dependabot pull requests", () => {
  it("holds for SHA-pin moves in an unguarded workflow whose tags name those SHAs", () => {
    const outcome = evaluateActions(input("pr784-workshop-evals-only.diff"));
    assert.equal(outcome.holds, true, JSON.stringify(outcome.details));
    assert.deepEqual(outcome.details.moves,
      ["actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2"]);
  });

  it("fails #784, which also moves pins in the eval workflow that produces evidence", () => {
    const outcome = evaluateActions(input("pr784.diff"));
    assert.equal(outcome.holds, false);
    assert.deepEqual(outcome.details.reasons, [".github/workflows/workshop-evals-pr.yml: a guarded workflow"]);
  });

  it("fails #621, which moves pins in preview.yml", () => {
    const outcome = evaluateActions(input("pr621.diff"));
    assert.equal(outcome.holds, false);
    assert.ok(Array.isArray(outcome.details.reasons) &&
      outcome.details.reasons.includes(".github/workflows/preview.yml: a guarded workflow"));
  });

  it("fails when the tag does not name the pinned SHA (a commit that exists only in a fork)", () => {
    const forked = { ...input("pr784-workshop-evals-only.diff"), tagTargets: { "actions/upload-artifact@v7.0.2": ["0".repeat(40)] } };
    assert.deepEqual(evaluateActions(forked).details.reasons,
      ["actions/upload-artifact@v7.0.2: the tag does not point at cf430e030ddbb5b0abf93d22962f4752f3646cd9"]);
  });

  it("does not apply to an npm bump or a person's pull request", () => {
    assert.equal(evaluateActions({ ...input("pr784.diff"), headRef: "dependabot/npm_and_yarn/x" }).status, "not_applicable");
    assert.equal(evaluateActions({ ...input("pr784.diff"), author: "ndisidore" }).status, "not_applicable");
  });
});
