import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubRepoConfiguratorRpc, GitHubRepoConfiguratorValues } from "./github-repo-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.repoFullName === "string" && values.repoFullName.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [owner, repo] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    return owner && repo ? { repoFullName: `${owner}/${repo}` } : {};
  },

  async resourceUrl({ values, ui }) {
    return `${await ui.instanceUrl()}/${values.repoFullName}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Repository" description="Search your repositories, or enter a GitHub URL.">
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder="Search or paste a repository URL..."
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubRepoConfiguratorRpc, GitHubRepoConfiguratorValues>;
