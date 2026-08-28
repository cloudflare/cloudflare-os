// The Gadget-facing BigQuery session. Split out of google.ts so Node vitest can construct it
// directly (google.ts imports workerd-only modules and bundled .txt assets); the tests alias
// `cloudflare:workers` and `capnweb-validate` to stubs, while production builds reach this file
// through google.ts and get the real base class and the capnweb-validate transform.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { type BigQueryApi, DEFAULT_MAX_BYTES_BILLED } from "./bigquery-api";
import type {
  BigQueryDataset, BigQueryDryRunResult, BigQueryField, BigQueryProject,
  BigQueryQueryOptions, BigQueryQueryResult, BigQuerySession, BigQueryTable,
} from "./bigquery-types";
import type { ObserverCheck } from "./observers";

/** One BigQuery dataset, the unit at which observer access is tracked. */
export type BigQueryDatasetRef = { projectId: string; datasetId: string };

/**
 * Implements {@link BigQuerySession} over the REST API, enforcing the binding's
 * project/dataset/table scope via a dry run before every query and attributing each read to the
 * datasets it reveals.
 */

@validateRpc()
export class BigQuerySessionImpl extends RpcTarget implements BigQuerySession {
  #api: BigQueryApi;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #scopedProjectId?: string;
  #scopedDatasetId?: string;
  #scopedTableId?: string;
  // Records the datasets an observation reveals and returns observers to exclude.
  #observe: (datasets: BigQueryDatasetRef[]) => Promise<ObserverCheck<BigQueryDatasetRef>>;

  constructor(
    api: BigQueryApi,
    approvalQueue: RpcStub<ApprovalQueue>,
    scopedProjectId: string | undefined,
    scopedDatasetId: string | undefined,
    scopedTableId: string | undefined,
    observe: (datasets: BigQueryDatasetRef[]) => Promise<ObserverCheck<BigQueryDatasetRef>>,
  ) {
    super();
    this.#api = api;
    this.#approvalQueue = approvalQueue;
    this.#scopedProjectId = scopedProjectId;
    this.#scopedDatasetId = scopedDatasetId;
    this.#scopedTableId = scopedTableId;
    this.#observe = observe;
  }

