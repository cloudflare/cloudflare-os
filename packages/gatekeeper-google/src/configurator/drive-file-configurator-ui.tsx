import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { DriveFileConfiguratorRpc, DriveFileConfiguratorValues } from "./drive-file-configurator-types";

export default {
  initial: {},
  isReady: ({ values }) => typeof values.fileId === "string" && values.fileId.length > 0,
  resourceUrl: ({ values }) =>
    `https://drive.google.com/file/d/${encodeURIComponent(values.fileId ?? "")}/view`,
  initialValuesFromResourceUrl: ({ resourceUrl }) => ({
    fileId: decodeURIComponent(new URL(resourceUrl).pathname.split("/")[3] ?? ""),
  }),
  render({ values, setValues, ui }) {
    return <Section>
      <Field label="File" description="Search recent non-folder files and choose one read-only file binding. Native Google Docs and Sheets also expose read-only content.">
        <Autocomplete
          name="fileId"
          value={values.fileId}
          placeholder="Search Drive files..."
          loadOptions={query => ui.listDriveFiles(query)}
          onChange={fileId => setValues({ fileId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<DriveFileConfiguratorRpc, DriveFileConfiguratorValues>;
