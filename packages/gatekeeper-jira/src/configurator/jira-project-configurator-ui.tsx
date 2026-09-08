import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { JiraConfiguratorRpc, JiraConfiguratorValues } from "./jira-configurator-types";

export default {
  initial: { defaultProjectLoadState: "idle" },
  isReady: ({ values }) => typeof values.projectUrl === "string" && values.projectUrl.length > 0,
  initialValuesFromResourceUrl: ({ resourceUrl }) => ({ projectUrl: resourceUrl, defaultProjectLoadState: "loaded" }),
  resourceUrl: ({ values }) => values.projectUrl ?? "",
  render({ values, setValues, ui }) {
    if (!values.projectUrl && (!values.defaultProjectLoadState || values.defaultProjectLoadState === "idle")) {
      setValues({ defaultProjectLoadState: "pending" });
      void ui.getDefaultProject().then(project => setValues({ defaultProjectLoadState: "loaded", projectUrl: project?.value ?? undefined })).catch(() => setValues({ defaultProjectLoadState: "failed" }));
    }
    const loadingDefault = !values.projectUrl && (values.defaultProjectLoadState === "idle" || values.defaultProjectLoadState === "pending");
    return <Section><Field label="Jira project" description="Choose one Jira project. Your optional default is preselected when available; picking a different project here only affects this connection."><Autocomplete name="projectUrl" value={values.projectUrl} placeholder={loadingDefault ? "Loading default project..." : "Search projects..."} loadOptions={q => ui.listProjects(q)} onChange={projectUrl => setValues({ projectUrl: projectUrl ?? undefined, defaultProjectLoadState: "loaded" })} disabled={loadingDefault} /></Field></Section>;
  },
} satisfies ConfiguratorUISpec<JiraConfiguratorRpc, JiraConfiguratorValues>;
