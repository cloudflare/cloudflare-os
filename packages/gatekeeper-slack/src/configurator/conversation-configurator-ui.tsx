import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ConversationConfiguratorRpc, ConversationConfiguratorValues,
} from "./conversation-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.teamId === "string" && /^T[A-Z0-9]+$/.test(values.teamId) &&
        typeof values.conversationId === "string" && values.conversationId.length > 0;
  },

  resourceUrl({ values }) {
    if (!values.teamId || !/^T[A-Z0-9]+$/.test(values.teamId) || !values.conversationId) {
      throw new Error("Choose a workspace and conversation.");
    }
    return `https://app.slack.com/client/${values.teamId}/${encodeURIComponent(values.conversationId)}`;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const teamId = segments[1];
    const conversationId = segments[2];
    return teamId && /^T[A-Z0-9]+$/.test(teamId) && conversationId
        ? { teamId, conversationId: decodeURIComponent(conversationId) } : {};
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Workspace" description="Choose where to look for channels and direct messages.">
        <Autocomplete
          name="teamId"
          value={values.teamId}
          placeholder="Choose a Slack workspace..."
          loadOptions={query => ui.listWorkspaces(query)}
          onChange={teamId => {
            setValues({ teamId, conversationId: null });
          }}
        />
      </Field>
      <Field
        label="Conversation"
        description="Choose a channel or direct message this connection can read."
      >
        <Autocomplete
          // Scope the runtime's cached query/options to this workspace.
          name={`conversationId:${values.teamId ?? ""}`}
          value={values.conversationId}
          placeholder="Search channels and DMs..."
          disabled={!values.teamId}
          loadOptions={query => values.teamId ? ui.listConversations(values.teamId, query) : Promise.resolve([])}
          onChange={conversationId => setValues({ conversationId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConversationConfiguratorRpc, ConversationConfiguratorValues>;
