import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  DriveFolderConfiguratorRpc, DriveFolderConfiguratorValues,
} from "./drive-folder-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.folderId === "string" && values.folderId.length > 0;
  },

  resourceUrl({ values }) {
    return `https://drive.google.com/drive/folders/${encodeURIComponent(values.folderId ?? "")}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Drive folder" description="Search folders that this Google account can access.">
        <Autocomplete
          name="folderId"
          value={values.folderId}
          placeholder="Search recent folders..."
          loadOptions={query => ui.listFolders(query)}
          onChange={folderId => setValues({ folderId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<DriveFolderConfiguratorRpc, DriveFolderConfiguratorValues>;
