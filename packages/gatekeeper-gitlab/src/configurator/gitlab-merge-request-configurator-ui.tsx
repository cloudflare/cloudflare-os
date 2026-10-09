import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitLabMergeRequestConfiguratorRpc, GitLabMergeRequestConfiguratorValues } from "./gitlab-merge-request-configurator-types";

function parseMergeRequestUrl(resourceUrl: string, resourceUrlPattern: string): { projectPath: string; mergeRequestIid: string | null } | null {
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
    const match = marker === -1 ? null : /^merge_requests\/(\d+)(?:\/|$)/.exec(path.slice(marker + 3));
    return { projectPath, mergeRequestIid: match ? match[1] : null };
  } catch {
    return null;
  }
}

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.projectPath === "string" && values.projectPath.length > 0 &&
      typeof values.mergeRequestIid === "string" && values.mergeRequestIid.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl, resourceUrlPattern }) {
    const parsed = parseMergeRequestUrl(resourceUrl, resourceUrlPattern);
    return parsed ?? {};
  },

  async resourceUrl({ values, ui }) {
    return `${await ui.instanceUrl()}/${values.projectPath}/-/merge_requests/${values.mergeRequestIid}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Project" description="Search your projects, or enter a GitLab project URL or path.">
        <Autocomplete
          name="projectPath"
          value={values.projectPath}
          placeholder="Search or paste a project URL..."
          loadOptions={query => ui.listProjects(query)}
          onChange={projectPath => setValues({ projectPath, mergeRequestIid: null })}
        />
      </Field>

      <Field label="Merge request" description="Choose a merge request in the selected project.">
        <Autocomplete
          name="mergeRequestIid"
          value={values.mergeRequestIid}
          placeholder={values.projectPath ? "Search merge requests..." : "Choose a project first"}
          disabled={!values.projectPath}
          loadOptions={query => ui.listMergeRequests(values.projectPath, query)}
          onChange={mergeRequestIid => setValues({ mergeRequestIid })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitLabMergeRequestConfiguratorRpc, GitLabMergeRequestConfiguratorValues>;
