// Behavior tests for the BigQuery gatekeeper's observer checks: the datasets each read reports as
// subresources, how verifyObserverAccess() answers for them, and what addObserver() still enforces.
// BigQuery is faked at the fetch layer, answering each dataset lookup by the caller's token.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {BigQueryGatekeeperImpl, BigQueryGatekeeperImplProps} from "../../src/google";
import type {TestHooks} from "./worker";

const testEnv = env as unknown as {
  BigQueryGatekeeperImpl: DurableObjectNamespace<BigQueryGatekeeperImpl>;
  UserAccount: DurableObjectNamespace;
  TestHooks: DurableObjectNamespace<TestHooks>;
};

const OWNER_TOKEN = "owner-token";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});

type TableRef = {projectId: string; datasetId: string; tableId: string};

type Observation = {
  title: string;
  subresources?: string[];
  excludeObservers?: string[];
  containsRestrictedData?: boolean;
};

/** What the fake BigQuery answers with, which tests set. */
type BigQueryBackendState = {
  jobs: Array<{projectId: string; operation: string}>;
  statementType: string;
  /** The tables every dry run reports. */
  referencedTables: TableRef[];
  /** The datasets every project lists. */
  datasets: string[];
  /** The datasets each observer token may open, each as `project/dataset`. */
  access: Map<string, string[]>;
  /**
   * Observer dataset lookups, keyed as in `lookups`, that BigQuery refuses with this status and
   * error reason instead of answering by `access`.
   */
  refusals: Map<string, {status: number; reason?: string}>;
  /** Each dataset lookup an observer token made, as `<token> <project>/<dataset>`. */
  lookups: string[];
};

type BigQueryBackend = {
  state: BigQueryBackendState;
  fetch(url: URL, init: RequestInit): Promise<Response>;
};

/**
 * The BigQuery REST API as far as these reads use it. Dataset lookups always answer the owner, and
 * answer an observer only for the datasets `access` grants its token, denying any other with 403
 * `accessDenied` as BigQuery does, unless `refusals` names the lookup.
 */
