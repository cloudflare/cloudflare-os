// Resource-URL grammar for the two BigQuery resource types.
//
// A BigQuery binding names two projects: the one whose data it may read, and the one whose account
// is billed for the query jobs. For an ordinary binding those are the same project, so the URL
// names it once. A public-data binding reads a Google-hosted project that grants
// `roles/bigquery.dataViewer` to `allAuthenticatedUsers` -- readable by any signed-in Google user,
// but not billable -- so its URL names the user's own billing project separately.
//
// The two forms sit on distinct synthetic hostnames rather than sharing one with a marker segment:
// a marker would also match the other form's `:projectId/*` URLPattern, and both
// `matchesResourceUrlPattern` and the frontend's resource matching would then see two candidate
// resource types for one URL.
//
// Pure and dependency-free, so the grammar can be unit-tested on its own.

/** Synthetic host for a binding that reads (and bills) one of the user's own projects. */
export const BIGQUERY_HOST = "bigquery.googleapis.com";

/** Synthetic host for a binding that reads a curated public project and bills the user's own. */
export const BIGQUERY_PUBLIC_HOST = "public.bigquery.googleapis.com";

/** `SupportedResource.urlPattern` for the ordinary BigQuery resource. */
export const BIGQUERY_RESOURCE_URL_PATTERN = `https://${BIGQUERY_HOST}/:projectId/*`;

/**
 * `SupportedResource.urlPattern` for the public-data resource. Declared beside the other so the
 * two stay visibly disjoint -- the property the separate hostname exists to provide, and the one
 * `bigquery-resource.test.ts` pins.
 */
export const BIGQUERY_PUBLIC_RESOURCE_URL_PATTERN =
    `https://${BIGQUERY_PUBLIC_HOST}/:billingProjectId/:dataProjectId/*`;

/** A Google-hosted project whose datasets any authenticated Google user may read. */
export type PublicDataProject = {
  /** The BigQuery project id, as it appears in a fully-qualified table name. */
  projectId: string;
  /** Human-readable name, shown in the resource configurator. */
  title: string;
  /** One-line summary of what the project holds, shown in the resource configurator. */
  description: string;
};

/**
 * The projects a public-data binding is allowed to read.
 *
 * An allowlist rather than free text, because it is what makes a public binding's "reads only
 * public data" label true: that label is why such a binding is exempted from
 * `containsRestrictedData` (see `BigQuerySessionImpl`), and free text would let a binding titled
 * "public data" read whatever private project the user's own token happens to reach.
 *
 * Every entry grants `roles/bigquery.dataViewer` to `allAuthenticatedUsers`. Adding one is a
 * one-line data change; removing one correctly disables existing bindings, since the allowlist is
 * re-checked when a session starts, not only when the binding is created.
 */
export const PUBLIC_DATA_PROJECTS: readonly PublicDataProject[] = [
  {
    projectId: "bigquery-public-data",
    title: "Google BigQuery Public Datasets",
    description: "Google's curated collection: census, weather, GitHub, crypto, COVID, and more.",
  },
  {
    projectId: "patents-public-data",
    title: "Google Patents Public Data",
    description: "Worldwide patent publications, citations, and full text.",
  },
  {
    projectId: "gdelt-bq",
    title: "GDELT Project",
    description: "Global news events, entities, and tone, updated continuously.",
  },
  {
    projectId: "nyc-tlc",
    title: "NYC Taxi & Limousine Commission",
    description: "Yellow, green, and for-hire vehicle trip records for New York City.",
  },
  {
    projectId: "openaq",
    title: "OpenAQ",
    description: "Global air quality measurements aggregated from public monitoring stations.",
  },
  {
    projectId: "bigquery-samples",
    title: "BigQuery Samples",
    description: "Small sample tables used by Google's BigQuery documentation and tutorials.",
  },
];

/** Whether `projectId` is one of the {@link PUBLIC_DATA_PROJECTS}. */
export function isPublicDataProject(projectId: string): boolean {
  return PUBLIC_DATA_PROJECTS.some(project => project.projectId === projectId);
}

/**
 * Whether this deployment offers the "BigQuery Public Data" connection at all.
 *
 * Off unless `ENABLE_BIGQUERY_PUBLIC_DATA` is exactly `"true"`, because a deployment should not
 * silently acquire a new data source -- however public -- from a repo update, and because the
 * queries are billed to the user's own project. `wrangler.jsonc` commits `"false"`; the dev server
 * turns it on for local development.
 *
 * An env var rather than an `AdminConfig` entry: it decides what the deployment *offers*, not what
 * an admin has opted out of, so it should not be reachable from a compromised admin session. Admins
 * can still disable the resource on top of this, the same way they can any other.
 */
export function bigQueryPublicDataEnabled(
  env: { ENABLE_BIGQUERY_PUBLIC_DATA?: string },
): boolean {
  return (env.ENABLE_BIGQUERY_PUBLIC_DATA ?? "").trim().toLowerCase() === "true";
}

/** Shown wherever a public-data URL or configurator is refused because the flag is off. */
export const BIGQUERY_PUBLIC_DATA_DISABLED_MESSAGE =
    "BigQuery Public Data connections are not enabled on this deployment. An administrator can " +
    "enable them by setting ENABLE_BIGQUERY_PUBLIC_DATA=true on the Google gatekeeper.";