  // Authorize an observation that reveals data belonging to specific dataset(s), tracking them and
  // excluding observers who lack access to a newly-seen one. Use for every read that exposes dataset
  // data; pass an empty `datasets` for reads that reveal none (e.g. echoing the scoped project id).
  async #authorizeDatasets(
    datasets: { projectId: string; datasetId: string }[],
    description: ObservationDescription,
  ): Promise<void> {
    let check = datasets.length > 0 ? await this.#observe(datasets) : {pendingSets: [], commit() {}};
    await this.#approvalQueue.authorizeObservation({
      ...description, excludeObservers: check.excludeObservers,
    });
    check.commit();
  }

  // The unique datasets referenced by a dry-run's `referencedTables` (format "project.dataset.table",
  // matching #checkScopedTables's parsing).
  static #datasetsFromReferencedTables(referenced: string[]): { projectId: string; datasetId: string }[] {
    let out: { projectId: string; datasetId: string }[] = [];
    for (let ref of referenced) {
      let parts = ref.split(".");
      if (parts.length === 3) out.push({ projectId: parts[0], datasetId: parts[1] });
    }
    return out;
  }

  // --- helpers -----------------------------------------------------------

  // Pick the project to bill the query against. When scoped, the scoped project is used and
  // the caller cannot override. When unscoped, the caller must declare a default project via
  // `defaultDataset.projectId` (BigQuery requires a billing project on every query).
  #billingProject(): string {
    if (this.#scopedProjectId) return this.#scopedProjectId;
    throw new Error(
      "This session is not scoped to a project. Connect to a specific BigQuery project " +
      "(e.g. https://bigquery.googleapis.com/my-project) to run queries.");
  }

  #effectiveDataset(opts: { defaultDataset?: string } | undefined): string | undefined {
    if (this.#scopedDatasetId) {
      if (opts?.defaultDataset && opts.defaultDataset !== this.#scopedDatasetId) {
        throw new Error(
          `Cannot override defaultDataset to "${opts.defaultDataset}" — this connection is ` +
          `scoped to "${this.#scopedDatasetId}".`);
      }
      return this.#scopedDatasetId;
    }
    return opts?.defaultDataset;
  }

  // Note: callers can still probe whether out-of-scope tables exist by attempting queries
  // and observing which error class fires (out-of-scope vs. not-found vs. DML-rejected).
  // The data is protected; the namespace is partly leaky.
  #checkScopedTables(referenced: string[]): void {
    if (!this.#scopedProjectId) throw new Error("BigQuery queries require a project-scoped binding.");
    // A query that references no tables is refused on every binding shape. It still executes
    // with the owner's token and can return session/owner context (`SESSION_USER()`,
    // `@@project_id`) that no dataset probe can verify an observer against — an empty tracked
    // set would admit any verifier without a single probe. This is the single chokepoint behind
    // both query() and dryRun(), so it also closes INFORMATION_SCHEMA reads whose dry run
    // reports empty referencedTables.
    if (referenced.length === 0) {
      throw new Error(
        "This query does not reference any tables, so its data access cannot be attributed to " +
        "a dataset and verified for collaborators. Reference at least one table (computations " +
        "that need no table data can run in gadget code instead).");
    }
    for (let ref of referenced) {
      let parts = ref.split(".");
      if (parts.length !== 3) {
        throw new Error(`Could not parse referenced table "${ref}".`);
      }
      let [proj, ds, tbl] = parts;
      if (proj !== this.#scopedProjectId) {
        throw new Error(
          `Query references project "${proj}" but this connection is scoped to ` +
          `"${this.#scopedProjectId}".`);
      }
      if (this.#scopedDatasetId && ds !== this.#scopedDatasetId) {
        throw new Error(
          `Query references dataset "${proj}.${ds}" but this connection is scoped to ` +
          `"${this.#scopedProjectId}.${this.#scopedDatasetId}".`);
      }
      if (this.#scopedTableId && tbl !== this.#scopedTableId) {
        throw new Error(
          `Query references table "${ref}" but this connection is scoped to ` +
          `"${this.#scopedProjectId}.${this.#scopedDatasetId}.${this.#scopedTableId}".`);
      }
    }
  }

  #assertReadOnlyEstimate(estimate: {
    statementType?: string;
    ddlOperationPerformed?: string;
    hasScript: boolean;
    hasDmlStats: boolean;
    referencedRoutines?: string[];
  }): void {
    if (estimate.hasScript || estimate.statementType === "SCRIPT") {
      throw new Error("Only single-statement read-only SELECT queries are allowed.");
    }
    if (estimate.ddlOperationPerformed) {
      throw new Error("DDL statements are not allowed.");
    }
    if (estimate.hasDmlStats) {
      throw new Error("DML statements are not allowed.");
    }
    // Allowlist (fail-closed): require an explicit SELECT statementType. BigQuery's dry-run
    // doesn't always populate statementType for every form, so a missing value should be
    // treated as "unknown" and rejected — not assumed safe just because the explicit DDL/DML
    // guards above didn't trip.
    if (!estimate.statementType) {
      throw new Error(
        "BigQuery dry run did not report a statement type; refusing to execute.");
    }
    if (estimate.statementType !== "SELECT") {
      throw new Error(
        `Only read-only SELECT queries are allowed (got ${estimate.statementType}).`);
    }
    if (estimate.referencedRoutines && estimate.referencedRoutines.length > 0) {
      throw new Error(
        "Queries that reference routines are not allowed because their data access cannot " +
        "be scoped by referencedTables.");
    }
  }

  // --- API ---------------------------------------------------------------

  async query(sql: string, opts?: BigQueryQueryOptions): Promise<BigQueryQueryResult> {
    let billingProject = this.#billingProject();
    let defaultDataset = this.#effectiveDataset(opts);
    let maxBytes = opts?.maximumBytesBilled ?? DEFAULT_MAX_BYTES_BILLED;

    // Always dry-run first to enforce scope and get a cost estimate. Dry-runs are free
    // (BigQuery doesn't bill for them), and the response includes `referencedTables`
    // parsed by Google's own SQL engine — the only reliable way to check scope on
    // arbitrary SQL.
    let estimate = await this.#api.dryRun(billingProject, sql, {
      defaultDataset, params: opts?.params,
    });
    this.#assertReadOnlyEstimate(estimate);
    this.#checkScopedTables(estimate.referencedTables);
    if (estimate.bytesProcessed > maxBytes) {
      throw new Error(
        `Query would process ${(estimate.bytesProcessed / 1e9).toFixed(2)} GB, exceeding the ` +
        `limit of ${(maxBytes / 1e9).toFixed(2)} GB. Pass a higher \`maximumBytesBilled\` to ` +
        `override.`);
    }

    let preview = sql.replace(/\s+/g, " ").trim().slice(0, 200);
    await this.#authorizeDatasets(
      BigQuerySessionImpl.#datasetsFromReferencedTables(estimate.referencedTables), {
      title: `BigQuery query: ${preview}`,
      description:
        `SQL preview: \`${preview}\`${sql.length > preview.length ? "..." : ""}\n` +
        (defaultDataset ? `Default dataset: \`${defaultDataset}\`\n` : "") +
        `Billing project: \`${billingProject}\`\n` +
        `Referenced tables: ${estimate.referencedTables.join(", ")}\n` +
        `Estimated bytes processed: ${estimate.bytesProcessed.toLocaleString()}\n` +
        `Maximum bytes billed: ${maxBytes.toLocaleString()}.`,
      containsRestrictedData: true,
    });

    let result = await this.#api.query(billingProject, sql, {
      ...opts,
      defaultDataset,
      maximumBytesBilled: maxBytes,
    });

    return result;
  }

  async dryRun(
    sql: string,
    opts?: Pick<BigQueryQueryOptions, "defaultDataset" | "params">,
  ): Promise<BigQueryDryRunResult> {
    let billingProject = this.#billingProject();
    let defaultDataset = this.#effectiveDataset(opts);

    let estimate = await this.#api.dryRun(billingProject, sql, {
      defaultDataset, params: opts?.params,
    });
    this.#assertReadOnlyEstimate(estimate);
    this.#checkScopedTables(estimate.referencedTables);

    let preview = sql.replace(/\s+/g, " ").trim().slice(0, 100);
    await this.#authorizeDatasets(
      BigQuerySessionImpl.#datasetsFromReferencedTables(estimate.referencedTables), {
      title: `BigQuery dry run: ${preview}`,
      description:
        `Estimated bytes processed: ${estimate.bytesProcessed.toLocaleString()}\n` +
        `Referenced tables: ${estimate.referencedTables.join(", ") || "(none)"}`,
      containsRestrictedData: true,
    });

    return estimate;
  }

  async getProject(): Promise<BigQueryProject> {
    let result: BigQueryProject = { projectId: this.#scopedProjectId! };
    // Echoes the project id the Gadget was bound to — reveals no dataset data, so no attribution.
    await this.#authorizeDatasets([], {
      title: "Get BigQuery project",
      description: `Returned the scoped project: \`${this.#scopedProjectId}\`.`,
      containsRestrictedData: true,
    });
    return result;
  }

  async listDatasets(projectId?: string): Promise<BigQueryDataset[]> {
    if (this.#scopedProjectId && projectId && projectId !== this.#scopedProjectId) {
      throw new Error(
        `Cannot list datasets in "${projectId}" — this connection is scoped to ` +
        `"${this.#scopedProjectId}".`);
    }
    let p = this.#scopedProjectId ?? projectId;
    if (!p) {
      throw new Error("listDatasets requires a projectId when the session is unscoped.");
    }

    if (this.#scopedDatasetId) {
      let dataset = await this.#api.getDataset(p, this.#scopedDatasetId);
      await this.#authorizeDatasets([{ projectId: p, datasetId: this.#scopedDatasetId }], {
        title: `List datasets in ${p}`,
        description: `Returned scoped dataset \`${p}.${this.#scopedDatasetId}\` (1 dataset).`,
        containsRestrictedData: true,
      });
      return [dataset];
    }

    let result = await this.#api.listDatasets(p);
    // Listing reveals each dataset's existence/name, so attribute to all of them.
    await this.#authorizeDatasets(result.map(ds => ({ projectId: p, datasetId: ds.datasetId })), {
      title: `List datasets in ${p}`,
      description: `Listed ${result.length} dataset(s) in \`${p}\`.`,
      containsRestrictedData: true,
    });
    return result;
  }

  async listTables(datasetId?: string, projectId?: string): Promise<BigQueryTable[]> {
    if (this.#scopedProjectId && projectId && projectId !== this.#scopedProjectId) {
      throw new Error(
        `Cannot list tables in project "${projectId}" — this connection is scoped to ` +
        `"${this.#scopedProjectId}".`);
    }
    if (this.#scopedDatasetId && datasetId && datasetId !== this.#scopedDatasetId) {
      throw new Error(
        `Cannot list tables in dataset "${datasetId}" — this connection is scoped to ` +
        `"${this.#scopedDatasetId}".`);
    }
    let p = this.#scopedProjectId ?? projectId;
    let d = this.#scopedDatasetId ?? datasetId;
    if (!p) throw new Error("listTables requires a projectId when the session is unscoped.");
    if (!d) throw new Error("listTables requires a datasetId when the session is unscoped.");

    if (this.#scopedTableId) {
      let { table } = await this.#api.getTable(p, d, this.#scopedTableId);
      await this.#authorizeDatasets([{ projectId: p, datasetId: d }], {
        title: `List tables in ${p}.${d}`,
        description: `Returned scoped table \`${p}.${d}.${this.#scopedTableId}\` (1 table).`,
        containsRestrictedData: true,
      });
      return [table];
    }

    let result = await this.#api.listTables(p, d);
    await this.#authorizeDatasets([{ projectId: p, datasetId: d }], {
      title: `List tables in ${p}.${d}`,
      description: `Listed ${result.length} table(s) in \`${p}.${d}\`.`,
      containsRestrictedData: true,
    });
    return result;
  }

  async describeTable(
    tableId?: string,
    datasetId?: string,
    projectId?: string,
  ): Promise<{ table: BigQueryTable; schema: BigQueryField[] }> {
    if (this.#scopedProjectId && projectId && projectId !== this.#scopedProjectId) {
      throw new Error(
        `Cannot describe table in project "${projectId}" — this connection is scoped to ` +
        `"${this.#scopedProjectId}".`);
    }
    if (this.#scopedDatasetId && datasetId && datasetId !== this.#scopedDatasetId) {
      throw new Error(
        `Cannot describe table in dataset "${datasetId}" — this connection is scoped to ` +
        `"${this.#scopedDatasetId}".`);
    }
    if (this.#scopedTableId && tableId && tableId !== this.#scopedTableId) {
      throw new Error(
        `Cannot describe table "${tableId}" — this connection is scoped to ` +
        `"${this.#scopedTableId}".`);
    }
    let p = this.#scopedProjectId ?? projectId;
    let d = this.#scopedDatasetId ?? datasetId;
    let t = this.#scopedTableId ?? tableId;
    if (!p) throw new Error("describeTable requires a projectId when the session is unscoped.");
    if (!d) throw new Error("describeTable requires a datasetId when the session is unscoped.");
    if (!t) throw new Error("describeTable requires a tableId when the session is unscoped.");

    let result = await this.#api.getTable(p, d, t);
    await this.#authorizeDatasets([{ projectId: p, datasetId: d }], {
      title: `Describe ${p}.${d}.${t}`,
      description:
        `Described table \`${p}.${d}.${t}\` (${result.schema.length} columns).`,
      containsRestrictedData: true,
    });
    return result;
  }
}