function bigQueryBackend(): BigQueryBackend {
  const state: BigQueryBackendState = {
    jobs: [], statementType: "SELECT",
    referencedTables: [], datasets: [], access: new Map(), refusals: new Map(), lookups: [],
  };
  const fetchImpl = async (url: URL, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const token = new Headers(init.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "";
    // /bigquery/v2/projects/<project>/...
    const [projectId, ...rest] = url.pathname.split("/").slice(4).map(decodeURIComponent);
    if (method === "POST") state.jobs.push({projectId, operation: rest[0]});
    if (method === "POST" && rest[0] === "jobs") {
      return json({
        status: {state: "DONE"},
        statistics: {query: {
          totalBytesProcessed: "1024", statementType: state.statementType, referencedTables: state.referencedTables,
        }},
      });
    }
    if (method === "POST" && rest[0] === "queries") {
      return json({
        jobComplete: true, jobReference: {projectId, jobId: "job-1"},
        schema: {fields: [{name: "n", type: "INT64"}]}, rows: [{f: [{v: "1"}]}], totalRows: "1",
      });
    }
    if (rest[0] !== "datasets") return json({}, 404);
    const [, datasetId, , tableId] = rest;
    if (datasetId === undefined) {
      return json({datasets: state.datasets.map(id => ({datasetReference: {projectId, datasetId: id}}))});
    }
    if (rest.length === 2) {
      if (token !== OWNER_TOKEN) {
        const lookup = `${token} ${projectId}/${datasetId}`;
        state.lookups.push(lookup);
        const granted = state.access.get(token)?.includes(`${projectId}/${datasetId}`);
        const refusal = state.refusals.get(lookup) ??
            (granted ? undefined : {status: 403, reason: "accessDenied"});
        if (refusal) {
          const {status, reason} = refusal;
          return json({error: {code: status, message: "Refused", errors: reason ? [{reason}] : []}}, status);
        }
      }
      return json({datasetReference: {projectId, datasetId}});
    }
    const table = (id: string) => ({
      tableReference: {projectId, datasetId, tableId: id}, type: "TABLE",
      schema: {fields: [{name: "id", type: "STRING"}]},
    });
    return tableId === undefined ? json({tables: [table("orders"), table("refunds")]}) : json(table(tableId));
  };
  return {state, fetch: fetchImpl};
}

function bigQueryHarness(
    backend: BigQueryBackend, scope: Omit<BigQueryGatekeeperImplProps, "userObjectId">,
) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) =>
    backend.fetch(new URL(typeof input === "string" || input instanceof URL ? input : input.url), init));
  const name = `bigquery-test-${crypto.randomUUID()}`;
  const hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  const id = testEnv.BigQueryGatekeeperImpl.idFromName(name).toString();
  const facetName = `bigquery-${name}`;
  const queueId = `queue-${name}`;
  /** A connected Google account whose stored access token is `token`. */
  const account = async (token: string): Promise<string> => {
    const accountId = testEnv.UserAccount.idFromName(`${name}-${token}`);
    await runInDurableObject(testEnv.UserAccount.get(accountId), (_instance: unknown, state: DurableObjectState) => {
      state.storage.kv.put("refreshToken", `${token}-refresh`);
      state.storage.kv.put("accessToken", {token, expires: new Date(Date.now() + 3_600_000)});
    });
    return accountId.toString();
  };
  const props = account(OWNER_TOKEN).then(async userObjectId => {
    const bindingProps: BigQueryGatekeeperImplProps = {userObjectId, ...scope};
    await hook.bigQueryStartSession(facetName, id, bindingProps, queueId);
    return bindingProps;
  });
  return {
    session: async () => hook.openBigQuerySession(facetName, id, await props, queueId),
    /** An observer's account, which BigQuery lets open `datasets` (each `project/dataset`). */
    observer: (token: string, datasets: string[]): Promise<string> => {
      backend.state.access.set(token, datasets);
      return account(token);
    },
    addObserver: async (observerId: string, userObjectId: string) =>
      hook.bigQueryAddObserver(facetName, id, await props, queueId, observerId, userObjectId),
    verify: async (observers: Array<{id: string; userObjectId: string}>, subresources: string[]) =>
      hook.bigQueryVerifyObserverAccess(facetName, id, await props, observers, subresources),
    recordLegacyDataset: async (encoded: string) =>
      hook.bigQueryApplyStorage(facetName, id, await props, [{
        kind: "put", key: `observedDataset:${encoded}`, value: "observed",
      }]),
    observations: async (): Promise<Observation[]> => {
      const {observations} = await runInDurableObject(hook, (instance: TestHooks) => instance.readQueue(queueId));
      return observations as Observation[];
    },
    /** The subresources each observation reported, checking that each still marks restricted data. */
    reported: async (): Promise<Array<string[] | undefined>> => {
      const {observations} = await runInDurableObject(hook, (instance: TestHooks) => instance.readQueue(queueId));
      return (observations as Observation[]).map(observation => {
        expect(observation.containsRestrictedData).toBe(true);
        return observation.subresources;
      });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BigQuery observations", () => {
  it("report each dataset a query or dry run references once, excluding nobody", async () => {
    const backend = bigQueryBackend();
    const bigQuery = bigQueryHarness(backend, {scopedProjectId: "corp:analytics"});
    // A viewer who can open none of these datasets. The legacy tracker would exclude them, and the
    // queue refuses an observation that excludes an active observer.
    await bigQuery.addObserver("viewer", await bigQuery.observer("viewer-token", []));
    using session = await bigQuery.session();
    backend.state.referencedTables = [
      {projectId: "corp:analytics", datasetId: "sales", tableId: "orders"},
      {projectId: "corp:analytics", datasetId: "sales", tableId: "refunds"},
      {projectId: "corp:analytics", datasetId: "web", tableId: "visits"},
    ];
    const sql = "SELECT * FROM sales.orders JOIN sales.refunds USING (id) JOIN web.visits USING (id)";
    expect(await session.query(sql)).toMatchObject({rows: [{n: "1"}]});
    await session.dryRun(sql);
    backend.state.referencedTables = [];
    await session.query("SELECT 1");
    await session.dryRun("SELECT 1");

    const both = [
      "bigquery/project/corp%3Aanalytics/dataset/sales", "bigquery/project/corp%3Aanalytics/dataset/web",
    ];
    expect(await bigQuery.reported()).toEqual([both, both, [], []]);
    for (const observation of await bigQuery.observations()) {
      expect(observation.excludeObservers).toBeUndefined();
    }
  });

  it("report every dataset a project listing shows, but only the bound one on a dataset binding", async () => {
    const backend = bigQueryBackend();
    backend.state.datasets = ["sales", "web"];
    const project = bigQueryHarness(backend, {scopedProjectId: "example.com:warehouse"});
    using projectSession = await project.session();
    expect(await projectSession.listDatasets()).toHaveLength(2);
    const dataset = bigQueryHarness(backend, {scopedProjectId: "example.com:warehouse", scopedDatasetId: "sales"});
    using datasetSession = await dataset.session();
    expect(await datasetSession.listDatasets()).toMatchObject([{datasetId: "sales"}]);

    expect(await project.reported()).toEqual([[
      "bigquery/project/example.com%3Awarehouse/dataset/sales",
      "bigquery/project/example.com%3Awarehouse/dataset/web",
    ]]);
    expect(await dataset.reported()).toEqual([["bigquery/project/example.com%3Awarehouse/dataset/sales"]]);
  });

  it("attribute table listings and descriptions to their dataset, on a table binding too", async () => {
    const backend = bigQueryBackend();
    const project = bigQueryHarness(backend, {scopedProjectId: "proj"});
    using projectSession = await project.session();
    expect(await projectSession.listTables("sales")).toHaveLength(2);
    await projectSession.describeTable("orders", "sales");
    const table = bigQueryHarness(backend, {scopedProjectId: "proj", scopedDatasetId: "sales", scopedTableId: "orders"});
    using tableSession = await table.session();
    expect(await tableSession.listTables()).toMatchObject([{tableId: "orders"}]);
    expect(await tableSession.describeTable()).toMatchObject({schema: [{name: "id"}]});

    const sales = ["bigquery/project/proj/dataset/sales"];
    expect(await project.reported()).toEqual([sales, sales]);
    expect(await table.reported()).toEqual([sales, sales]);
  });

  it("report nothing for the bound project", async () => {
    const bigQuery = bigQueryHarness(bigQueryBackend(), {scopedProjectId: "proj"});
    using session = await bigQuery.session();
    expect(await session.getProject()).toEqual({projectId: "proj"});
    expect(await bigQuery.reported()).toEqual([[]]);
  });
});

