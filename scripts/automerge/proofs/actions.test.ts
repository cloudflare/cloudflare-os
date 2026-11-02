import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { evaluateActions, tagTargetsFromLsRemote, type ActionsInput } from "./actions.ts";
import { DEPENDABOT_EMAIL, DEPENDABOT_LOGIN } from "./deps.ts";
import { parseDiff } from "./diff.ts";

// Real Dependabot github-actions pull requests merged into main (`git diff -U0` of the squash
// commit), the `git ls-remote` answers for their new tags, recorded 2026-11-02 and 2026-11-03, and
// each touched workflow as it stood at the pull request's base (`pr621-base/`, `pr784-base/`).
// `pr621-ci-only.diff` is #621's diff limited to its ci.yml hunks.
const testdata = (name: string) => readFileSync(new URL(`./testdata/actions/${name}`, import.meta.url), "utf8");
const CI = ".github/workflows/ci.yml";
const ciAtBase = testdata("pr621-base/ci.yml");

function input(diff: string, base: string): ActionsInput {
  const files = parseDiff(testdata(diff));
  return {
    author: DEPENDABOT_LOGIN,
    headRef: "dependabot/github_actions/github-actions-recorded",
    commitEmails: [DEPENDABOT_EMAIL],
    files,
    tagTargets: {
      "actions/upload-artifact@v7.0.2":
        tagTargetsFromLsRemote(testdata("ls-remote-actions-upload-artifact-v7.0.2.txt"), "v7.0.2"),
      "actions/download-artifact@v8.0.2":
        tagTargetsFromLsRemote(testdata("ls-remote-actions-download-artifact-v8.0.2.txt"), "v8.0.2"),
      "voidzero-dev/setup-vp@v1.21.1":
        tagTargetsFromLsRemote(testdata("ls-remote-voidzero-dev-setup-vp-v1.21.1.txt"), "v1.21.1"),
    },
    baseWorkflows: Object.fromEntries(files.map((file) =>
      [file.path, testdata(`${base}/${file.path.replace(".github/workflows/", "")}`)])),
  };
}

/** #621's ci.yml bump, with ci.yml at the base replaced by `workflow`. */
function ciBump(workflow: string): ActionsInput {
  return { ...input("pr621-ci-only.diff", "pr621-base"), baseWorkflows: { [CI]: workflow } };
}

function reasons(value: ActionsInput): string[] {
  const outcome = evaluateActions(value);
  assert.equal(outcome.holds, false);
  const listed = outcome.details.reasons;
  assert.ok(Array.isArray(listed));
  return listed.map(String);
}

describe("proof-actions on recorded Dependabot pull requests", () => {
  it("holds for #621's bump confined to ci.yml, which holds no credential", () => {
    const outcome = evaluateActions(input("pr621-ci-only.diff", "pr621-base"));
    assert.equal(outcome.holds, true, JSON.stringify(outcome.details));
    assert.deepEqual(outcome.details.moves, [
      "voidzero-dev/setup-vp@3754dd7dbdb32bd8f6d28b6043de13ad3a75f21f # v1.21.1",
      "voidzero-dev/setup-vp@3754dd7dbdb32bd8f6d28b6043de13ad3a75f21f # v1.21.1",
    ]);
    assert.deepEqual(outcome.details.workflows_checked, [CI]);
  });

  it("fails #621 on the workflows beside ci.yml that hold credentials", () => {
    const listed = reasons(input("pr621.diff", "pr621-base"));
    assert.deepEqual(listed.filter((reason) => reason.startsWith(CI)), []);
    for (const reason of [
      ".github/workflows/preview.yml: names secrets",
      ".github/workflows/preview.yml: job deploy permission pull-requests is write",
      ".github/workflows/workshop-evals-pr.yml: names secrets",
      ".github/workflows/workshop-evals-pr.yml: job trajectory-review permission id-token is write",
      ".github/workflows/workshop-evals.yml: names secrets",
      ".github/workflows/workshop-evals.yml: top-level permission checks is write",
    ]) assert.ok(listed.includes(reason), `missing "${reason}" in ${JSON.stringify(listed)}`);
  });

  it("fails #784, whose eval workflows hold credentials", () => {
    const listed = reasons(input("pr784.diff", "pr784-base"));
    assert.ok(listed.includes(".github/workflows/workshop-evals-pr.yml: names secrets"));
    assert.ok(listed.includes(".github/workflows/workshop-evals.yml: top-level permission checks is write"));
  });

  it("fails when the tag does not name the pinned SHA (a commit that exists only in a fork)", () => {
    const forked = { ...input("pr621-ci-only.diff", "pr621-base"), tagTargets: { "voidzero-dev/setup-vp@v1.21.1": ["0".repeat(40)] } };
    assert.deepEqual([...new Set(reasons(forked))],
      ["voidzero-dev/setup-vp@v1.21.1: the tag does not point at 3754dd7dbdb32bd8f6d28b6043de13ad3a75f21f"]);
  });

  it("fails a touched workflow missing at the base", () => {
    assert.deepEqual(reasons({ ...input("pr621-ci-only.diff", "pr621-base"), baseWorkflows: {} }), [`${CI}: not at the base`]);
  });

  it("does not apply to an npm bump or a person's pull request", () => {
    const value = input("pr621-ci-only.diff", "pr621-base");
    assert.equal(evaluateActions({ ...value, headRef: "dependabot/npm_and_yarn/x" }).status, "not_applicable");
    assert.equal(evaluateActions({ ...value, author: "ndisidore" }).status, "not_applicable");
  });
});

