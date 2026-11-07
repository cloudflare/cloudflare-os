import { h, Notice, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitLabInstanceConfiguratorRpc, GitLabInstanceConfiguratorValues } from "./gitlab-instance-configurator-types";

// The instance binding names the deployment's configured instance, so there is nothing to choose:
// this only confirms it. The host shown is asked of the gatekeeper once, on first render; should
// that fail, the text names the instance generically, since the choice does not depend on it.
let host: string | null = null;
let askedForHost = false;

export default {
  initial: {},

  isReady() {
    return true;
  },

  initialValuesFromResourceUrl() {
    return {};
  },

  async resourceUrl({ ui }) {
    return `${await ui.instanceUrl()}/`;
  },

  render({ setValues, ui }) {
    if (!askedForHost) {
      askedForHost = true;
      ui.instanceUrl().then(url => {
        host = new URL(url).host;
        setValues({});
      }, () => {});
    }
    return <Section>
      <Notice>Search and read code in every project you can read on {host ?? "this GitLab instance"}.</Notice>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitLabInstanceConfiguratorRpc, GitLabInstanceConfiguratorValues>;