describe("BigQuery verifyObserverAccess", () => {
  const sales = "bigquery/project/proj/dataset/sales";
  const web = "bigquery/project/proj/dataset/web";

  it("allows only the observers who can open every dataset", async () => {
    const bigQuery = bigQueryHarness(bigQueryBackend(), {scopedProjectId: "proj"});
    const observers = [
      {id: "both", userObjectId: await bigQuery.observer("both-token", ["proj/sales", "proj/web"])},
      {id: "sales-only", userObjectId: await bigQuery.observer("sales-token", ["proj/sales"])},
      {id: "neither", userObjectId: await bigQuery.observer("neither-token", [])},
    ];
    expect(await bigQuery.verify(observers, [sales, web])).toEqual({allowedObserverIds: ["both"]});
    expect(await bigQuery.verify(observers, [sales])).toEqual({allowedObserverIds: ["both", "sales-only"]});
  });

  it("checks datasets one at a time when parallel lookups would hit a rate limit", async () => {
    const backend = bigQueryBackend();
    const fetch = backend.fetch;
    let inFlight = false;
    backend.fetch = async (url, init) => {
      if (inFlight) {
        return json({error: {code: 403, errors: [{reason: "rateLimitExceeded"}]}}, 403);
      }
      inFlight = true;
      try {
        await scheduler.wait(1);
        return await fetch(url, init);
      } finally {
        inFlight = false;
      }
    };
    const bigQuery = bigQueryHarness(backend, {scopedProjectId: "proj"});
    const observers = [
      {id: "analyst", userObjectId: await bigQuery.observer("analyst-token", ["proj/sales", "proj/web"])},
    ];

    expect(await bigQuery.verify(observers, [sales, web])).toEqual({allowedObserverIds: ["analyst"]});
  });

  it("reuses an account's recent answers, asking BigQuery only about datasets it hasn't", async () => {
    const backend = bigQueryBackend();
    const bigQuery = bigQueryHarness(backend, {scopedProjectId: "proj"});
    const observers = [{id: "analyst", userObjectId: await bigQuery.observer("analyst-token", ["proj/sales"])}];
    expect(await bigQuery.verify(observers, [sales])).toEqual({allowedObserverIds: ["analyst"]});
    expect(await bigQuery.verify(observers, [sales, web])).toEqual({allowedObserverIds: []});
    expect(await bigQuery.verify(observers, [sales, web])).toEqual({allowedObserverIds: []});
    expect(backend.state.lookups).toEqual(["analyst-token proj/sales", "analyst-token proj/web"]);
  });

  it("refuses the whole call for an ID that does not name a BigQuery dataset", async () => {
    const bigQuery = bigQueryHarness(bigQueryBackend(), {scopedProjectId: "proj"});
    const observers = [{id: "viewer", userObjectId: await bigQuery.observer("viewer-token", ["proj/sales"])}];
    for (const id of [
      "bigquery/project/proj/dataset/sa%6Ces",
      "drive/project/proj/dataset/sales",
      "project/proj/dataset/sales",
      "bigquery/project/proj/table/sales",
      "bigquery/dataset/sales/project/proj",
      "bigquery/project/proj",
      "bigquery/project/proj/dataset/sales/table/orders",
      // Another Google gatekeeper's ID, which the observer's account could check.
      "calendar/freeBusy/alice%40example.com",
    ]) {
      await expect(bigQuery.verify(observers, [sales, id]), id).rejects.toThrow(/subresource ID/);
    }
  });

  it("fails the whole call when a verifier cannot tell", async () => {
    const backend = bigQueryBackend();
    const bigQuery = bigQueryHarness(backend, {scopedProjectId: "proj"});
    const observers = [
      {id: "viewer", userObjectId: await bigQuery.observer("viewer-token", ["proj/sales"])},
      {id: "flaky", userObjectId: await bigQuery.observer("flaky-token", ["proj/sales"])},
    ];
    backend.state.refusals.set("flaky-token proj/sales", {status: 500});
    await expect(bigQuery.verify(observers, [sales])).rejects.toThrow(/http=500/);
  });

  it("denies an observer a dataset BigQuery doesn't hold", async () => {
    const backend = bigQueryBackend();
    const bigQuery = bigQueryHarness(backend, {scopedProjectId: "proj"});
    const observers = [{id: "analyst", userObjectId: await bigQuery.observer("analyst-token", ["proj/sales"])}];
    backend.state.refusals.set("analyst-token proj/sales", {status: 404, reason: "notFound"});
    expect(await bigQuery.verify(observers, [sales])).toEqual({allowedObserverIds: []});
  });

  it("throws for a refusal other than a denial, and asks BigQuery again next time", async () => {
    const backend = bigQueryBackend();
    const bigQuery = bigQueryHarness(backend, {scopedProjectId: "proj"});
    const observers = [{id: "analyst", userObjectId: await bigQuery.observer("analyst-token", ["proj/sales"])}];
    // BigQuery answers a rate limit with 403 too, which says nothing about the analyst's access.
    backend.state.refusals.set("analyst-token proj/sales", {status: 403, reason: "rateLimitExceeded"});
    await expect(bigQuery.verify(observers, [sales])).rejects.toThrow(/http=403.*rateLimitExceeded/);

    backend.state.refusals.clear();
    expect(await bigQuery.verify(observers, [sales])).toEqual({allowedObserverIds: ["analyst"]});
    expect(backend.state.lookups).toEqual(["analyst-token proj/sales", "analyst-token proj/sales"]);
  });

  it("keeps the answers it got when another dataset's lookup fails", async () => {
    const backend = bigQueryBackend();
    const bigQuery = bigQueryHarness(backend, {scopedProjectId: "proj"});
    const observers = [
      {id: "analyst", userObjectId: await bigQuery.observer("analyst-token", ["proj/sales", "proj/web"])},
    ];
    backend.state.refusals.set("analyst-token proj/web", {status: 500});
    await expect(bigQuery.verify(observers, [sales, web])).rejects.toThrow(/http=500/);

    backend.state.refusals.clear();
    expect(await bigQuery.verify(observers, [sales, web])).toEqual({allowedObserverIds: ["analyst"]});
    expect(backend.state.lookups.toSorted())
      .toEqual(["analyst-token proj/sales", "analyst-token proj/web", "analyst-token proj/web"]);
  });
});

