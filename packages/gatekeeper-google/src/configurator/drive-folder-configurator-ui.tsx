import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { DriveFolderConfiguratorRpc, DriveFolderConfiguratorValues } from "./drive-folder-configurator-types";

export default {
  initial: {},
  isReady: ({ values }) => typeof values.folderId === "string" && values.folderId.length > 0,
  // Must mirror `parseDriveUrl` in resources.ts, which is what actually mints the capability. This
  // module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
  // .test.ts` is what keeps the copies honest.
  resourceUrl: ({ values }) =>
    `https://drive.google.com/_resource/folder/${encodeURIComponent(values.folderId ?? "")}`,
  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Folder" description="Choose a folder in My Drive or inside a shared drive. Search everything currently beneath it and read native Google Docs and Sheets. A shared drive's own root is the Shared Drive resource instead.">
        <Autocomplete
          name="folderId"
          value={values.folderId}
          placeholder="Search Drive folders..."
          loadOptions={query => ui.listDriveFolders(query)}
          onChange={folderId => setValues({ folderId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<DriveFolderConfiguratorRpc, DriveFolderConfiguratorValues>;
