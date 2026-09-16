import {
  Autocomplete, Field, h, RadioCards, Section, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  DriveFolderConfiguratorRpc, DriveFolderConfiguratorValues,
} from "./drive-folder-configurator-types";

export default {
  initial: { source: "folders" as const },
  isReady: ({ values }) => typeof values.folderId === "string" && values.folderId.length > 0,
  resourceUrl: ({ values }) =>
    `https://drive.google.com/drive/folders/${encodeURIComponent(values.folderId ?? "")}`,
  render({ values, setValues, clearFields, ui }) {
    let source = values.source === "sharedDrives" ? "sharedDrives" : "folders";
    return <Section>
      <Field label="Source" description="Both choices create the same folder-scoped connection.">
        <RadioCards
          value={source}
          options={[
            {
              value: "folders",
              title: "Folders",
              description: "Search folders this account owns or that others shared with it.",
            },
            {
              value: "sharedDrives",
              title: "Workspace Shared Drives",
              description: "Search organization-owned shared drives after optional discovery is enabled. These are not the same as folders under \"Shared with me\".",
            },
          ]}
          onChange={nextSource => {
            if (nextSource !== "folders" && nextSource !== "sharedDrives") return;
            clearFields("folderId");
            setValues({ source: nextSource, folderId: null });
          }}
        />
      </Field>
      <Field label={source === "sharedDrives" ? "Workspace Shared Drive" : "Folder"}>
        <Autocomplete
          name="folderId"
          value={values.folderId}
          placeholder={source === "sharedDrives"
            ? "Search Workspace Shared Drives..."
            : "Search Drive folders..."}
          loadOptions={query => source === "sharedDrives"
            ? ui.listSharedDrives(query)
            : ui.listDriveFolders(query)}
          onChange={folderId => setValues({ folderId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<DriveFolderConfiguratorRpc, DriveFolderConfiguratorValues>;
