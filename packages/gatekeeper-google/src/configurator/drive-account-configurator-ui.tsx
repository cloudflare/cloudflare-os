import { Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { DriveAccountConfiguratorRpc, DriveAccountConfiguratorValues } from "./drive-account-configurator-types";

export default {
  initial: { scope: "account" },
  isReady: () => true,
  // Must mirror `parseDriveUrl` in resources.ts, which is what actually mints the capability. This
  // module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
  // .test.ts` is what keeps the copies honest.
  resourceUrl: () => "https://drive.google.com/drive/my-drive",
  render({ setValues }) {
    return <Section>
      <Field
        label="Google Drive account"
        description="Find files and folders anywhere this Google account can read in Drive, including shared drives. Full-text search examines indexed file content, descriptions, and OCR text; results contain metadata only."
      >
        <RadioCards
          value="account"
          options={[{
            value: "account", title: "Everything this account can read in Drive",
            description: "Includes direct lookup by file ID. Full-text search examines indexed file content, descriptions, and OCR text; results contain metadata only.",
          }]}
          onChange={() => setValues({ scope: "account" })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<DriveAccountConfiguratorRpc, DriveAccountConfiguratorValues>;
