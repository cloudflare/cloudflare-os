import { CheckboxList, Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  WebhookEndpointConfiguratorRpc,
  WebhookEndpointConfiguratorValues,
} from "./webhook-configurator-types";

const METHODS = ["POST", "PUT", "PATCH", "DELETE", "GET"];

export default {
  initial: {},

  isReady({ values }) {
    return (
      typeof values.title === "string" && values.title.trim().length > 0 &&
      typeof values.description === "string" && values.description.trim().length > 0
    );
  },

  // Re-opening an existing binding must not mint a second endpoint, so the URL is reused as-is and
  // the form shows only what it can still describe. Title and description live in the registry.
  initialValuesFromResourceUrl() {
    return {};
  },

  async resourceUrl({ values, ui }) {
    return ui.createEndpoint(
      values.title!.trim(),
      values.description!.trim(),
      values.methods ?? undefined,
    );
  },

  render({ values, setValues }) {
    return <Section>
      <Field label="Name" description="Shown in Connections and the Webhooks app.">
        <TextInput
          name="title"
          value={values.title}
          placeholder="Alertmanager"
          onChange={title => setValues({ title })}
        />
      </Field>
      <Field
        label="What it receives"
        description="Describe the sending service and what this workspace does with its events. Shown when someone decides whether to enable delivery."
      >
        <TextInput
          name="description"
          value={values.description}
          placeholder="Receives pod alerts from Prometheus Alertmanager and opens a triage chat."
          onChange={description => setValues({ description })}
        />
      </Field>
      <Field
        label="Methods"
        description="Anything else is rejected with 405. Leave empty for POST only."
        optional
      >
        <CheckboxList
          name="methods"
          value={values.methods}
          loadOptions={async () => METHODS.map(value => ({ value, title: value }))}
          onChange={methods => setValues({ methods })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<WebhookEndpointConfiguratorRpc, WebhookEndpointConfiguratorValues>;
