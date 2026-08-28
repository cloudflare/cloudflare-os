// A query whose dry run references no tables must be refused: it still executes with the owner's
// token and can return session/owner context (`SESSION_USER()`, `@@project_id`) that no dataset
// probe can verify an observer against — an empty tracked set would admit any verifier without a
// single probe. `#checkScopedTables` is the single chokepoint behind both query() and dryRun().
//
// Runs under plain vitest with the `cloudflare:workers` / `capnweb-validate` stubs (see
// vitest.config.ts), so the session is constructed directly around fakes.

import { describe, expect, it } from "vitest";
import { BigQuerySessionImpl, type BigQueryDatasetRef } from "../src/bigquery-session";
import type { BigQueryDryRunResult } from "../src/bigquery-types";
import type { ObserverCheck } from "../src/observers";

function makeSession(opts: { referencedTables: string[] }) {
  let estimate = {
    bytesProcessed: 0,
    referencedTables: opts.referencedTables,
    referencedRoutines: [],
    schema: [],
    // What #assertReadOnlyEstimate reads beyond the declared result type.
    statementType: "SELECT",
    hasScript: false,
    hasDmlStats: false,
  };
  let queries: string[] = [];
  let api = {
    dryRun: async (): Promise<BigQueryDryRunResult> => estimate,
    query: async (_project: string, sql: string) => {
      queries.push(sql);
      return { rows: [], totalRows: 0, schema: [], jobComplete: true };
    },
  } as any;

  let observations: { title: string; containsRestrictedData?: boolean }[] = [];
  let approvalQueue = {
    authorizeObservation: async (description: any) => { observations.push(description); },
  } as any;

  let observed: BigQueryDatasetRef[][] = [];
  let committed = 0;
  let observe = async (datasets: BigQueryDatasetRef[]): Promise<ObserverCheck<BigQueryDatasetRef>> => {
    observed.push(datasets);
    return { pendingSets: datasets, commit: () => { committed++; } };
  };

  let session = new BigQuerySessionImpl(
    api,
    approvalQueue,
    "p",
    undefined,
    undefined,
    observe,
  );
  return { session, queries, observations, observed, committed: () => committed };
}

describe("table-free queries are refused", () => {
  it("query() rejects on a project-only session without observing or executing", async () => {
    let { session, queries, observations } = makeSession({ referencedTables: [] });
    await expect(session.query("SELECT SESSION_USER()"))
        .rejects.toThrow(/[Rr]eference at least one table/);
    expect(observations).toHaveLength(0);
    expect(queries).toHaveLength(0);
  });

  it("dryRun() rejects on a project-only session without observing", async () => {
    let { session, observations } = makeSession({ referencedTables: [] });
    await expect(session.dryRun("SELECT SESSION_USER()"))
        .rejects.toThrow(/[Rr]eference at least one table/);
    expect(observations).toHaveLength(0);
  });
});

describe("queries that reference a table still proceed", () => {
  it("query() attributes the read to the referenced dataset and authorizes it", async () => {
    let { session, queries, observations, observed, committed } =
        makeSession({ referencedTables: ["p.d.t"] });
    await session.query("SELECT x FROM `p.d.t`");

    expect(observed).toEqual([[{ projectId: "p", datasetId: "d" }]]);
    expect(observations).toHaveLength(1);
    expect(observations[0].containsRestrictedData).toBe(true);
    expect(committed()).toBe(1);
    expect(queries).toHaveLength(1);
  });
});
