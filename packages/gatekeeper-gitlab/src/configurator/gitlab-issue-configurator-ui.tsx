import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitLabIssueConfiguratorRpc, GitLabIssueConfiguratorValues } from "./gitlab-issue-configurator-types";

function parseIssueUrl(resourceUrl: string, resourceUrlPattern: string): { projectPath: string; issueIid: string | null } | null {
  try {
    const url = new URL(resourceUrl);
    if (url.origin !== new URL(resourceUrlPattern).origin) return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    const marker = path.indexOf("/-/");
    const projectPath = (marker === -1 ? path : path.slice(0, marker)).replace(/\.git$/, "");
    const segments = projectPath.split("/").filter(Boolean);
    if (segments.length < 2 || segments.includes("-")) return null;
    // A malformed item number is refused rather than read as the project, as the server-side
    // parser does; `7x` is not merge request 7.
    const item = marker === -1 ? null : /^(?:issues|merge_requests)\/([^/]+)/.exec(path.slice(marker + 3));
    if (item && !/^\d+$/.test(item[1])) return null;
    const match = marker === -1 ? null : /^issues\/(\d+)(?:\/|$)/.exec(path.slice(marker + 3));
    return { projectPath, issueIid: match ? match[1] : null };
  } catch {
    return null;
  }
}

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.projectPath === "string" && values.projectPath.length > 0 &&
      typeof values.issueIid === "string" && values.issueIid.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl, resourceUrlPattern }) {
    const parsed = parseIssueUrl(resourceUrl, resourceUrlPattern);
    return parsed ?? {};
  },

  async resourceUrl({ values, ui }) {
    return `${await ui.instanceUrl()}/${values.projectPath}/-/issues/${values.issueIid}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Project" description="Search your projects, or enter a GitLab project URL or path.">
        <Autocomplete
          name="projectPath"
          value={values.projectPath}
          placeholder="Search or paste a project URL..."
          loadOptions={query => ui.listProjects(query)}
          onChange={projectPath => setValues({ projectPath, issueIid: null })}
        />
      </Field>

      <Field label="Issue" description="Choose an issue in the selected project.">
        <Autocomplete
          name="issueIid"
          value={values.issueIid}
          placeholder={values.projectPath ? "Search issues..." : "Choose a project first"}
          disabled={!values.projectPath}
          loadOptions={query => ui.listIssues(values.projectPath, query)}
          onChange={issueIid => setValues({ issueIid })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitLabIssueConfiguratorRpc, GitLabIssueConfiguratorValues>;
