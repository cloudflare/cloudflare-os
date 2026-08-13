import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  enforceContributionPolicy,
  getContributionPolicyViolations,
} from "./contribution-policy.js";

const pullRequestTemplate = readFileSync(
  new URL("../.github/pull_request_template.md", import.meta.url),
  "utf8",
);
const contributionPolicyWorkflow = readFileSync(
  new URL("../.github/workflows/contribution-policy.yml", import.meta.url),
  "utf8",
);
const compliantBody = pullRequestTemplate.replaceAll("- [ ]", "- [x]");

function makePullRequest(overrides = {}) {
  return {
    additions: 10,
    author_association: "NONE",
    body: compliantBody,
    deletions: 5,
    draft: false,
    labels: [],
    state: "open",
    user: { login: "external-contributor" },
    ...overrides,
  };
}

describe("getContributionPolicyViolations", () => {
  it("allows an external pull request that meets the automatic checks", () => {
    assert.deepEqual(getContributionPolicyViolations(makePullRequest()), []);
  });

  it("reports every unchecked confirmation", () => {
    const violations = getContributionPolicyViolations(
      makePullRequest({ body: "The marker names alone do not count." }),
    );

    assert.deepEqual(violations, [
      'The "small, concrete change" confirmation is not checked.',
      'The "maintainer assessment" confirmation is not checked.',
      'The "contribution guidelines" confirmation is not checked.',
    ]);
  });

  it("recognizes every confirmation in the pull request template", () => {
    for (const marker of [
      "contribution-policy:concrete-change",
      "contribution-policy:maintainer-assessment",
      "contribution-policy:guidelines",
    ]) {
      assert.equal(pullRequestTemplate.split(marker).length - 1, 1);
    }
    assert.deepEqual(
      getContributionPolicyViolations(
        makePullRequest({ body: pullRequestTemplate }),
      ),
      [
        'The "small, concrete change" confirmation is not checked.',
        'The "maintainer assessment" confirmation is not checked.',
        'The "contribution guidelines" confirmation is not checked.',
      ],
    );
    assert.deepEqual(
      getContributionPolicyViolations(makePullRequest({ body: compliantBody })),
      [],
    );
  });

  it("does not accept a confirmation marker on another line", () => {
    const body = compliantBody.replace(
      "- [x] <!-- contribution-policy:concrete-change -->",
      "- [x]\n<!-- contribution-policy:concrete-change -->",
    );

    assert.deepEqual(getContributionPolicyViolations(makePullRequest({ body })), [
      'The "small, concrete change" confirmation is not checked.',
    ]);
  });

  it("allows exactly 30 changed lines", () => {
    const violations = getContributionPolicyViolations(
      makePullRequest({ additions: 20, deletions: 10 }),
    );

    assert.deepEqual(violations, []);
  });

  it("reports more than 30 changed lines", () => {
    const violations = getContributionPolicyViolations(
      makePullRequest({ additions: 20, deletions: 11 }),
    );

    assert.deepEqual(violations, [
      "The patch changes 31 lines; the automatic limit is 30.",
    ]);
  });

  for (const authorAssociation of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    it(`exempts ${authorAssociation.toLowerCase()} pull requests`, () => {
      const violations = getContributionPolicyViolations(
        makePullRequest({
          additions: 100,
          author_association: authorAssociation,
          body: "",
        }),
      );

      assert.deepEqual(violations, []);
    });
  }

  it("checks draft pull requests", () => {
    const violations = getContributionPolicyViolations(
      makePullRequest({ additions: 31, deletions: 0, draft: true }),
    );

    assert.deepEqual(violations, [
      "The patch changes 31 lines; the automatic limit is 30.",
    ]);
  });

  for (const [description, pullRequest] of [
    ["closed", { state: "closed" }],
    ["merged", { merged: true, state: "closed" }],
  ]) {
    it(`exempts ${description} pull requests`, () => {
      const violations = getContributionPolicyViolations(
        makePullRequest({ additions: 100, body: "", ...pullRequest }),
      );

      assert.deepEqual(violations, []);
    });
  }

  it("exempts Dependabot", () => {
    const violations = getContributionPolicyViolations(
      makePullRequest({
        additions: 100,
        body: "",
        user: { login: "dependabot[bot]" },
      }),
    );

    assert.deepEqual(violations, []);
  });

  it("exempts pull requests with the policy override label", () => {
    const violations = getContributionPolicyViolations(
      makePullRequest({
        additions: 100,
        body: "",
        labels: [{ name: "policy/override" }],
      }),
    );

    assert.deepEqual(violations, []);
  });
});