describe("BigQuery addObserver", () => {
  it("still enforces the datasets reads recorded before reporting subresources, and only those", async () => {
    const backend = bigQueryBackend();
    const bigQuery = bigQueryHarness(backend, {scopedProjectId: "proj"});
    await bigQuery.recordLegacyDataset("proj/sales");
    // This read reveals web, which no longer joins the history addObserver() checks.
    backend.state.referencedTables = [{projectId: "proj", datasetId: "web", tableId: "visits"}];
    using session = await bigQuery.session();
    await session.query("SELECT * FROM web.visits");

    await expect(bigQuery.addObserver("outsider", await bigQuery.observer("outsider-token", ["proj/web"])))
      .rejects.toThrow("does not have access to the BigQuery dataset `proj.sales`");
    await bigQuery.addObserver("analyst", await bigQuery.observer("analyst-token", ["proj/sales"]));
  });

  it("asks BigQuery afresh about recorded datasets, whatever verifyObserverAccess last learned", async () => {
    const backend = bigQueryBackend();
    const bigQuery = bigQueryHarness(backend, {scopedProjectId: "proj"});
    await bigQuery.recordLegacyDataset("proj/sales");
    const analyst = await bigQuery.observer("analyst-token", ["proj/sales"]);
    expect(await bigQuery.verify([{id: "analyst", userObjectId: analyst}], ["bigquery/project/proj/dataset/sales"]))
      .toEqual({allowedObserverIds: ["analyst"]});

    backend.state.access.set("analyst-token", []);
    await expect(bigQuery.addObserver("analyst", analyst))
      .rejects.toThrow("does not have access to the BigQuery dataset `proj.sales`");
  });

  it("propagates a recorded dataset's rate-limit error instead of reporting access denied", async () => {
    const backend = bigQueryBackend();
    const bigQuery = bigQueryHarness(backend, {scopedProjectId: "proj"});
    await bigQuery.recordLegacyDataset("proj/sales");
    const analyst = await bigQuery.observer("analyst-token", ["proj/sales"]);
    backend.state.refusals.set("analyst-token proj/sales", {status: 403, reason: "rateLimitExceeded"});

    await expect(bigQuery.addObserver("analyst", analyst)).rejects.toThrow(/http=403.*rateLimitExceeded/);
  });
});


