import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubPullRequestConfiguratorRpc, GitHubPullRequestConfiguratorValues } from "./github-pull-request-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.repoFullName === "string" && values.repoFullName.length > 0 &&
      typeof values.pullNumber === "string" && /^\d+$/.test(values.pullNumber);
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [owner, repo, , number] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    if (!owner || !repo) return {};
    return { repoFullName: `${owner}/${repo}`, pullNumber: number ?? null };
  },

  resourceUrl({ values }) {
    return `https://github.com/${values.repoFullName}/pull/${values.pullNumber}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Repository" description="Search your repositories, or enter a GitHub URL.">
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder="Search or paste a repository URL..."
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName, pullNumber: null })}
        />
      </Field>

      <Field label="Pull Request" description="Choose a pull request in the selected repository.">
        <Autocomplete
          name="pullNumber"
          value={values.pullNumber}
          placeholder={values.repoFullName ? "Search pull requests..." : "Choose a repository first"}
          disabled={!values.repoFullName}
          loadOptions={query => ui.listPullRequests(values.repoFullName, query)}
          onChange={pullNumber => setValues({ pullNumber })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubPullRequestConfiguratorRpc, GitHubPullRequestConfiguratorValues>;
