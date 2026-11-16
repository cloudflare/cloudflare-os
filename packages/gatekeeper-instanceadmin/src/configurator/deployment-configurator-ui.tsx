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
        description="Agents in this workspace can read what this deployment's admins can read, as you, and ask to reply to issue reports and to file write requests. Once it is added, only deployment admins can open this workspace.">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<DeploymentConfiguratorRpc, DeploymentConfiguratorValues>;
