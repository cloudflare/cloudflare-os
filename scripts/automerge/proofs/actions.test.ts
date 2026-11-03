import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { evaluateActions, tagTargetsFromLsRemote, type ActionsInput } from "./actions.ts";
import { DEPENDABOT_EMAIL, DEPENDABOT_LOGIN } from "./deps.ts";
import { parseDiff } from "./diff.ts";

// Real Dependabot github-actions pull requests merged into main (`git diff -U0` of the squash
// commit), the `git ls-remote` answers for their new tags, recorded 2026-11-02 and 2026-11-03, and
// every workflow as it stood at the pull request's base (`pr621-base/`, `pr784-base/`).
// `pr621-ci-only.diff` is #621's diff limited to its ci.yml hunks.
const testdata = (name: string) => readFileSync(new URL(`./testdata/actions/${name}`, import.meta.url), "utf8");
const CI = ".github/workflows/ci.yml";
const PREVIEW = ".github/workflows/preview.yml";
const ciAtBase = testdata("pr621-base/ci.yml");

function workflowsIn(dir: URL): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).toSorted().map((name) =>
    [`.github/workflows/${name}`, readFileSync(new URL(name, dir), "utf8")]));
}
const recordedBase = (name: string) => workflowsIn(new URL(`./testdata/actions/${name}/`, import.meta.url));
/** This checkout's workflows, which the cache rule must hold for. */
const repoWorkflows = workflowsIn(new URL("../../../.github/workflows/", import.meta.url));

function input(diff: string, baseWorkflows: Record<string, string>): ActionsInput {
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
      "voidzero-dev/setup-vp@v1.21.1":
        tagTargetsFromLsRemote(testdata("ls-remote-voidzero-dev-setup-vp-v1.21.1.txt"), "v1.21.1"),
    },
    baseWorkflows,
  };
}

/** #621's ci.yml bump onto this checkout's workflows, with ci.yml replaced by `workflow`. */
function ciBump(workflow: string, others: Record<string, string> = {}): ActionsInput {
  return input("pr621-ci-only.diff", { ...repoWorkflows, [CI]: workflow, ...others });
}

function reasons(value: ActionsInput): string[] {
  const outcome = evaluateActions(value);
  assert.equal(outcome.holds, false);
  const listed = outcome.details.reasons;
  assert.ok(Array.isArray(listed));
  return listed.map(String);
}

describe("proof-actions on recorded Dependabot pull requests", () => {
  it("holds for #621's bump confined to ci.yml, onto workflows that keep the cache rule", () => {
    const outcome = evaluateActions(input("pr621-ci-only.diff", { ...repoWorkflows, [CI]: ciAtBase }));
    assert.equal(outcome.holds, true, JSON.stringify(outcome.details));
    assert.deepEqual(outcome.details.moves, [
      "voidzero-dev/setup-vp@3754dd7dbdb32bd8f6d28b6043de13ad3a75f21f # v1.21.1",
      "voidzero-dev/setup-vp@3754dd7dbdb32bd8f6d28b6043de13ad3a75f21f # v1.21.1",
    ]);
    assert.deepEqual(outcome.details.workflows_checked, [CI]);
    assert.deepEqual(outcome.details.cache_rule_checked, Object.keys(repoWorkflows));
  });

  it("fails #621's ci.yml bump at its real base, where preview.yml restored a cache beside its token", () => {
    const listed = reasons(input("pr621-ci-only.diff", recordedBase("pr621-base")));
    assert.deepEqual(listed.filter((reason) => reason.startsWith(CI)), []);
    for (const reason of [
      `${PREVIEW}: job deploy holds a credential, step 4: setup-vp cache is not false`,
      `${PREVIEW}: job cleanup holds a credential, step 4: setup-vp cache is not false`,
      ".github/workflows/workshop-evals.yml: job evals holds a credential, step 3: setup-vp cache is not false",
    ]) assert.ok(listed.includes(reason), `missing "${reason}" in ${JSON.stringify(listed)}`);
  });

  it("fails #621 on the workflows beside ci.yml that hold credentials", () => {
    const listed = reasons(input("pr621.diff", recordedBase("pr621-base")));
    assert.deepEqual(listed.filter((reason) => reason.startsWith(CI)), []);
    for (const reason of [
      `${PREVIEW}: names secrets`,
      `${PREVIEW}: job deploy permission pull-requests is write`,
      ".github/workflows/workshop-evals-pr.yml: names secrets",
      ".github/workflows/workshop-evals-pr.yml: job trajectory-review permission id-token is write",
      ".github/workflows/workshop-evals.yml: names secrets",
      ".github/workflows/workshop-evals.yml: top-level permission checks is write",
    ]) assert.ok(listed.includes(reason), `missing "${reason}" in ${JSON.stringify(listed)}`);
  });

  it("fails #784, whose eval workflows hold credentials", () => {
    const listed = reasons(input("pr784.diff", recordedBase("pr784-base")));
    assert.ok(listed.includes(".github/workflows/workshop-evals-pr.yml: names secrets"));
    assert.ok(listed.includes(".github/workflows/workshop-evals.yml: top-level permission checks is write"));
  });

  it("fails when the tag does not name the pinned SHA (a commit that exists only in a fork)", () => {
    const forked = { ...ciBump(ciAtBase), tagTargets: { "voidzero-dev/setup-vp@v1.21.1": ["0".repeat(40)] } };
    assert.deepEqual([...new Set(reasons(forked))],
      ["voidzero-dev/setup-vp@v1.21.1: the tag does not point at 3754dd7dbdb32bd8f6d28b6043de13ad3a75f21f"]);
  });

  it("fails a touched workflow missing at the base", () => {
    assert.deepEqual(reasons(input("pr621-ci-only.diff", {})), [`${CI}: not at the base`, "no workflows at the base"]);
  });

  it("does not apply to an npm bump or a person's pull request", () => {
    const value = ciBump(ciAtBase);
    assert.equal(evaluateActions({ ...value, headRef: "dependabot/npm_and_yarn/x" }).status, "not_applicable");
    assert.equal(evaluateActions({ ...value, author: "ndisidore" }).status, "not_applicable");
  });
});

