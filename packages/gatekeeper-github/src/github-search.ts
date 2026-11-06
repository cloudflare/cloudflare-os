import type { GitHubIssueResponse } from "./github-api";
import type { GitHubIssueSearch } from "./types";

export function buildIssueSearchQuery(owner: string, repo: string, query: GitHubIssueSearch): string {
  const parts = [query.text ? JSON.stringify(query.text) : "", `repo:${owner}/${repo}`, "is:issue"];
  if (query.state && query.state !== "all") parts.push(`state:${query.state}`);
  for (const label of query.labels ?? []) {
    parts.push(`label:${JSON.stringify(label)}`);
  }
  if (query.author) parts.push(`author:${JSON.stringify(query.author)}`);
  if (query.assignee) parts.push(`assignee:${JSON.stringify(query.assignee)}`);
  return parts.filter(Boolean).join(" ");
}

export function assertIssueSearchResultsInRepo(
  owner: string,
  repo: string,
  results: readonly Pick<GitHubIssueResponse, "html_url">[],
  origin = "https://github.com",
): void {
  const expectedOwner = owner.toLowerCase();
  const expectedRepo = repo.toLowerCase();

  for (const result of results) {
    let url: URL | undefined;
    try {
      url = new URL(result.html_url);
    } catch {
      // Handled by the scope check below.
    }

    const [resultOwner, resultRepo, resultKind] = url?.pathname.split("/").filter(Boolean) ?? [];
    if (url?.origin !== origin
        || resultOwner?.toLowerCase() !== expectedOwner || resultRepo?.toLowerCase() !== expectedRepo) {
      throw new Error("GitHub returned an issue outside the connected repository.");
    }
    if (resultKind !== "issues") {
      throw new Error("GitHub returned a non-issue result for an issue search.");
    }
  }
}
