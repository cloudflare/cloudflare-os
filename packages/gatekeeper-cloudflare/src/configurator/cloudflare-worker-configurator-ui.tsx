import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  CloudflareWorkerConfiguratorRpc,
  CloudflareWorkerConfiguratorValues,
} from "./cloudflare-configurator-types";

export default {
  initial: { accountId: null, workerName: null },

  isReady({ values }) {
    return !!values.accountId && !!values.workerName;
  },

  resourceUrl({ values }) {
    return `https://dash.cloudflare.com/${encodeURIComponent(values.accountId!)}/workers/services/view/` +
      `${encodeURIComponent(values.workerName!)}/production/observability`;
  },

  render({ values, setValues, clearFields, ui }) {
    return <Section>
      <Field label="Cloudflare account">
        <Autocomplete
          name="accountId"
          value={values.accountId}
          placeholder="Choose an account"
          loadOptions={query => ui.listAccounts(query)}
          onChange={accountId => {
            // Both halves are required: `clearFields` only drops the Worker autocomplete's typed
            // query, so without the explicit null the previous account's Worker stays selected and
            // `resourceUrl` happily pairs it with the new account.
            clearFields("workerName");
            setValues({ accountId, workerName: null });
          }}
        />
      </Field>
      <Field label="Worker" description="Queries telemetry only for this Worker.">
        <Autocomplete
          name="workerName"
          value={values.workerName}
          placeholder={values.accountId ? "Choose a Worker" : "Choose an account first"}
          loadOptions={query => values.accountId ? ui.listWorkers(values.accountId, query) : Promise.resolve([])}
          onChange={workerName => setValues({ workerName })}
          disabled={!values.accountId}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CloudflareWorkerConfiguratorRpc, CloudflareWorkerConfiguratorValues>;