describe("BigQuery query project independent of data scope", () => {
  it("allows existing project-only connections to query across projects without listing", async () => {
    const backend = bigQueryBackend();
    backend.state.referencedTables = [{projectId: "netstrat-analysis", datasetId: "prometheus_aggregates", tableId: "cpu"}];
    const bigQuery = bigQueryHarness(backend, {scopedProjectId: "query-project"});
    using session = await bigQuery.session();
    const sql = "SELECT * FROM `netstrat-analysis.prometheus_aggregates.cpu`";
    expect(await session.query(sql)).toMatchObject({rows: [{n: "1"}]});
    await session.dryRun(sql);
    expect(backend.state.jobs).toEqual([
      {projectId: "query-project", operation: "jobs"},
      {projectId: "query-project", operation: "queries"},
      {projectId: "query-project", operation: "jobs"},
    ]);
    await session.describeTable("cpu", "prometheus_aggregates", "netstrat-analysis");
    const source = ["bigquery/project/netstrat-analysis/dataset/prometheus_aggregates"];
    expect(await bigQuery.reported()).toEqual([source, source, source]);
    expect(await session.getProject()).toEqual({projectId: "query-project"});
    backend.state.datasets = ["prometheus_aggregates"];
    expect(await session.listDatasets("netstrat-analysis"))
      .toMatchObject([{projectId: "netstrat-analysis", datasetId: "prometheus_aggregates"}]);
    expect(await session.listDatasets())
      .toMatchObject([{projectId: "query-project", datasetId: "prometheus_aggregates"}]);
    expect(await session.listTables("prometheus_aggregates", "netstrat-analysis"))
      .toMatchObject([{projectId: "netstrat-analysis"}, {projectId: "netstrat-analysis"}]);
    const observers = [
      {id: "reader", userObjectId: await bigQuery.observer("reader-token", ["netstrat-analysis/prometheus_aggregates"])},
      {id: "outsider", userObjectId: await bigQuery.observer("outsider-token", ["query-project/other"])},
    ];
    expect(await bigQuery.verify(observers, source)).toEqual({allowedObserverIds: ["reader"]});
  });

  it.each([
    {scopedProjectId: "query-project", scopedDatasetId: "sales"},
    {scopedProjectId: "query-project", scopedDatasetId: "sales", scopedTableId: "orders"},
  ])("preserves dataset and table project restrictions: %o", async scope => {
    const backend = bigQueryBackend();
    backend.state.referencedTables = [{projectId: "elsewhere", datasetId: "sales", tableId: "orders"}];
    const bigQuery = bigQueryHarness(backend, scope);
    using session = await bigQuery.session();
    await expect(Promise.resolve(session.query("SELECT * FROM `elsewhere.sales.orders`")))
      .rejects.toThrow("Query references project");
    expect(backend.state.jobs).toHaveLength(1);
    await expect(Promise.resolve(session.describeTable("orders", "sales", "elsewhere"))).rejects.toThrow("scoped to");
  });

  it("keeps read-only and cost guards on cross-project queries", async () => {
    const backend = bigQueryBackend();
    backend.state.referencedTables = [{projectId: "elsewhere", datasetId: "sales", tableId: "orders"}];
    const bigQuery = bigQueryHarness(backend, {scopedProjectId: "query-project"});
    using session = await bigQuery.session();
    backend.state.statementType = "DELETE";
    await expect(Promise.resolve(session.query("DELETE FROM `elsewhere.sales.orders` WHERE true")))
      .rejects.toThrow("Only read-only SELECT");
    backend.state.statementType = "SELECT";
    await expect(Promise.resolve(session.query("SELECT * FROM `elsewhere.sales.orders`", {maximumBytesBilled: 1})))
      .rejects.toThrow("exceeding");
    expect(backend.state.jobs.every(job => job.operation === "jobs")).toBe(true);
  });

  it("still rejects out-of-scope datasets and tables", async () => {
    const backend = bigQueryBackend();
    const bigQuery = bigQueryHarness(backend, {scopedProjectId: "proj", scopedDatasetId: "sales", scopedTableId: "orders"});
    using session = await bigQuery.session();
    backend.state.referencedTables = [{projectId: "proj", datasetId: "other", tableId: "orders"}];
    await expect(Promise.resolve(session.query("SELECT * FROM other.orders"))).rejects.toThrow("Query references dataset");
    backend.state.referencedTables = [{projectId: "proj", datasetId: "sales", tableId: "other"}];
    await expect(Promise.resolve(session.query("SELECT * FROM sales.other"))).rejects.toThrow("Query references table");
  });
});
