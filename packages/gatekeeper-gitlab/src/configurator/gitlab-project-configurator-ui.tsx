import { Autocomplete, Field, h, RadioCards, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
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

const DEFAULT_BRANCH_PREFIX = "cloudflare-os/";

/** A prefix the gatekeeper accepts: a branch namespace ending with `/` (it re-validates fully). */
function isBranchPrefix(prefix: string | null | undefined): prefix is string {
  return typeof prefix === "string" && prefix.length >= 2 && prefix.length <= 100 && prefix.endsWith("/") &&
    !/[\s~^:?*[\\]|\.\.|\/\/|^\/|^\./.test(prefix);
}

/** The contributor scope a resource URL's query carries, the configurator's own reading of it. */
function accessFromUrl(resourceUrl: string): Pick<GitLabProjectConfiguratorValues, "access" | "branchPrefix" | "allowPublic"> {
  try {
    const search = new URL(resourceUrl).searchParams;
    const branchPrefix = search.get("branchPrefix");
    if (branchPrefix === null) return {};
    return { access: "contributor", branchPrefix, allowPublic: search.get("allowPublic") === "true" ? "true" : "false" };
  } catch {
    return {};
  }
}

export default {
  initial: {},

  isReady({ values }) {
    if (typeof values.projectPath !== "string" || values.projectPath.length === 0) return false;
    return values.access !== "contributor" || isBranchPrefix(values.branchPrefix ?? DEFAULT_BRANCH_PREFIX);
  },

  initialValuesFromResourceUrl({ resourceUrl, resourceUrlPattern }) {
    const projectPath = projectPathFromUrl(resourceUrl, resourceUrlPattern);
    return projectPath ? { projectPath, ...accessFromUrl(resourceUrl) } : {};
  },

  async resourceUrl({ values, ui }) {
    const url = `${await ui.instanceUrl()}/${values.projectPath}`;
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
      <Field label="Project" description="Search your projects, or enter a GitLab project URL or path.">
        <Autocomplete
          name="projectPath"
          value={values.projectPath}
          placeholder="Search or paste a project URL..."
          loadOptions={query => ui.listProjects(query)}
          onChange={projectPath => setValues({ projectPath })}
        />
      </Field>
      <Field label="Access">
        <RadioCards
          value={values.access ?? "full"}
          options={[
            { value: "full", title: "Full project", description: "Issues, merge requests, reviews, merges, and pushes to any branch." },
            { value: "contributor", title: "Merge requests only",
              description: "Read the code, push to branches under a prefix, and open merge requests into the default branch. Cannot merge or approve." },
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
      {contributor && <Field label="Public projects">
        <RadioCards
          value={values.allowPublic ?? "false"}
          options={[
            { value: "false", title: "Refuse writes", description: "Nothing is pushed while the project is public." },
            { value: "true", title: "Allow writes",
              description: "Pushed commits and merge requests are visible to anyone. Only choose this if every change will be reviewed for sensitive data." },
          ]}
          onChange={allowPublic => setValues({ allowPublic: allowPublic === "true" ? "true" : "false" })}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitLabProjectConfiguratorRpc, GitLabProjectConfiguratorValues>;
