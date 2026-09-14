import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  GitLabApi,
  type GitLabIssueResponse,
  type GitLabMergeRequestResponse,
  type GitLabProjectResponse,
} from "./gitlab-api";
import { parseResourceUrl } from "./gitlab-normalize";
import type { GitLabIssueConfiguratorRpc } from "./configurator/gitlab-issue-configurator-types";
import type { GitLabMergeRequestConfiguratorRpc } from "./configurator/gitlab-merge-request-configurator-types";
import type { GitLabProjectConfiguratorRpc } from "./configurator/gitlab-project-configurator-types";

type ConfiguratorOption = { value: string; title: string; subtitle?: string; meta?: string };

const AUTOCOMPLETE_OPTION_LIMIT = 100;
// A full project path: two or more segments of GitLab's namespace/project character set.
const PROJECT_PATH_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)+$/;

/** What every configurator capability needs: where the instance is and how to call it. */
export type ConfiguratorContext = {
  instanceUrl: string;
  api: GitLabApi;
};

const contexts = new WeakMap<object, ConfiguratorContext>();

function contextOf(target: object): ConfiguratorContext {
  const context = contexts.get(target);
  if (!context) throw new Error("GitLab configurator is not initialized.");
  return context;
}

function projectToOption(project: GitLabProjectResponse): ConfiguratorOption {
  return {
    value: project.path_with_namespace,
    title: project.path_with_namespace,
    subtitle: project.description ?? undefined,
    meta: project.visibility,
  };
}

/**
 * A query that names one project exactly: a full path (`group/sub/project`) or an instance URL.
 * Returns null for anything that reads as a search term.
 */
function exactProjectPath(instanceUrl: string, input: string): string | null {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return parseResourceUrl(instanceUrl, trimmed)?.projectPath ?? null;
  }
  const path = trimmed.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return PROJECT_PATH_PATTERN.test(path) ? path : null;
}

function iidFromQuery(query: string): number | null {
  const match = query.trim().match(/^[#!]?(\d+)$/);
  return match ? Number(match[1]) : null;
}

function issueOption(issue: GitLabIssueResponse): ConfiguratorOption {
  return {
    value: String(issue.iid),
    title: `#${issue.iid} ${issue.title}`,
    subtitle: issue.author ? `Opened by ${issue.author.username}` : undefined,
    meta: issue.state,
  };
}

function mergeRequestOption(mr: GitLabMergeRequestResponse): ConfiguratorOption {
  return {
    value: String(mr.iid),
    title: `!${mr.iid} ${mr.title}`,
    subtitle: `${mr.source_branch} -> ${mr.target_branch}`,
    meta: mr.draft ? `${mr.state} draft` : mr.state,
  };
}

// Capability exposed to the configurator iframe.
@validateRpc()
export class GitLabProjectConfiguratorUI extends RpcTarget implements GitLabProjectConfiguratorRpc {
  constructor(context: ConfiguratorContext) {
    super();
    contexts.set(this, context);
  }

  async instanceUrl(): Promise<string> {
    return contextOf(this).instanceUrl;
  }

  async listProjects(query: string): Promise<ConfiguratorOption[]> {
    const { instanceUrl, api } = contextOf(this);
    const trimmedQuery = query.trim();
    const exactPath = exactProjectPath(instanceUrl, trimmedQuery);

    // Membership listing, most recently active first; `search` narrows it server-side and
    // `search_namespaces` lets a group name in the query match too.
    const projects = await api.listMemberProjects({
      search: exactPath ?? (trimmedQuery || undefined),
      perPage: AUTOCOMPLETE_OPTION_LIMIT,
      page: 1,
    });
    const options = projects.map(projectToOption);

    // Fall back to a direct lookup for an exact path or URL the membership search didn't return
    // (a public or internal project the user is not a member of).
    if (exactPath && !options.some(option => option.value.toLowerCase() === exactPath.toLowerCase())) {
      try {
        options.unshift(projectToOption(await api.getProject(exactPath)));
      } catch {
        // Ignore exact lookup failures; the dropdown will show search matches or "No matches".
      }
    }

    return options.slice(0, AUTOCOMPLETE_OPTION_LIMIT);
  }
}

@validateRpc()
export class GitLabIssueConfiguratorUI extends GitLabProjectConfiguratorUI implements GitLabIssueConfiguratorRpc {
  async listIssues(projectPath: string | null | undefined, query: string): Promise<ConfiguratorOption[]> {
    if (!projectPath) return [];
    const { instanceUrl, api } = contextOf(this);
    const path = exactProjectPath(instanceUrl, projectPath);
    if (!path) return [];
    const trimmedQuery = query.trim();

    const issues = await api.listIssues(path, {
      state: "all",
      search: trimmedQuery || undefined,
      orderBy: "updated_at",
      sort: "desc",
      perPage: AUTOCOMPLETE_OPTION_LIMIT,
      page: 1,
    });
    // Searched server-side, so nothing to re-filter here.
    const options = issues.map(issueOption);

    const iid = iidFromQuery(query);
    if (iid && !options.some(option => option.value === String(iid))) {
      try {
        options.unshift(issueOption(await api.getIssue(path, iid)));
      } catch {}
    }

    return options.slice(0, AUTOCOMPLETE_OPTION_LIMIT);
  }
}

@validateRpc()
export class GitLabMergeRequestConfiguratorUI extends GitLabProjectConfiguratorUI implements GitLabMergeRequestConfiguratorRpc {
  async listMergeRequests(projectPath: string | null | undefined, query: string): Promise<ConfiguratorOption[]> {
    if (!projectPath) return [];
    const { instanceUrl, api } = contextOf(this);
    const path = exactProjectPath(instanceUrl, projectPath);
    if (!path) return [];
    const trimmedQuery = query.trim();

    const mergeRequests = await api.listMergeRequests(path, {
      state: "all",
      search: trimmedQuery || undefined,
      orderBy: "updated_at",
      sort: "desc",
      perPage: AUTOCOMPLETE_OPTION_LIMIT,
      page: 1,
    });
    const options = mergeRequests.map(mergeRequestOption);

    const iid = iidFromQuery(query);
    if (iid && !options.some(option => option.value === String(iid))) {
      try {
        options.unshift(mergeRequestOption(await api.getMergeRequest(path, iid)));
      } catch {}
    }

    return options.slice(0, AUTOCOMPLETE_OPTION_LIMIT);
  }
}
