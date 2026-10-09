import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  GitHubApi,
  type GitHubIssueResponse,
  type GitHubPullRequestResponse,
  type GitHubRepoResponse,
} from "./github-api";
import type { GitHubIssueConfiguratorRpc } from "./configurator/github-issue-configurator-types";
import type { GitHubPullRequestConfiguratorRpc } from "./configurator/github-pull-request-configurator-types";
import type { GitHubRepoConfiguratorRpc } from "./configurator/github-repo-configurator-types";

type ConfiguratorOption = { value: string; title: string; subtitle?: string; meta?: string };

const AUTOCOMPLETE_OPTION_LIMIT = 100;
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Runs `fn` against GitHub as the configuring account; `fn` may run twice, so it must only read. */
export type GitHubApiRunner = <T>(fn: (api: GitHubApi) => Promise<T>) => Promise<T>;

const githubRunners = new WeakMap<object, GitHubApiRunner>();
// Per-instance cache of the authenticated user's login. Used to scope `searchRepos` to repos
// the user can access. Fetched lazily on first need and reused for the configurator's lifetime.
const githubViewerLogins = new WeakMap<object, Promise<string>>();

function withGitHub<T>(target: object, fn: (api: GitHubApi) => Promise<T>): Promise<T> {
  const run = githubRunners.get(target);
  if (!run) throw new Error("GitHub configurator is not initialized.");
  return run(fn);
}

function viewerLogin(target: object): Promise<string> {
  const cached = githubViewerLogins.get(target);
  if (cached) return cached;
  const pending = withGitHub(target, api => api.getViewerConditional())
    .then(result => {
      if (result.status === 304) throw new Error("GitHub unexpectedly returned 304 for viewer lookup.");
      return result.data.login;
    });
  githubViewerLogins.set(target, pending);
  pending.catch(() => githubViewerLogins.delete(target));
  return pending;
}

function repoToOption(repo: GitHubRepoResponse): ConfiguratorOption {
  return {
    value: repo.full_name,
    title: repo.full_name,
    subtitle: repo.description ?? undefined,
    meta: repo.visibility ?? (repo.private ? "private" : "public"),
  };
}

function splitRepoFullName(input: string): { owner: string; repo: string } | null {
  let fullName = input.trim();

  if (/^https?:\/\//i.test(fullName)) {
    try {
      const url = new URL(fullName);
      if (url.hostname.toLowerCase() !== "github.com") return null;
      fullName = url.pathname.replace(/^\/+|\/+$/g, "");
    } catch {
      return null;
    }
  }

  const [owner, rawRepo, ...rest] = fullName.split("/");
  if (!owner || !rawRepo || rest.length > 0) return null;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo)) return null;
  return { owner, repo };
}

function optionMatches(parts: (string | undefined | null)[], query: string): boolean {
  const lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) return true;
  const corpus = parts.filter(Boolean).join(" ").toLowerCase();
  return lowerQuery.split(/\s+/).every(term => corpus.includes(term));
}

