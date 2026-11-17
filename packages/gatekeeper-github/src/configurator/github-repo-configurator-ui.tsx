import { Autocomplete, Field, h, RadioCards, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubRepoConfiguratorRpc, GitHubRepoConfiguratorValues } from "./github-repo-configurator-types";

const DEFAULT_BRANCH_PREFIX = "cloudflare-os/";

/** A prefix the gatekeeper accepts: a branch namespace ending with `/` (it re-validates fully). */
function isBranchPrefix(prefix: string | null | undefined): prefix is string {
  return typeof prefix === "string" && prefix.length >= 2 && prefix.length <= 100 && prefix.endsWith("/") &&
    !/[\s~^:?*[\\]|\.\.|\/\/|^\/|^\./.test(prefix);
}

/** The contributor scope a resource URL's query carries, the configurator's own reading of it. */
function accessFromUrl(url: URL): Pick<GitHubRepoConfiguratorValues, "access" | "branchPrefix" | "allowPublic"> {
  const branchPrefix = url.searchParams.get("branchPrefix");
  if (branchPrefix === null) return {};
  return { access: "contributor", branchPrefix, allowPublic: url.searchParams.get("allowPublic") === "true" ? "true" : "false" };
}

export default {
  initial: {},

  isReady({ values }) {
    if (typeof values.repoFullName !== "string" || values.repoFullName.length === 0) return false;
    return values.access !== "contributor" || isBranchPrefix(values.branchPrefix ?? DEFAULT_BRANCH_PREFIX);
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const url = new URL(resourceUrl);
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    return owner && repo ? { repoFullName: `${owner}/${repo}`, ...accessFromUrl(url) } : {};
  },

  resourceUrl({ values }) {
    const url = `https://github.com/${values.repoFullName}`;
    if (values.access !== "contributor") return url;
    // The gatekeeper's canonical form: branchPrefix first, then allowPublic only when true.
    const query = new URLSearchParams({ branchPrefix: values.branchPrefix ?? DEFAULT_BRANCH_PREFIX });
    if (values.allowPublic === "true") query.set("allowPublic", "true");
    return `${url}?${query.toString()}`;
  },

  render({ values, setValues, ui }) {
    const contributor = values.access === "contributor";
    const prefix = values.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
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
      <Field label="Access">
        <RadioCards
          value={values.access ?? "full"}
          options={[
            { value: "full", title: "Full repository", description: "Issues, pull requests, reviews, merges, and pushes to any branch." },
            { value: "contributor", title: "Pull requests only",
              description: "Read the code, push to branches under a prefix, and open pull requests into the default branch. Cannot merge or approve." },
          ]}
          onChange={access => setValues({ access: access === "contributor" ? "contributor" : "full" })}
        />
      </Field>
      {contributor && <Field label="Branch prefix" description={isBranchPrefix(prefix)
          ? `Pushes are limited to branches whose names start with "${prefix}".`
          : "Must end with \"/\", e.g. \"cloudflare-os/\"."}>
        <TextInput
          name="branchPrefix"
          value={prefix}
          placeholder={DEFAULT_BRANCH_PREFIX}
          onChange={branchPrefix => setValues({ branchPrefix })}
        />
      </Field>}
      {contributor && <Field label="Public repositories">
        <RadioCards
          value={values.allowPublic ?? "false"}
          options={[
            { value: "false", title: "Refuse writes", description: "Nothing is pushed while the repository is public." },
            { value: "true", title: "Allow writes",
              description: "Pushed commits and pull requests are visible to anyone. Only choose this if every change will be reviewed for sensitive data." },
          ]}
          onChange={allowPublic => setValues({ allowPublic: allowPublic === "true" ? "true" : "false" })}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubRepoConfiguratorRpc, GitHubRepoConfiguratorValues>;
