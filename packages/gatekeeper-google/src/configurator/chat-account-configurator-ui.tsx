import { Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ChatAccountConfiguratorRpc, ChatAccountConfiguratorValues,
} from "./chat-account-configurator-types";

export default {
  initial: { scope: "account" },
  isReady: () => true,
  // Must mirror `parseChatUrl` in resources.ts, which is what actually mints the capability. This
  // module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
  // .test.ts` is what keeps the copies honest.
  resourceUrl: () => "https://chat.google.com/",
  render({ setValues }) {
    return <Section>
      <Field
        label="Google Chat account"
        description="Covers every conversation this account can reach, including direct messages."
      >
        <RadioCards
          value="account"
          options={[{
            value: "account",
            title: "All my Google Chat conversations",
            description: "Find and search conversations, read messages, and post, react, or edit as you. Because this includes direct messages, a Gadget using it cannot be shared with collaborators — connect a single conversation for that.",
          }]}
          onChange={() => setValues({ scope: "account" })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ChatAccountConfiguratorRpc, ChatAccountConfiguratorValues>;
