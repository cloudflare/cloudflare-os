import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { SharedDriveConfiguratorRpc, SharedDriveConfiguratorValues } from "./shared-drive-configurator-types";

export default {
  initial: {},
  isReady: ({ values }) => typeof values.driveId === "string" && values.driveId.length > 0,
  resourceUrl: ({ values }) =>
    `https://drive.google.com/drive/folders/${encodeURIComponent(values.driveId ?? "")}`,
  initialValuesFromResourceUrl: ({ resourceUrl }) => ({
    driveId: decodeURIComponent(new URL(resourceUrl).pathname.split("/")[3] ?? ""),
  }),
  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Google Workspace shared drive" description="Choose an organization-owned shared drive. Search its files, read native Google Docs and Sheets, and create blank Docs, Sheets, and folders in writable destinations.">
        <Autocomplete
          name="driveId"
          value={values.driveId}
          placeholder="Search shared drives..."
          loadOptions={query => ui.listSharedDrives(query)}
          onChange={driveId => setValues({ driveId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<SharedDriveConfiguratorRpc, SharedDriveConfiguratorValues>;
