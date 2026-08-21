import { Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { DriveAccountConfiguratorRpc, DriveAccountConfiguratorValues } from "./drive-account-configurator-types";

export default {
  initial: { scope: "account" },
  isReady: () => true,
  resourceUrl: () => "https://drive.google.com/drive/my-drive",
  initialValuesFromResourceUrl: () => ({ scope: "account" }),
  render({ setValues }) {
    return <Section>
      <Field label="Google Drive account" description="Search My Drive and items shared directly with this Google account, and read native Google Docs and Sheets.">
        <RadioCards
          value="account"
          options={[{
            value: "account", title: "My Drive and Shared with me",
            description: "Returns metadata for every item and read-only content sessions for native Docs and Sheets.",
          }]}
          onChange={() => setValues({ scope: "account" })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<DriveAccountConfiguratorRpc, DriveAccountConfiguratorValues>;
