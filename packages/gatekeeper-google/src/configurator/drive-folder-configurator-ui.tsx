import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  DriveFolderConfiguratorRpc, DriveFolderConfiguratorValues,
} from "./drive-folder-configurator-types";

export default {
  initial: {},
  isReady: ({ values }) => typeof values.folderId === "string" && values.folderId.length > 0,
  // Must mirror `parseDriveUrl` in resources.ts, which is what actually mints the capability. This
  // module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
  // .test.ts` is what keeps the copies honest.
  resourceUrl: ({ values }) =>
    `https://drive.google.com/drive/folders/${encodeURIComponent(values.folderId ?? "")}`,
  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Folder" description="Search folders in My Drive, Shared with me, and shared drives this account belongs to. Folders whose children cannot be listed are not offered.">
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
