import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ChatThreadConfiguratorRpc, ChatThreadConfiguratorValues,
} from "./chat-thread-configurator-types";

// Must mirror `parseChatUrl` in resources.ts and the id grammar in chat-api.ts; this module is
// transpiled on its own, so `__tests__/configurator-url.test.ts` keeps the copies honest.
// Chat's "Copy link" on a message gives /{room|dm}/{space}/{thread}/{message}?cls=…
const LINK_RE =
  /^https:\/\/chat\.google\.com\/(?:room|dm)\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_.-]{1,256})(?:\/[^/?#]+)?\/?(?:\?[^#]*)?$/;
const NAME_RE = /^spaces\/([A-Za-z0-9_-]{1,128})\/threads\/([A-Za-z0-9_.-]{1,256})$/;

function threadFrom(link: string): { spaceId: string; threadId: string } | undefined {
  const trimmed = link.trim();
  const match = LINK_RE.exec(trimmed) ?? NAME_RE.exec(trimmed);
  // A bare `.` or `..` id would be collapsed out of a URL path.
  return match && /[^.]/.test(match[2]) ? { spaceId: match[1], threadId: match[2] } : undefined;
}

export default {
  initial: {},
  isReady: ({ values }) => threadFrom(values.link ?? "") !== undefined,
  resourceUrl: ({ values }) => {
    const thread = threadFrom(values.link ?? "");
    return thread
      ? `https://chat.google.com/room/${encodeURIComponent(thread.spaceId)}/${encodeURIComponent(thread.threadId)}`
      : (values.link ?? "").trim();
  },
  initialValuesFromResourceUrl: ({ resourceUrl }) =>
    threadFrom(resourceUrl) ? { link: resourceUrl } : {},
  render({ values, setValues }) {
    return <Section>
      <Field
        label="Thread link"
        description="Paste a link to the thread, or to any message in it, from Google Chat's Copy link. The connection covers only that thread, and collaborators can open the Gadget only if their own Google account can open its conversation."
      >
        <TextInput
          name="link"
          value={values.link}
          placeholder="https://chat.google.com/room/…/…"
          onChange={link => setValues({ link })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ChatThreadConfiguratorRpc, ChatThreadConfiguratorValues>;
