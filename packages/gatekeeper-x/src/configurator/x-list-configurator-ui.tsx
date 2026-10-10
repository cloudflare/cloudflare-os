import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { XListConfiguratorRpc, XListConfiguratorValues } from "./x-list-configurator-types";

const SNOWFLAKE = /^[0-9]{1,19}$/;

export default {
  initial: {},

  isReady({ values }) {
    return SNOWFLAKE.test(values.listId ?? "");
  },

  resourceUrl({ values }) {
    if (!SNOWFLAKE.test(values.listId ?? "")) throw new Error("Choose a List.");
    return `https://x.com/i/lists/${values.listId}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="List" description="Search your Lists, or paste the link to any X List.">
        <Autocomplete
          name="listId"
          value={values.listId}
          placeholder="Search your Lists or paste a link..."
          loadOptions={query => ui.listLists(query)}
          onChange={listId => setValues({ listId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<XListConfiguratorRpc, XListConfiguratorValues>;
