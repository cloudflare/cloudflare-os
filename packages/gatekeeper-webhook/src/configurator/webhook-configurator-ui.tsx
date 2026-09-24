import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { WebhookConfiguratorRpc, WebhookConfiguratorValues } from "./webhook-configurator-types";

export default {
  initial: { endpointId: crypto.randomUUID(), label: null, endpointError: null },
  isReady: ({ values }) =>
    !values.endpointError && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(values.endpointId ?? ""),
  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const endpointId = new URL(resourceUrl).pathname.split("/").filter(Boolean).at(-1);
    try {
      if (!endpointId) throw new Error("Missing webhook endpoint ID.");
      const decodedEndpointId = decodeURIComponent(endpointId);
      return { endpointId: decodedEndpointId, label: await ui.getLabel(decodedEndpointId), endpointError: null };
    } catch {
      // Do not leave the randomly-generated default ready after a concrete URL failed to load.
      return {
        endpointId: null,
        label: null,
        endpointError: "Could not verify this webhook URL in your connected account. Check the URL or try again.",
      };
    }
  },
  resourceUrl: ({ values, ui }) => ui.resourceUrl(values.endpointId, values.label),
  render({ values, setValues }) {
    return <Section title="Private webhook endpoint">
      {values.endpointError && <Field label="Webhook URL" description={values.endpointError} />}
      <Field label="Label" description="Optional name shown in Connections." optional>
        <TextInput
          name="label"
          value={values.label}
          placeholder="Webhook endpoint"
          optional
          onChange={label => setValues({ label })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<WebhookConfiguratorRpc, WebhookConfiguratorValues>;