/**
 * What a BigQuery resource URL grants: which project's data may be read, which project pays, and
 * how far the read is narrowed.
 *
 * For `kind: "private"`, `billingProjectId === dataProjectId`. For `kind: "public"` they always
 * differ in practice, since a public project cannot run jobs.
 */
export type BigQueryResourceScope = {
  /** `"public"` iff `dataProjectId` is an allowlisted public-data project. */
  kind: "private" | "public";
  /** Project the query jobs are billed to; must be one the user can create jobs in. */
  billingProjectId: string;
  /** The only project whose tables the binding may reference. */
  dataProjectId: string;
  /** When set, the only dataset within `dataProjectId` the binding may reference. */
  datasetId?: string;
  /** When set, the only table within `datasetId` the binding may reference. */
  tableId?: string;
};

/** Split a synthetic resource path into its decoded, non-empty segments. */
function resourceSegments(pathname: string): string[] {
  return pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map(segment => decodeURIComponent(segment));
}

/**
 * Parse a BigQuery resource URL into the scope it grants.
 *
 * Returns null if `url` names neither BigQuery host, so a caller dispatching over several vendors'
 * URL shapes can fall through. Throws if it names one of them but is malformed -- including a
 * public URL whose data project is not allowlisted, which is the check that keeps an unallowlisted
 * project from ever reaching a binding's props.
 */
export function parseBigQueryResourceUrl(url: string): BigQueryResourceScope | null {
  let parsed = new URL(url);
  let isPublic = parsed.hostname === BIGQUERY_PUBLIC_HOST;
  if (!isPublic && parsed.hostname !== BIGQUERY_HOST) return null;

  if (parsed.protocol !== "https:") {
    throw new Error(`BigQuery resource URLs must use https: ${url}`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error("BigQuery resource URLs must not include query strings or fragments.");
  }

  let segments = resourceSegments(parsed.pathname);

  if (isPublic) {
    // Synthetic path: /<billingProject>/<dataProject>/<dataset>/<table> (each optional after the
    // second).
    if (segments.length > 4) {
      throw new Error(
          "BigQuery public data resource URLs must be /<billingProjectId>/<dataProjectId>, " +
          "/<billingProjectId>/<dataProjectId>/<datasetId>, or " +
          "/<billingProjectId>/<dataProjectId>/<datasetId>/<tableId>.");
    }
    let [billingProjectId, dataProjectId, datasetId, tableId] = segments;
    if (!billingProjectId) {
      throw new Error("BigQuery public data resource URLs must include a billing project ID.");
    }
    if (!dataProjectId) {
      throw new Error("BigQuery public data resource URLs must include a public data project ID.");
    }
    if (!isPublicDataProject(dataProjectId)) {
      throw new Error(
          `"${dataProjectId}" is not a known public BigQuery project. Choose one of: ` +
          `${PUBLIC_DATA_PROJECTS.map(project => project.projectId).join(", ")}.`);
    }
    // Defensive: empty segments are dropped above, so a table can only ever occupy the fourth
    // position, never slide into the dataset's. Kept so the invariant is stated where it is
    // depended on rather than inferred from the segment filtering.
    if (tableId && !datasetId) {
      throw new Error("Cannot scope to a table without specifying a dataset.");
    }
    return { kind: "public", billingProjectId, dataProjectId, datasetId, tableId };
  }

  // Synthetic path: /<projectId>/<datasetId>/<tableId> (each segment optional after the first).
  if (segments.length > 3) {
    throw new Error(
        "BigQuery resource URLs must be /<projectId>, /<projectId>/<datasetId>, " +
        "or /<projectId>/<datasetId>/<tableId>.");
  }
  let [projectId, datasetId, tableId] = segments;
  if (!projectId) {
    throw new Error("BigQuery resource URLs must include a project ID.");
  }
  if (tableId && !datasetId) {
    throw new Error("Cannot scope to a table without specifying a dataset.");
  }
  return {
    kind: "private",
    billingProjectId: projectId,
    dataProjectId: projectId,
    datasetId,
    tableId,
  };
}

/**
 * The canonical resource URL for a scope -- the inverse of {@link parseBigQueryResourceUrl}.
 *
 * This is the form `describe()` reports. The configurator `.tsx` modules build the same strings
 * inline, because the sandbox strips their imports and they cannot call this; `bigquery-resource`'s
 * tests pin the grammar both sides implement.
 */
export function bigQueryResourceUrl(scope: BigQueryResourceScope): string {
  // Segments are positional, so a table with no dataset has no representation: emitting the table
  // where the dataset belongs would produce a URL that parses back to a *different* scope.
  if (scope.tableId && !scope.datasetId) {
    throw new Error("Cannot scope to a table without specifying a dataset.");
  }
  let host = scope.kind === "public" ? BIGQUERY_PUBLIC_HOST : BIGQUERY_HOST;
  let segments = scope.kind === "public"
      ? [scope.billingProjectId, scope.dataProjectId]
      : [scope.dataProjectId];
  if (scope.datasetId) segments.push(scope.datasetId);
  if (scope.tableId) segments.push(scope.tableId);
  return `https://${host}/${segments.map(encodeURIComponent).join("/")}`;
}