describe("contribution policy workflow", () => {
  it("runs the enforcement job for draft pull requests", () => {
    assert.doesNotMatch(contributionPolicyWorkflow, /github\.event\.pull_request\.draft/);
  });
});

describe("enforceContributionPolicy", () => {
  it("comments and closes a pull request with policy violations", async () => {
    const calls = [];
    const github = makeGitHub(makePullRequest({ additions: 31 }), [], calls);

    await enforceContributionPolicy({ github, context, core });

    assert.deepEqual(calls.map(({ operation }) => operation), [
      "createComment",
      "closePullRequest",
    ]);
    assert.match(calls[0].body, /patch changes 36 lines/);
  });

  it("updates its existing comment before closing again", async () => {
    const calls = [];
    const comments = [{
      body: "<!-- contribution-policy-automation -->\nOld explanation",
      id: 456,
      user: { login: "github-actions[bot]" },
    }];
    const github = makeGitHub(makePullRequest({ body: "" }), comments, calls);

    await enforceContributionPolicy({ github, context, core });

    assert.deepEqual(calls.map(({ operation }) => operation), [
      "updateComment",
      "closePullRequest",
    ]);
    assert.equal(calls[0].comment_id, 456);
  });

  it("does not trust another author's automation marker", async () => {
    const calls = [];
    const comments = [{
      body: "<!-- contribution-policy-automation -->\nSpoofed explanation",
      id: 789,
      user: { login: "external-contributor" },
    }];
    const github = makeGitHub(makePullRequest({ body: "" }), comments, calls);

    await enforceContributionPolicy({ github, context, core });

    assert.deepEqual(calls.map(({ operation }) => operation), [
      "createComment",
      "closePullRequest",
    ]);
  });

  it("does nothing when the automatic checks pass", async () => {
    const calls = [];
    const github = makeGitHub(makePullRequest(), [], calls);

    await enforceContributionPolicy({ github, context, core });

    assert.deepEqual(calls, []);
  });

  it("does not close a pull request whose contributor-associated author can push", async () => {
    const calls = [];
    const github = makeGitHub(
      makePullRequest({ additions: 100, author_association: "CONTRIBUTOR", body: "" }),
      [],
      calls,
      { authorPermission: "write" },
    );

    await enforceContributionPolicy({ github, context, core });

    assert.deepEqual(calls, []);
  });

  it("still closes a pull request whose contributor-associated author cannot push", async () => {
    const calls = [];
    const github = makeGitHub(
      makePullRequest({ additions: 100, author_association: "CONTRIBUTOR", body: "" }),
      [],
      calls,
    );

    await enforceContributionPolicy({ github, context, core });

    assert.deepEqual(calls.map(({ operation }) => operation), [
      "createComment",
      "closePullRequest",
    ]);
  });

  it("does not close a pull request corrected during evaluation", async () => {
    const calls = [];
    const github = makeGitHub(
      [makePullRequest({ body: "" }), makePullRequest()],
      [],
      calls,
    );

    await enforceContributionPolicy({ github, context, core });

    assert.deepEqual(calls, []);
  });

  it("does not comment on a pull request closed during evaluation", async () => {
    const calls = [];
    const github = makeGitHub(
      [
        makePullRequest({ body: "" }),
        makePullRequest({ body: "", state: "closed" }),
      ],
      [],
      calls,
    );

    await enforceContributionPolicy({ github, context, core });

    assert.deepEqual(calls, []);
  });
});

const context = {
  issue: { number: 123 },
  repo: { owner: "cloudflare", repo: "cloudflare-os" },
};

const core = { notice() {} };

function makeGitHub(pullRequest, comments, calls, { authorPermission = "read" } = {}) {
  const pullRequests = Array.isArray(pullRequest) ? pullRequest : [pullRequest];
  let pullRequestIndex = 0;
  const paginate = async () => comments;
  paginate.iterator = async function* () {
    yield { data: comments };
  };

  return {
    paginate,
    rest: {
      issues: {
        createComment: async (args) => calls.push({ operation: "createComment", ...args }),
        listComments() {},
        updateComment: async (args) => calls.push({ operation: "updateComment", ...args }),
      },
      pulls: {
        get: async () => ({
          data: pullRequests[Math.min(pullRequestIndex++, pullRequests.length - 1)],
        }),
        update: async (args) => calls.push({ operation: "closePullRequest", ...args }),
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { permission: authorPermission },
        }),
      },
    },
  };
}
