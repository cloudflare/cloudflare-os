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
      <Field label="Google Drive account" description="Search My Drive and items shared directly with this Google account.">
        <RadioCards
          value="account"
          options={[{
            value: "account", title: "My Drive and Shared with me",
            description: "Returns file and folder metadata only.",
          }]}
          onChange={() => setValues({ scope: "account" })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<DriveAccountConfiguratorRpc, DriveAccountConfiguratorValues>;
