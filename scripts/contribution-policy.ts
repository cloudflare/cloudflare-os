// Loaded by .github/workflows/contribution-policy.yml through actions/github-script, whose
// runtime is node24 — so Node strips the types here exactly as it does for the scripts run
// directly. The GitHub API shapes below are written structurally rather than imported: the real
// types live in @octokit/plugin-rest-endpoint-methods, which this repository does not depend on.

/** The pull request fields the automatic checks read. A structural subset of the API response. */
export interface PolicyPullRequest {
  /** `open` or `closed`. Anything but `open` is left alone. */
  state: string;
  /** The author's relationship to the repository; the trusted set is exempt. */
  author_association: string;
  /** The author. */
  user?: { login?: string } | null;
  /** Labels on the pull request; the override label exempts it. */
  labels?: { name: string }[];
  /** The description, where the confirmation checkboxes live. */
  body?: string | null;
  /** Lines added. */
  additions: number;
  /** Lines removed. */
  deletions: number;
}

/** An issue comment, reduced to what {@link findAutomationComment} matches on. */
export interface AutomationComment {
  /** Comment id, used to update it in place. */
  id: number;
  /** Comment author; only this automation's own comments are trusted. */
  user?: { login?: string } | null;
  /** Comment body, searched for the automation marker. */
  body?: string | null;
}

/** Identifies one pull request to the API. */
interface PullRequestRef {
  owner: string;
  repo: string;
  pull_number: number;
}

/** The subset of actions/github-script's authenticated API client this module calls. */
export interface GitHubClient {
  rest: {
    pulls: {
      get(args: PullRequestRef): Promise<{ data: PolicyPullRequest }>;
      update(args: PullRequestRef & { state: string }): Promise<unknown>;
    };
    repos: {
      getCollaboratorPermissionLevel(args: { owner: string; repo: string; username: string }):
          Promise<{ data: { permission: string } }>;
    };
    issues: {
      listComments: unknown;
      createComment(args: { owner: string; repo: string; issue_number: number; body: string }):
          Promise<unknown>;
      updateComment(args: { owner: string; repo: string; comment_id: number; body: string }):
          Promise<unknown>;
    };
  };
  paginate: {
    iterator(route: unknown, args: unknown): AsyncIterable<{ data: AutomationComment[] }>;
  };
}

/** The GitHub Actions event context fields this module reads. */
export interface ActionsContext {
  /** The repository the event fired for. */
  repo: { owner: string; repo: string };
  /** The issue (i.e. pull request) number. */
  issue: { number: number };
}

/** The actions/github-script logging helper, reduced to what this module calls. */
export interface ActionsCore {
  /** Emits an annotation on the workflow run. */
  notice(message: string): void;
}

const AUTOMATION_COMMENT_MARKER = "<!-- contribution-policy-automation -->";
const MAX_CHANGED_LINES = 30;
const MAX_COMMENT_PAGES = 5;
const OVERRIDE_LABEL = "policy/override";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const TRUSTED_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const REQUIRED_CONFIRMATIONS = [
  {
    marker: "contribution-policy:concrete-change",
    violation: 'The "small, concrete change" confirmation is not checked.',
  },
  {
    marker: "contribution-policy:maintainer-assessment",
    violation: 'The "maintainer assessment" confirmation is not checked.',
  },
  {
    marker: "contribution-policy:guidelines",
    violation: 'The "contribution guidelines" confirmation is not checked.',
  },
];

/**
 * Returns the deterministic policy violations that require closing a pull request.
 * An empty result means the automation should take no action, not that maintainers
 * have accepted the change.
 *
 * @param pullRequest GitHub pull request API response.
 * @returns Human-readable policy violations.
 */
export function getContributionPolicyViolations(pullRequest: PolicyPullRequest): string[] {
  if (
    pullRequest.state !== "open" ||
    TRUSTED_ASSOCIATIONS.has(pullRequest.author_association) ||
    pullRequest.user?.login === "dependabot[bot]" ||
    pullRequest.labels?.some((label) => label.name === OVERRIDE_LABEL)
  ) {
    return [];
  }

  const body = pullRequest.body ?? "";
  const violations = REQUIRED_CONFIRMATIONS
    .filter(({ marker }) => !hasCheckedConfirmation(body, marker))
    .map(({ violation }) => violation);
  const changedLines = pullRequest.additions + pullRequest.deletions;

  if (changedLines > MAX_CHANGED_LINES) {
    violations.push(
      `The patch changes ${changedLines} lines; the automatic limit is ${MAX_CHANGED_LINES}.`,
    );
  }

  return violations;
}

/**
 * Enforces the contribution policy using the GitHub API client provided by
 * actions/github-script.
 *
 * @param options GitHub Actions runtime dependencies: the authenticated API client, the event
 *     context, and the logging helper.
 */
export async function enforceContributionPolicy({ github, context, core }: {
  github: GitHubClient;
  context: ActionsContext;
  core: ActionsCore;
}): Promise<void> {
  const { owner, repo } = context.repo;
  const pullNumber = context.issue.number;
  const pullRequestArgs = {
    owner,
    repo,
    pull_number: pullNumber,
  };
  const { data: pullRequest } = await github.rest.pulls.get(pullRequestArgs);
  let violations = getContributionPolicyViolations(pullRequest);

  if (violations.length === 0) return;

  const username = pullRequest.user?.login;
  if (username) {
    const { data: permission } = await github.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });
    if (TRUSTED_PERMISSIONS.has(permission.permission)) return;
  }

  const existingComment = await findAutomationComment(github, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  const { data: latestPullRequest } = await github.rest.pulls.get(pullRequestArgs);
  violations = getContributionPolicyViolations(latestPullRequest);

  if (violations.length === 0) return;

  const body = formatAutomationComment(violations);

  if (existingComment) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body,
    });
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
  }

  await github.rest.pulls.update({
    owner,
    repo,
    pull_number: pullNumber,
    state: "closed",
  });
  core.notice(`Closed pull request #${pullNumber} for contribution policy violations.`);
}

function hasCheckedConfirmation(body: string, marker: string): boolean {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^[ \\t]*-[ \\t]*\\[[xX]\\][ \\t]*<!--[ \\t]*${escapedMarker}[ \\t]*-->`,
    "m",
  ).test(body);
}

async function findAutomationComment(
  github: GitHubClient,
  args: { owner: string; repo: string; issue_number: number; per_page: number },
): Promise<AutomationComment | undefined> {
  let pageCount = 0;

  for await (const { data: comments } of github.paginate.iterator(
    github.rest.issues.listComments,
    args,
  )) {
    const comment = comments.find(
      (candidate) =>
        candidate.user?.login === "github-actions[bot]" &&
        candidate.body?.includes(AUTOMATION_COMMENT_MARKER),
    );
    if (comment) return comment;
    if (++pageCount >= MAX_COMMENT_PAGES) break;
  }

  return undefined;
}

function formatAutomationComment(violations: string[]): string {
  const details = violations.map((violation) => `- ${violation}`).join("\n");

  return `${AUTOMATION_COMMENT_MARKER}
Thank you for taking the time to contribute. This pull request was automatically closed because:

${details}

Please update the pull request to meet these automatic checks, then reopen it. Passing these checks does not guarantee acceptance; maintainers still determine whether a change is obviously correct and trivially verifiable.

If an exception is appropriate, a maintainer can apply the \`${OVERRIDE_LABEL}\` label before reopening the pull request. See the [contribution guidelines](https://github.com/cloudflare/cloudflare-os/blob/main/CONTRIBUTING.md) for details.`;
}
