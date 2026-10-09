import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitLabProjectConfiguratorRpc, GitLabProjectConfiguratorValues } from "./gitlab-project-configurator-types";

// The instance origin comes from the resource URL pattern (`https://<instance>/:project+`), so
// pre-filling needs no RPC; `resourceUrl()` asks the gatekeeper, which knows the deployment's
// configured instance.
function projectPathFromUrl(resourceUrl: string, resourceUrlPattern: string): string | null {
  try {
    const url = new URL(resourceUrl);
    if (url.origin !== new URL(resourceUrlPattern).origin) return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    const marker = path.indexOf("/-/");
    const projectPath = (marker === -1 ? path : path.slice(0, marker)).replace(/\.git$/, "");
    const segments = projectPath.split("/").filter(Boolean);
    if (segments.length < 2 || segments.includes("-")) return null;
    // An issue or merge request route must name its item well (`/-/issues/42`); a malformed one
    // is refused rather than read as the project, as the server-side parser does.
    const item = marker === -1 ? null : /^(?:issues|merge_requests)\/([^/]+)/.exec(path.slice(marker + 3));
    if (item && !/^\d+$/.test(item[1])) return null;
    return projectPath;
  } catch {
    return null;
  }
}

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.projectPath === "string" && values.projectPath.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl, resourceUrlPattern }) {
    const projectPath = projectPathFromUrl(resourceUrl, resourceUrlPattern);
    return projectPath ? { projectPath } : {};
  },

  async resourceUrl({ values, ui }) {
    return `${await ui.instanceUrl()}/${values.projectPath}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Project" description="Search your projects, or enter a GitLab project URL or path.">
        <Autocomplete
          name="projectPath"
          value={values.projectPath}
          placeholder="Search or paste a project URL..."
          loadOptions={query => ui.listProjects(query)}
          onChange={projectPath => setValues({ projectPath })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitLabProjectConfiguratorRpc, GitLabProjectConfiguratorValues>;