describe("proof-actions cache rule, on this checkout's workflows", () => {
  const preview = repoWorkflows[PREVIEW];
  const CACHE_OFF = "          cache: false\n";
  const SECRET_JOB = [
    "name: Extra", "on: push", "permissions:", "  contents: read", "jobs:", "  extra:", "    runs-on: ubuntu-latest",
    "    steps:", "      - run: echo \"$T\"", "        env:", "          T: ${{ secrets.T }}",
  ].join("\n");
  const EXTRA = ".github/workflows/extra.yml";

  it("holds for every workflow here, each checked", () => {
    const outcome = evaluateActions(ciBump(ciAtBase));
    assert.equal(outcome.holds, true, JSON.stringify(outcome.details));
    assert.deepEqual(outcome.details.cache_rule_checked, Object.keys(repoWorkflows));
  });

  const cases: [string, Record<string, string>, string][] = [
    ["preview.yml's deploy job with setup-vp's cache back on", { [PREVIEW]: preview.replace(CACHE_OFF, "          cache: true\n") },
      `${PREVIEW}: job deploy holds a credential, step 4: setup-vp cache is not false`],
    ["setup-vp's toolchain cache in a job with a secret",
      { [EXTRA]: `${SECRET_JOB}\n      - uses: voidzero-dev/setup-vp@cab1ab9eaff52d4857875f4f2c016e36af8f2c76\n        with:\n          cache-toolchain: true\n` },
      `${EXTRA}: job extra holds a credential, step 2: setup-vp cache-toolchain is not false`],
    ["actions/cache/restore in a job with a secret",
      { [EXTRA]: `${SECRET_JOB}\n      - uses: actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830\n` },
      `${EXTRA}: job extra holds a credential, step 2: actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830 restores a cache`],
    ["setup-node, which caches by default, in a job with a secret",
      { [EXTRA]: `${SECRET_JOB}\n      - uses: actions/setup-node@v5\n` },
      `${EXTRA}: job extra holds a credential, step 2: actions/setup-node@v5 restores a cache`],
    ["a cache where the token's permissions are left to the repository default",
      { [EXTRA]: "on: push\njobs:\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/cache@v5\n" },
      `${EXTRA}: job extra holds a credential, step 1: actions/cache@v5 restores a cache`],
    ["a cache in a job whose token may write",
      { [EXTRA]: "on: push\npermissions: {}\njobs:\n  extra:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n" +
        "    steps:\n      - uses: actions/cache@v5\n" },
      `${EXTRA}: job extra holds a credential, step 1: actions/cache@v5 restores a cache`],
    ["a workflow the reader cannot parse", { [EXTRA]: "on: push\njobs: &j\n" },
      `${EXTRA}: cannot be parsed: line 2: an anchor, alias or tag`],
  ];
  for (const [name, others, reason] of cases) {
    it(`fails ${name}`, () => {
      const listed = reasons(ciBump(ciAtBase, others));
      assert.ok(listed.includes(reason), JSON.stringify(listed));
    });
  }

  it("allows a cache in a job that holds no credential", () => {
    const extra = "on: push\npermissions:\n  contents: read\njobs:\n  extra:\n    runs-on: ubuntu-latest\n" +
      "    steps:\n      - uses: actions/cache@v5\n";
    const outcome = evaluateActions(ciBump(ciAtBase, { [EXTRA]: extra }));
    assert.equal(outcome.holds, true, JSON.stringify(outcome.details));
    assert.ok(Array.isArray(outcome.details.cache_rule_checked) && outcome.details.cache_rule_checked.includes(EXTRA));
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
    ["`ſecrets`, which upper-cases to SECRETS", withJobLines("    env:\n      X: ${{ ſecrets.X }}\n"), "names secrets"],
    // Other YAML parsers break lines at these, which would make the environment a key of the job.
    ...["\r", "\u0085", "\u2028", "\u2029"].map((mark): [string, string, string] =>
      [`a line broken by U+${mark.codePointAt(0)?.toString(16).padStart(4, "0")}`,
        withJobLines(`    name: a${mark}    environment: production\n`),
        "cannot be parsed: line 21: a control character, a line break other than LF or CRLF, or a byte order mark"]),
    ["a byte order mark", `\ufeff${ciAtBase}`, "cannot be parsed: line 1: a control character, a line break other than LF or CRLF, or a byte order mark"],
    ...[
      ["an expression", "${{ matrix.os }}"], ["a list with self-hosted", "[self-hosted, linux]"],
      ["a block list with self-hosted", "\n      - self-hosted\n      - linux"], ["a runner group", "\n      group: large"],
      ["a larger runner's label", "ubuntu-latest-16-cores"],
    ].map(([kind, value]): [string, string, string] =>
      [`runs-on as ${kind}`, withTop("  lint:\n    name: Lint\n    runs-on: ubuntu-latest\n", `  lint:\n    name: Lint\n    runs-on: ${value}\n`),
        "job lint runs-on is not one GitHub-hosted runner label"]),
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
