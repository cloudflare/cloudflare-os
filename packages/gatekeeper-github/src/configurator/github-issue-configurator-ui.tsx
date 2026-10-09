import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubIssueConfiguratorRpc, GitHubIssueConfiguratorValues } from "./github-issue-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.repoFullName === "string" && values.repoFullName.length > 0 &&
      typeof values.issueNumber === "string" && /^\d+$/.test(values.issueNumber);
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [owner, repo, , number] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    if (!owner || !repo) return {};
    return { repoFullName: `${owner}/${repo}`, issueNumber: number ?? null };
  },

  resourceUrl({ values }) {
    return `https://github.com/${values.repoFullName}/issues/${values.issueNumber}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Repository" description="Search your repositories, or enter a GitHub URL.">
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder="Search or paste a repository URL..."
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName, issueNumber: null })}
        />
      </Field>

      <Field label="Issue" description="Choose an issue in the selected repository.">
        <Autocomplete
          name="issueNumber"
          value={values.issueNumber}
          placeholder={values.repoFullName ? "Search issues..." : "Choose a repository first"}
          disabled={!values.repoFullName}
          loadOptions={query => ui.listIssues(values.repoFullName, query)}
          onChange={issueNumber => setValues({ issueNumber })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubIssueConfiguratorRpc, GitHubIssueConfiguratorValues>;
