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
      <Field label="Google Workspace shared drive" description="Choose a shared drive owned by an organization rather than an individual.">
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
