import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { DriveFileConfiguratorRpc, DriveFileConfiguratorValues } from "./drive-file-configurator-types";

export default {
  initial: {},
  isReady: ({ values }) => typeof values.fileId === "string" && values.fileId.length > 0,
  // Must mirror `parseDriveUrl` in resources.ts, which is what actually mints the capability. This
  // module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
  // .test.ts` is what keeps the copies honest.
  resourceUrl: ({ values }) =>
    `https://drive.google.com/file/d/${encodeURIComponent(values.fileId ?? "")}/view`,
  render({ values, setValues, ui }) {
    return <Section>
      <Field label="File" description="Search recent non-folder files. A selected native Google Doc or Sheet also provides read-only content.">
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
