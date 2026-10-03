import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ChatSpaceConfiguratorRpc, ChatSpaceConfiguratorValues,
} from "./chat-space-configurator-types";

/** The configurator only receives URLs matching the resource pattern, `/room/{id}`. */
const spaceIdFrom = (resourceUrl: string): string | undefined =>
  /^https:\/\/chat\.google\.com\/room\/([A-Za-z0-9_-]{1,128})\/?$/.exec(resourceUrl)?.[1];

export default {
  initial: {},
  isReady: ({ values }) => typeof values.spaceId === "string" && values.spaceId.length > 0,
  // Must mirror `parseChatUrl` in resources.ts, which is what actually mints the capability. This
  // module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
  // .test.ts` is what keeps the copies honest.
  resourceUrl: ({ values }) =>
    `https://chat.google.com/room/${encodeURIComponent(values.spaceId ?? "")}`,
  initialValuesFromResourceUrl({ resourceUrl }) {
    const spaceId = spaceIdFrom(resourceUrl);
    return spaceId ? { spaceId } : {};
  },
  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="Conversation"
        description="Choose one space, group chat, or direct message. The connection covers only that conversation, and collaborators can open the Gadget only if their own Google account can open it too."
      >
        <Autocomplete
          name="spaceId"
          value={values.spaceId}
          placeholder="Search by name, enter a person's email, or paste a Chat URL or spaces/ID..."
          loadOptions={query => ui.listChatSpaces(query)}
          onChange={spaceId => setValues({ spaceId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ChatSpaceConfiguratorRpc, ChatSpaceConfiguratorValues>;
