import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  DeploymentConfiguratorRpc,
  DeploymentConfiguratorValues,
} from "./deployment-configurator-types";

// The account has one resource and nothing to choose, so the frame says what adding it does and
// is ready at once. The sandboxed runtime has no effect hooks, so it renders static text and asks
// the `ui` capability for the resource's URL.

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return <Section>
      <Field
        label="This deployment's Admin API"
        description="Agents in this workspace, and the code of any gadget bound to this connection (a blueprint's included), can read, as you, what this deployment's admins can read: its settings, users, audit log and issue reports, and the metadata of its workspaces and accounts, and a workspace's content only while that workspace has a live grant. They can also ask to reply to an issue report or set its status or assignee, to change a workspace, or to read one's content without its owner: each such request waits as a card in this workspace, and runs only once a person approves it, and a request for content then needs another admin's approval too. Once it is added, only deployment admins can open this workspace, and once anything in it has read through the connection, removing the connection will not let other collaborators back in.">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<DeploymentConfiguratorRpc, DeploymentConfiguratorValues>;
