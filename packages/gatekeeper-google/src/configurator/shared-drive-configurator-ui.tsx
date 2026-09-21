import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { SharedDriveConfiguratorRpc, SharedDriveConfiguratorValues } from "./shared-drive-configurator-types";

export default {
  initial: {},
  isReady: ({ values }) => typeof values.driveId === "string" && values.driveId.length > 0,
  // Must mirror `parseDriveUrl` in resources.ts, which is what actually mints the capability. This
  // module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
  // .test.ts` is what keeps the copies honest.
  resourceUrl: ({ values }) =>
    `https://drive.google.com/drive/folders/${encodeURIComponent(values.driveId ?? "")}`,
  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Google Workspace shared drive" description="Choose a shared drive owned by an organization rather than an individual. Search its files and read native Google Docs and Sheets.">
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
