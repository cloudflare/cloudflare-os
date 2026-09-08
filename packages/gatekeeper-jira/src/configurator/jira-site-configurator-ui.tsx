import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { JiraConfiguratorRpc, JiraConfiguratorValues } from "./jira-configurator-types";

export default {
  initial: { defaultProjectLoadState: "idle" },
  isReady: ({ values }) => typeof values.siteUrl === "string" && values.siteUrl.length > 0,
  initialValuesFromResourceUrl: ({ resourceUrl }) => ({ siteUrl: resourceUrl }),
  async resourceUrl({ values, ui }) {
    if (values.defaultProjectDirty === "true") await ui.setDefaultProject(values.defaultProjectUrl ?? null);
    return values.siteUrl ?? "";
  },
  render({ values, setValues, ui }) {
    if (!values.defaultProjectLoadState || values.defaultProjectLoadState === "idle") {
      setValues({ defaultProjectLoadState: "pending" });
      void ui.getDefaultProject().then(project => setValues({ defaultProjectLoadState: "loaded", defaultProjectUrl: project?.value ?? null })).catch(() => setValues({ defaultProjectLoadState: "failed" }));
    }
    const loadingDefault = values.defaultProjectLoadState === "idle" || values.defaultProjectLoadState === "pending";
    const description = values.defaultProjectLoadState === "failed" ? "Optional. Could not load the current default, so no default change will be saved unless you choose one now." : "Optional. Used to prefill project pickers and as the Jira create-issue project when no explicit project is provided. Clear it to make agents ask for a project.";
    return <Section><Field label="Jira site" description="Choose the Jira Cloud site to connect."><Autocomplete name="siteUrl" value={values.siteUrl} placeholder="Search sites..." loadOptions={q => ui.listSites(q)} onChange={siteUrl => setValues({ siteUrl: siteUrl ?? undefined })} /></Field><Field label="Default Jira project" optional description={description}><Autocomplete name="defaultProjectUrl" value={values.defaultProjectUrl} placeholder={loadingDefault ? "Loading default project..." : "Search projects..."} loadOptions={q => ui.listProjects(q)} onChange={defaultProjectUrl => setValues({ defaultProjectDirty: "true", defaultProjectLoadState: "loaded", defaultProjectUrl })} onClear={() => setValues({ defaultProjectDirty: "true", defaultProjectLoadState: "loaded", defaultProjectUrl: null })} optional disabled={loadingDefault} /></Field></Section>;
  },
} satisfies ConfiguratorUISpec<JiraConfiguratorRpc, JiraConfiguratorValues>;
