import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { XAccountConfiguratorRpc, XAccountConfiguratorValues } from "./x-account-configurator-types";

// The whole-account resource has no inputs: its URL names no user, so a blueprint re-resolving it
// under another connection binds that connection's account. Keep in step with `ACCOUNT_URL`.
const ACCOUNT_URL = "https://x.com/settings/account";

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl() {
    return ACCOUNT_URL;
  },

  render() {
    return <Section>
      <Field
        label="Whole-account access"
        description="This binding acts as the connected X account: it reads your timelines, mentions, search, bookmarks and likes, and drafts posts, replies, likes, reposts and follows. Nothing is published until you approve it.">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<XAccountConfiguratorRpc, XAccountConfiguratorValues>;
