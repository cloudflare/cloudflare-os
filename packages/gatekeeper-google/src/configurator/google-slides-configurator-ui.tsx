import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  GoogleSlidesConfiguratorRpc, GoogleSlidesConfiguratorValues,
} from "./google-slides-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.presentationId === "string" && values.presentationId.length > 0;
  },

  resourceUrl({ values }) {
    return `https://docs.google.com/presentation/d/${encodeURIComponent(values.presentationId ?? "")}/edit`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Presentation" description="Search recent presentations from Drive.">
        <Autocomplete
          name="presentationId"
          value={values.presentationId}
          placeholder="Search recent presentations..."
          loadOptions={query => ui.listPresentations(query)}
          onChange={presentationId => setValues({ presentationId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GoogleSlidesConfiguratorRpc, GoogleSlidesConfiguratorValues>;