function issueNumberFromQuery(query: string): number | null {
  const match = query.trim().match(/^#?(\d+)$/);
  return match ? Number(match[1]) : null;
}

function issueMeta(issue: GitHubIssueResponse): string {
  return issue.state;
}

function pullRequestMeta(pullRequest: GitHubPullRequestResponse): string {
  if (pullRequest.draft) return `${pullRequest.state} draft`;
  return pullRequest.merged_at ? "merged" : pullRequest.state;
}

function issueOption(issue: GitHubIssueResponse) {
  return {
    value: String(issue.number),
    title: `#${issue.number} ${issue.title}`,
    subtitle: issue.user ? `Opened by ${issue.user.login}` : undefined,
    meta: issueMeta(issue),
  };
}

function pullRequestOption(pullRequest: GitHubPullRequestResponse) {
  return {
    value: String(pullRequest.number),
    title: `#${pullRequest.number} ${pullRequest.title}`,
    subtitle: `${pullRequest.head.ref} -> ${pullRequest.base.ref}`,
    meta: pullRequestMeta(pullRequest),
  };
}

function pullRequestSearchOption(pullRequest: GitHubIssueResponse) {
  return {
    value: String(pullRequest.number),
    title: `#${pullRequest.number} ${pullRequest.title}`,
    subtitle: pullRequest.user ? `Opened by ${pullRequest.user.login}` : undefined,
    meta: pullRequest.state,
  };
}

// Capability exposed to the configurator iframe.
@validateRpc()
export class GitHubRepoConfiguratorUI extends RpcTarget implements GitHubRepoConfiguratorRpc {
  constructor(run: GitHubApiRunner) {
    super();
    githubRunners.set(this, run);
  }

  async listRepos(query: string): Promise<ConfiguratorOption[]> {
    const trimmedQuery = query.trim();

    // No query: show the user's most-recently-updated accessible repos from /user/repos.
    if (!trimmedQuery) {
      const repos = await withGitHub(this, api => api.listRepos({
        affiliation: "owner,collaborator,organization_member",
        sort: "updated",
        direction: "desc",
        per_page: AUTOCOMPLETE_OPTION_LIMIT,
        page: 1,
      }));
      return repos.map(repoToOption);
    }

    // Query: hit GitHub's /search/repositories scoped to the authenticated user.
    const exactRepo = splitRepoFullName(trimmedQuery);
    const normalizedQuery = exactRepo ? `${exactRepo.owner}/${exactRepo.repo}` : trimmedQuery;
    const login = await viewerLogin(this);
    const repos = await withGitHub(this, api => api.searchRepos({
      q: `${normalizedQuery} user:${login} fork:true`,
      per_page: AUTOCOMPLETE_OPTION_LIMIT,
      page: 1,
      sort: "updated",
      order: "desc",
    }));
    const matches = repos.map(repoToOption);

    // Fall back to a direct lookup for exact names or URLs that scoped search didn't return.
    if (exactRepo && !matches.some(option => option.value.toLowerCase() === normalizedQuery.toLowerCase())) {
      try {
        const repo = await withGitHub(this, api => api.getRepo(exactRepo.owner, exactRepo.repo));
        matches.unshift(repoToOption(repo));
      } catch {
        // Ignore exact lookup failures; the dropdown will show search matches or "No matches".
      }
    }

    return matches.slice(0, AUTOCOMPLETE_OPTION_LIMIT);
  }

}

@validateRpc()
export class GitHubIssueConfiguratorUI extends GitHubRepoConfiguratorUI implements GitHubIssueConfiguratorRpc {
  async listIssues(repoFullName: string | null | undefined, query: string): Promise<ConfiguratorOption[]> {
    if (!repoFullName) return [];

    const parsed = splitRepoFullName(repoFullName);
    if (!parsed) return [];
    const trimmedQuery = query.trim();

    const issues = trimmedQuery
      ? await withGitHub(this, api => api.searchIssues(
          `${trimmedQuery} repo:${parsed.owner}/${parsed.repo} is:issue`,
          1,
          100,
          "updated",
          "desc",
        ))
      : await withGitHub(this, api => api.listIssues(parsed.owner, parsed.repo, {
          state: "all",
          sort: "updated",
          direction: "desc",
          per_page: 100,
          page: 1,
        }));

    const options = issues
      .filter(issue => !issue.pull_request)
      .filter(issue => trimmedQuery || optionMatches([String(issue.number), issue.title, issue.user?.login, issue.state], query))
      .slice(0, 100)
      .map(issueOption);

    const issueNumber = issueNumberFromQuery(query);
    if (issueNumber && !options.some(option => option.value === String(issueNumber))) {
      try {
        const issue = await withGitHub(this, api => api.getIssue(parsed.owner, parsed.repo, issueNumber));
        if (!issue.pull_request) options.unshift(issueOption(issue));
      } catch {}
    }

    return options.slice(0, 100);
  }

}

@validateRpc()
export class GitHubPullRequestConfiguratorUI extends GitHubRepoConfiguratorUI implements GitHubPullRequestConfiguratorRpc {
  async listPullRequests(repoFullName: string | null | undefined, query: string): Promise<ConfiguratorOption[]> {
    if (!repoFullName) return [];

    const parsed = splitRepoFullName(repoFullName);
    if (!parsed) return [];
    const trimmedQuery = query.trim();

    if (trimmedQuery) {
      const pullRequests = await withGitHub(this, api => api.searchIssues(
        `${trimmedQuery} repo:${parsed.owner}/${parsed.repo} is:pr`,
        1,
        100,
        "updated",
        "desc",
      ));
      const options: ConfiguratorOption[] = pullRequests
        .slice(0, 100)
        .map(pullRequestSearchOption);

      const pullNumber = issueNumberFromQuery(query);
      if (pullNumber && !options.some(option => option.value === String(pullNumber))) {
        try {
          options.unshift(pullRequestOption(
            await withGitHub(this, api => api.getPullRequest(parsed.owner, parsed.repo, pullNumber))));
        } catch {}
      }

      return options.slice(0, 100);
    }

    const pullRequests = await withGitHub(this, api => api.listPullRequests(parsed.owner, parsed.repo, {
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: 100,
      page: 1,
    }));

    const options = pullRequests
      .filter(pullRequest => optionMatches([
        String(pullRequest.number),
        pullRequest.title,
        pullRequest.user?.login,
        pullRequest.state,
        pullRequest.head.ref,
        pullRequest.base.ref,
      ], query))
      .slice(0, 100)
      .map(pullRequestOption);

    const pullNumber = issueNumberFromQuery(query);
    if (pullNumber && !options.some(option => option.value === String(pullNumber))) {
      try {
        options.unshift(pullRequestOption(
          await withGitHub(this, api => api.getPullRequest(parsed.owner, parsed.repo, pullNumber))));
      } catch {}
    }

    return options.slice(0, 100);
  }

}
