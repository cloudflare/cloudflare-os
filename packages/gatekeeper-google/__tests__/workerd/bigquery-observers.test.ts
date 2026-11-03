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
  /** The tables every dry run reports. */
  referencedTables: TableRef[];
  /** The datasets every project lists. */
  datasets: string[];
  /** The datasets each observer token may open, each as `project/dataset`. */
  access: Map<string, string[]>;
  /** Observer tokens whose dataset lookups fail as an outage would. */
  failing: Set<string>;
  /** Each dataset lookup an observer token made, as `<token> <project>/<dataset>`. */
  lookups: string[];
};

type BigQueryBackend = {
  state: BigQueryBackendState;
  fetch(url: URL, init: RequestInit): Promise<Response>;
};

/**
 * The BigQuery REST API as far as these reads use it. Dataset lookups always answer the owner, and
 * answer an observer only for the datasets `access` grants its token, failing with 500 for a token
 * in `failing`.
 */
function bigQueryBackend(): BigQueryBackend {
  const state: BigQueryBackendState = {
    referencedTables: [], datasets: [], access: new Map(), failing: new Set(), lookups: [],
  };
  const fetchImpl = async (url: URL, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const token = new Headers(init.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "";
    // /bigquery/v2/projects/<project>/...
    const [projectId, ...rest] = url.pathname.split("/").slice(4).map(decodeURIComponent);
    if (method === "POST" && rest[0] === "jobs") {
      return json({
        status: {state: "DONE"},
        statistics: {query: {
          totalBytesProcessed: "1024", statementType: "SELECT", referencedTables: state.referencedTables,
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
        state.lookups.push(`${token} ${projectId}/${datasetId}`);
        if (state.failing.has(token)) return json({error: {message: "Backend error"}}, 500);
        if (!state.access.get(token)?.includes(`${projectId}/${datasetId}`)) {
          return json({error: {message: "Access Denied"}}, 403);
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
  const props = account(OWNER_TOKEN).then((userObjectId): BigQueryGatekeeperImplProps => ({userObjectId, ...scope}));
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
      hook.bigQueryRecordLegacyDataset(facetName, id, await props, encoded),
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
    backend.state.failing.add("flaky-token");
    await expect(bigQuery.verify(observers, [sales])).rejects.toThrow(/http=500/);
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
});
