import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { BigQueryConfiguratorRpc, BigQueryConfiguratorValues } from "./bigquery-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.projectId === "string" && values.projectId.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [projectId, datasetId, tableId] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const values: { projectId?: string; datasetId?: string; tableId?: string } = {};
    if (projectId) values.projectId = decodeURIComponent(projectId);
    if (datasetId) values.datasetId = decodeURIComponent(datasetId);
    if (tableId) values.tableId = decodeURIComponent(tableId);
    return values;
  },

  resourceUrl({ values }) {
    const path = [values.projectId, values.datasetId, values.tableId]
      .filter((value): value is string => !!value)
      .map(encodeURIComponent)
      .join("/");
    return `https://bigquery.googleapis.com/${path}${values.datasetId ? "" : "/"}`;
  },

  render({ values, setValues, clearFields, ui }) {
    return <Section>
      <Field label="Query project" description="Run query jobs in this project. Your Google account must have permission to create jobs here.">
        <Autocomplete
          name="projectId"
          value={values.projectId}
          placeholder="Search projects..."
          loadOptions={query => ui.listProjects(query)}
          onChange={projectId => {
            clearFields("datasetId", "tableId");
            setValues({ projectId, datasetId: null, tableId: null });
          }}
        />
      </Field>

      <Field label="Dataset" description="Restrict access to this dataset in the query project. Leave blank to allow queries across any project your Google account can access." optional>
        <Autocomplete
          name="datasetId"
          value={values.datasetId}
          placeholder={values.projectId ? "Search datasets..." : "Choose a project first"}
          disabled={!values.projectId}
          loadOptions={query => values.projectId ? ui.listDatasets(values.projectId, query) : Promise.resolve([])}
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

      <Field label="Table" description="Leave blank to allow all tables in dataset." optional>
        <Autocomplete
          name="tableId"
          value={values.tableId}
          placeholder={values.datasetId ? "Search tables..." : "Choose a dataset first"}
          disabled={!values.projectId || !values.datasetId}
          loadOptions={query => values.projectId && values.datasetId
            ? ui.listTables(values.projectId, values.datasetId, query)
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
} satisfies ConfiguratorUISpec<BigQueryConfiguratorRpc, BigQueryConfiguratorValues>;
