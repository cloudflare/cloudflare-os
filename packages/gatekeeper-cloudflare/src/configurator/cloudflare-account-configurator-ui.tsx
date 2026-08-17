import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  CloudflareAccountConfiguratorValues,
  CloudflareAccountConfiguratorRpc,
} from "./cloudflare-configurator-types";

export default {
  initial: { accountId: null },

  isReady({ values }) {
    return !!values.accountId;
  },

  resourceUrl({ values }) {
    return `https://dash.cloudflare.com/${encodeURIComponent(values.accountId!)}/workers-and-pages/observability`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Cloudflare account" description="Queries telemetry across every Worker in this account.">
        <Autocomplete
          name="accountId"
          value={values.accountId}
          placeholder="Choose an account"
          loadOptions={query => ui.listAccounts(query)}
          onChange={accountId => setValues({ accountId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CloudflareAccountConfiguratorRpc, CloudflareAccountConfiguratorValues>;
