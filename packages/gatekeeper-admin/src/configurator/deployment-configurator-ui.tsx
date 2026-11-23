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
        description="Agents in this workspace, and the code of any gadget bound to this connection (a blueprint's included), can read, as you, what this deployment's admins can read: its settings, users and audit log, and the metadata of its workspaces and accounts, never their content. They cannot change anything. What they read is restricted data: a collaborator can open the workspace only with a Deployment admin account of their own, which only a deployment admin can connect. From the first read on, and for good, nothing in this workspace is applied without a person, and its web fetches reach only the hosts this deployment trusts.">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<DeploymentConfiguratorRpc, DeploymentConfiguratorValues>;
