import { Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  GroupsAccountConfiguratorRpc, GroupsAccountConfiguratorValues,
} from "./groups-account-configurator-types";

export default {
  initial: { scope: "account" },
  isReady: () => true,
  // Must mirror `parseGroupsUrl` in resources.ts, which is what actually mints the capability. This
  // module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
  // .test.ts` is what keeps the copies honest.
  resourceUrl: () => "https://groups.google.com/",
  render({ setValues }) {
    return <Section>
      <Field
        label="Google Groups account"
        description="Covers every group this account can see in its organization. Read-only."
      >
        <RadioCards
          value="account"
          options={[{
            value: "account",
            title: "All the groups I can see",
            description: "Search your organization's groups, see which groups someone belongs to, and read the members of any group you can see. Because some groups and member lists are visible only to their members, a Gadget using it cannot be shared with collaborators — connect a single group for that.",
          }]}
          onChange={() => setValues({ scope: "account" })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GroupsAccountConfiguratorRpc, GroupsAccountConfiguratorValues>;
