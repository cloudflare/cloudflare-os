import { Autocomplete, Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  CreationFolderConfiguratorRpc, CreationFolderConfiguratorValues,
} from "./creation-folder-configurator-types";

export default {
  initial: { location: "myDrive" },
  isReady: ({ values }) => values.location !== "folder" ||
    (typeof values.folderId === "string" && values.folderId.length > 0),
  // Must mirror `creationFolderId` in creation.ts, which parses this with `parseResourceUrl`. This
  // module is transpiled on its own and cannot import either, so `__tests__/configurator-url
  // .test.ts` is what keeps the copies honest.
  resourceUrl: ({ values }) => values.location === "folder"
    ? `https://drive.google.com/drive/folders/${encodeURIComponent(values.folderId ?? "")}`
    : "https://drive.google.com/drive/my-drive",
  render({ values, setValues, clearFields, ui }) {
    return <Section>
      <Field label="Location" description="A new file is shared like the folder it is created in.">
        <RadioCards
          value={values.location}
          options={[
            {
              value: "myDrive", title: "My Drive",
              description: "The top of this account's My Drive.",
            },
            {
              value: "folder", title: "A folder",
              description: "A folder this account can add files to, in My Drive, Shared with me, or a shared drive.",
            },
          ]}
          onChange={location => {
            if (location !== "myDrive" && location !== "folder") return;
            clearFields("folderId");
            setValues({ location, folderId: null });
          }}
        />
      </Field>
      {values.location === "folder" && <Field label="Folder">
        <Autocomplete
          name="folderId"
          value={values.folderId}
          placeholder="Search Drive folders..."
          loadOptions={query => ui.listCreationFolders(query)}
          onChange={folderId => setValues({ folderId })}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<CreationFolderConfiguratorRpc, CreationFolderConfiguratorValues>;
