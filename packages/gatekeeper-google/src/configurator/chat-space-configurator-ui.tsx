import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ChatSpaceConfiguratorRpc, ChatSpaceConfiguratorValues,
} from "./chat-space-configurator-types";

/**
 * Pull a Chat space id out of whatever the user pasted.
 *
 * Chat writes several URL shapes for the same conversation -- `/room/{id}` for a space, `/dm/{id}`
 * for a direct message, and a `#chat/space/{id}` fragment inside Gmail -- and people also paste the
 * bare `spaces/{id}` resource name. All of them name the same capability, so all of them prefill.
 */
function spaceIdFrom(resourceUrl: string): string | undefined {
  const candidates: string[] = [];
  try {
    const parsed = new URL(resourceUrl);
    const path = /\/(?:room|dm|space)\/([^/?#]+)/.exec(parsed.pathname);
    if (path) candidates.push(path[1]);
    const fragment = /(?:chat\/)?(?:space|dm)\/([^/?#]+)/.exec(parsed.hash);
    if (fragment) candidates.push(fragment[1]);
  } catch {
    const bare = /^spaces\/([^/?#]+)$/.exec(resourceUrl.trim());
    if (bare) candidates.push(bare[1]);
  }
  for (const candidate of candidates) {
    const decoded = decodeURIComponent(candidate);
    if (/^[A-Za-z0-9_-]{1,128}$/.test(decoded)) return decoded;
  }
  return undefined;
}

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
          placeholder="Search your Google Chat conversations..."
          loadOptions={query => ui.listChatSpaces(query)}
          onChange={spaceId => setValues({ spaceId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ChatSpaceConfiguratorRpc, ChatSpaceConfiguratorValues>;
