import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  BigQueryConfiguratorRpc, BigQueryPublicConfiguratorValues,
} from "./bigquery-configurator-types";

// Picks the two projects a public-data connection names: one of the user's own to bill, and a
// curated public one to read. The URL grammar below duplicates `bigquery-resource.ts` because the
// sandbox strips this module's imports; `__tests__/bigquery-resource.test.ts` pins the form both
// sides build.

export default {
  initial: { dataProjectId: "bigquery-public-data" },

  isReady({ values }) {
    return !!values.billingProjectId && !!values.dataProjectId;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    let [billingProjectId, dataProjectId, datasetId, tableId] =
        new URL(resourceUrl).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    let values: BigQueryPublicConfiguratorValues = {};
    if (billingProjectId) values.billingProjectId = billingProjectId;
    if (dataProjectId) values.dataProjectId = dataProjectId;
    if (datasetId) values.datasetId = datasetId;
    if (tableId) values.tableId = tableId;
    return values;
  },

  resourceUrl({ values }) {
    let path = [values.billingProjectId, values.dataProjectId, values.datasetId, values.tableId]
        .filter((value): value is string => !!value)
        .map(encodeURIComponent)
        .join("/");
    return `https://public.bigquery.googleapis.com/${path}`;
  },

  render({ values, setValues, clearFields, ui }) {
    return <Section>
      <Field
        label="Billing project"
        description={
          "Queries are billed to this Google Cloud project — but this connection cannot read its " +
          "data, only the public dataset chosen below."
        }
      >
        <Autocomplete
          name="billingProjectId"
          value={values.billingProjectId}
          placeholder="Search your projects..."
          loadOptions={query => ui.listProjects(query)}
          onChange={billingProjectId => setValues({ billingProjectId })}
        />
      </Field>

      <Field
        label="Public dataset source"
        description="The public project this connection may query. Anyone signed in to Google can read these."
      >
        <Autocomplete
          name="dataProjectId"
          value={values.dataProjectId}
          placeholder="Search public projects..."
          loadOptions={query => ui.listPublicProjects(query)}
          onChange={dataProjectId => {
            // clearFields only drops each autocomplete's typed query, so the dependent *values*
            // have to be nulled too or a stale dataset survives into the resource URL.
            clearFields("datasetId", "tableId");
            setValues({ dataProjectId, datasetId: null, tableId: null });
          }}
        />
      </Field>

      <Field label="Dataset" description="Leave blank to allow all datasets in the public project." optional>
        <Autocomplete
          name="datasetId"
          value={values.datasetId}
          placeholder={values.dataProjectId ? "Search datasets..." : "Choose a public project first"}
          disabled={!values.dataProjectId}
          loadOptions={query => values.dataProjectId
            ? ui.listDatasets(values.dataProjectId, query)
            : Promise.resolve([])}
          onChange={datasetId => {
            clearFields("tableId");
            setValues({ datasetId, tableId: null });
          }}
          optional
          onClear={() => {
            clearFields("datasetId", "tableId");
            setValues({ datasetId: null, tableId: null });
          }}
        />
      </Field>

      <Field label="Table" description="Leave blank to allow all tables in the dataset." optional>
        <Autocomplete
          name="tableId"
          value={values.tableId}
          placeholder={values.datasetId ? "Search tables..." : "Choose a dataset first"}
          disabled={!values.dataProjectId || !values.datasetId}
          loadOptions={query => values.dataProjectId && values.datasetId
            ? ui.listTables(values.dataProjectId, values.datasetId, query)
            : Promise.resolve([])}
          onChange={tableId => setValues({ tableId })}
          optional
          onClear={() => {
            clearFields("tableId");
            setValues({ tableId: null });
          }}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<BigQueryConfiguratorRpc, BigQueryPublicConfiguratorValues>;