// Each case edits ci.yml at #621's base and must fail #621's otherwise-holding ci.yml bump.
const LINT_JOB = "  lint:\n    name: Lint\n";
const withJobLines = (lines: string) => ciAtBase.replace(LINT_JOB, `${LINT_JOB}${lines}`);
const withTop = (from: string, to: string) => {
  assert.ok(ciAtBase.includes(from));
  return ciAtBase.replace(from, to);
};
const PERMISSIONS = "permissions:\n  contents: read\n";

describe("proof-actions credential rule", () => {
  const cases: [string, string, string][] = [
    ["secrets: inherit on a job", withJobLines("    secrets: inherit\n"), "names secrets"],
    ["a job environment", withJobLines("    environment: production\n"), "job lint runs in an environment"],
    ["a job-level contents: write", withJobLines("    permissions:\n      contents: write\n"), "job lint permission contents is write"],
    ["no top-level permissions", withTop(PERMISSIONS, ""), "has no top-level permissions"],
    ["a workflow_call trigger", withTop("  pull_request:\n", "  pull_request:\n  workflow_call:\n"),
      "can be called by another workflow (workflow_call)"],
    ["a job-level reusable workflow", withJobLines("    uses: ./.github/workflows/other.yml\n"), "job lint calls a reusable workflow"],
    ["`${{secrets.X}}` without spaces", withJobLines("    env:\n      X: ${{secrets.X}}\n"), "names secrets"],
    ["`secrets[...]` index syntax", withJobLines("    env:\n      X: ${{ secrets['X'] }}\n"), "names secrets"],
    ["an upper-case context", withJobLines("    env:\n      X: ${{ SECRETS.X }}\n"), "names secrets"],
    ["a \\u escape in a double-quoted scalar", withJobLines('    env:\n      X: "${{ \\u0073ecrets.X }}"\n'), "names secrets"],
    ["an escaped line break in a double-quoted scalar", withJobLines('    env:\n      X: "${{ sec\\\n        rets.X }}"\n'), "names secrets"],
    ["write-all", withTop(PERMISSIONS, "permissions: write-all\n"), 'top-level permissions are "write-all"'],
    ["a flow-style permissions map", withTop(PERMISSIONS, "permissions: { contents: write }\n"),
      "top-level permissions are not {} or a block mapping"],
    ["a quoted key", withTop(PERMISSIONS, 'permissions:\n  "contents": "write"\n'), "top-level permission contents is write"],
    ["a duplicate key", withTop(PERMISSIONS, `${PERMISSIONS}permissions: write-all\n`), "cannot be parsed: line 11: a duplicate key: permissions"],
    ["a case-folded duplicate key", withTop(PERMISSIONS, `${PERMISSIONS}Permissions: write-all\n`), "cannot be parsed: line 11: a duplicate key: Permissions"],
    ["an alias for permissions", withTop(PERMISSIONS, "permissions: *write\n"), "cannot be parsed: line 9: an anchor, alias or tag"],
    ["an anchored permissions map", withTop(PERMISSIONS, "permissions: &p\n  contents: write\n"), "cannot be parsed: line 9: an anchor, alias or tag"],
    ["a merge key", withJobLines("    <<: *defaults\n"), "cannot be parsed: line 21: not a mapping entry: <<: *defaults"],
    ["a job written as a flow map", withTop("  lint:\n    name: Lint\n", "  extra: { environment: production }\n  lint:\n    name: Lint\n"),
      "job extra is not a block mapping"],
    ["a multi-line plain scalar", withJobLines("    if: github.ref ==\n      'refs/heads/main'\n"), "cannot be parsed: line 22: an indented line after a scalar (a multi-line scalar is not accepted)"],
    ["a second document", `${ciAtBase}---\npermissions: write-all\n`, "cannot be parsed: line 90: a document marker or directive"],
  ];
  for (const [name, workflow, reason] of cases) {
    it(`fails ${name}`, () => {
      assert.ok(reasons(ciBump(workflow)).includes(`${CI}: ${reason}`), JSON.stringify(reasons(ciBump(workflow))));
    });
  }

  it("accepts {}, none and read-all, having checked the workflow", () => {
    for (const permissions of ["permissions: {}\n", "permissions:\n  contents: none\n", "permissions: read-all\n"]) {
      const outcome = evaluateActions(ciBump(withTop(PERMISSIONS, permissions)));
      assert.equal(outcome.holds, true, JSON.stringify(outcome.details));
      assert.deepEqual(outcome.details.workflows_checked, [CI]);
    }
  });
});
