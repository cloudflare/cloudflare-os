// The BigQuery configurator in a stand-in for the sandbox runtime: how it lists what the gatekeeper
// answers, when it asks for a project to run queries in, and the URL it mints.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BigQueryNode, BigQueryNodePage } from "../src/configurator/bigquery-configurator-types";
import { nodes } from "./configurator-tree";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({
    component, props: props ?? {}, children,
  }),
  Autocomplete: "Autocomplete",
  Field: "Field",
  HierarchyPicker: "HierarchyPicker",
  Section: "Section",
}));

const MINE: BigQueryNode = { id: "project:mine", kind: "project", title: "mine", subtitle: "My project", listed: true };
const SHARED_PROJECT: BigQueryNode = { id: "project:theirs", kind: "project", title: "theirs", listed: false };
const SHARED_DATASET: BigQueryNode = {
  id: "dataset:theirs/events", kind: "dataset", title: "events", listed: false,
  path: [{ id: "project:theirs", kind: "project", title: "theirs" }],
};
const VIEW: BigQueryNode = {
  id: "table:mine/sales/daily", kind: "table", title: "daily", subtitle: "View", view: true, listed: true,
  path: [{ id: "project:mine", kind: "project", title: "mine" }, { id: "dataset:mine/sales", kind: "dataset", title: "sales" }],
};

type Values = { target?: string | null; queryProject?: string | null };

/** A fresh module, since it remembers which projects are listed at module level, and its frame. */
async function open(initial: Values = {}) {
  vi.resetModules();
  const spec = (await import("../src/configurator/bigquery-configurator-ui")).default as unknown as {
    initial: Values;
    isReady(context: { values: Values }): boolean;
    resourceUrl(context: { values: Values; ui: unknown }): string;
    initialValuesFromResourceUrl(context: { resourceUrl: string; resourceUrlPattern: string; ui: unknown }): Values;
    render(context: unknown): unknown;
  };
  let values: Values = { ...spec.initial, ...initial };
  const ui = {
    listNodes: vi.fn(async (): Promise<BigQueryNodePage> => ({ nodes: [] })),
    getNode: vi.fn(async (): Promise<BigQueryNode | null> => null),
    listProjects: vi.fn(async () => [{ value: "mine", title: "mine" }, { value: "other", title: "other" }]),
  };
  const setValues = vi.fn((patch: Values) => { values = { ...values, ...patch }; });
  const clearFields = vi.fn();
  const find = (component: string) => nodes(spec.render({ values, setValues, clearFields, ensureResources: vi.fn(), ui }))
    .filter(node => node.component === component);
  return {
    spec, ui, setValues, clearFields,
    values: () => values,
    picker: () => find("HierarchyPicker")[0]!.props,
    fields: () => find("Field").map(node => node.props.label as string),
    autocomplete: () => find("Autocomplete")[0]?.props,
    list: (parentId: string, query = "") => find("HierarchyPicker")[0]!.props.loadItems({ parentId, query, cursor: null }),
    load: (id: string) => find("HierarchyPicker")[0]!.props.loadItem(id),
    ready: () => spec.isReady({ values }),
    url: () => spec.resourceUrl({ values, ui }),
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe("listing", () => {
  it("lists projects and datasets as containers offering everything in them, and tables as leaves", async () => {
    const frame = await open();
    frame.ui.listNodes.mockResolvedValueOnce({ nodes: [MINE, SHARED_PROJECT] });
    const { items } = await frame.list("bigquery");
    expect(items).toMatchObject([
      { id: "project:mine", kind: "container", icon: "project", subtitle: "My project", badge: undefined, choice: { subtitle: expect.stringContaining("Every dataset") } },
      { id: "project:theirs", kind: "container", badge: "Shared" },
    ]);
    frame.ui.listNodes.mockResolvedValueOnce({ nodes: [VIEW] });
    const { items: tables } = await frame.list("dataset:mine/sales");
    expect(tables).toMatchObject([{
      id: "table:mine/sales/daily", kind: "leaf", icon: "view", subtitle: "View", choice: undefined,
      path: [{ id: "project:mine", title: "mine", selectable: true }, { id: "dataset:mine/sales", title: "sales", selectable: true }],
    }]);
    expect(frame.ui.listNodes).toHaveBeenCalledWith("bigquery", "", null);
  });

  it("passes a search or pasted link through, and a notice back", async () => {
    const frame = await open();
    frame.ui.listNodes.mockResolvedValueOnce({ nodes: [], notice: "Nothing there." });
    await expect(frame.list("bigquery", "https://console.cloud.google.com/bigquery?p=theirs&d=events"))
      .resolves.toEqual({ items: [], notice: "Nothing there." });
    expect(frame.ui.listNodes).toHaveBeenLastCalledWith("bigquery", "https://console.cloud.google.com/bigquery?p=theirs&d=events", null);
    frame.ui.listNodes.mockResolvedValueOnce({ nodes: [MINE], nextCursor: "100" });
    await expect(frame.list("bigquery")).resolves.toMatchObject({ nextCursor: "100" });
  });

  it("keeps a looked-up table in view when its dataset cannot be listed", async () => {
    const frame = await open({ target: "table:theirs/events/clicks" });
    const clicks: BigQueryNode = {
      id: "table:theirs/events/clicks", kind: "table", title: "clicks", listed: false,
      path: [{ id: "project:theirs", kind: "project", title: "theirs" }, { id: "dataset:theirs/events", kind: "dataset", title: "events" }],
    };
    frame.ui.getNode.mockResolvedValueOnce(clicks);
    await frame.load(clicks.id);
    frame.ui.listNodes.mockRejectedValue(new Error("BigQuery API error: 403"));
    await expect(frame.list("dataset:theirs/events")).resolves.toMatchObject({
      items: [{ id: clicks.id, kind: "leaf" }], notice: expect.stringContaining("shared with you"),
    });
    // Elsewhere, and in a search, the failure is the picker's to show.
    await expect(frame.list("project:theirs")).rejects.toThrow("403");
    await expect(frame.list("dataset:theirs/events", "cli")).rejects.toThrow("403");
  });
});

describe("the query project", () => {
  it("is not asked for in a project the account holds a role in", async () => {
    const frame = await open();
    frame.ui.listNodes.mockResolvedValueOnce({ nodes: [MINE] });
    await frame.list("bigquery");
    frame.picker().onChange("project:mine", null);
    expect(frame.values()).toEqual({ target: "project:mine", queryProject: null });
    expect(frame.fields()).toEqual(["What to connect"]);
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe("https://bigquery.googleapis.com/mine/");
  });

  it("is asked for, and required, in a shared project, offering the account's only project", async () => {
    const frame = await open();
    frame.ui.listProjects.mockResolvedValue([{ value: "mine", title: "mine" }]);
    frame.ui.listNodes.mockResolvedValueOnce({ nodes: [SHARED_DATASET] });
    await frame.list("project:theirs");
    frame.picker().onChange("dataset:theirs/events", null);
    expect(frame.ready()).toBe(false);
    expect(frame.fields()).toEqual(["What to connect", "Run queries in"]);
    expect(frame.autocomplete()).toMatchObject({ name: "queryProject", value: null });
    await vi.waitFor(() => expect(frame.values().queryProject).toBe("mine"));
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe("https://bigquery.googleapis.com/theirs/events?queryProject=mine");
  });

  it("is chosen by the user when the account has several projects, and dropped on leaving the shared project", async () => {
    const frame = await open();
    frame.ui.listNodes.mockResolvedValueOnce({ nodes: [SHARED_DATASET, MINE] });
    await frame.list("bigquery");
    frame.picker().onChange("dataset:theirs/events", null);
    await Promise.resolve();
    expect(frame.values().queryProject).toBeNull();
    expect(frame.ready()).toBe(false);
    frame.autocomplete().onChange("other");
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe("https://bigquery.googleapis.com/theirs/events?queryProject=other");
    // Another choice in the same project keeps it; one in a project of the account's own drops it.
    frame.clearFields.mockClear();
    frame.picker().onChange("project:theirs", null);
    expect(frame.values()).toEqual({ target: "project:theirs", queryProject: "other" });
    expect(frame.clearFields).not.toHaveBeenCalled();
    frame.picker().onChange("project:mine", null);
    expect(frame.values()).toEqual({ target: "project:mine", queryProject: null });
    expect(frame.clearFields).toHaveBeenCalledWith("queryProject");
    expect(frame.fields()).toEqual(["What to connect"]);
  });

  it("holds a pre-filled choice back until the lookup says whether its project is the account's", async () => {
    const frame = await open({ target: "dataset:theirs/events", queryProject: "mine" });
    expect(frame.ready()).toBe(false);
    frame.ui.getNode.mockResolvedValueOnce(SHARED_DATASET);
    await expect(frame.load("dataset:theirs/events")).resolves.toMatchObject({ id: "dataset:theirs/events", kind: "container" });
    expect(frame.setValues).toHaveBeenCalledWith({});
    expect(frame.ready()).toBe(true);
  });
});

describe("URLs", () => {
  it("reads a connection's URL back into the choice and its query project", async () => {
    const { spec } = await open();
    const values = (resourceUrl: string) =>
      spec.initialValuesFromResourceUrl({ resourceUrl, resourceUrlPattern: "https://bigquery.googleapis.com/:projectId/*", ui: null });
    expect(values("https://bigquery.googleapis.com/theirs/events?queryProject=mine"))
      .toEqual({ target: "dataset:theirs/events", queryProject: "mine" });
    expect(values("https://bigquery.googleapis.com/example.com%3Awarehouse/sales/orders"))
      .toEqual({ target: "table:example.com:warehouse/sales/orders", queryProject: null });
    expect(values("https://bigquery.googleapis.com/mine/?queryProject=mine")).toEqual({ target: "project:mine", queryProject: null });
    expect(values("https://bigquery.googleapis.com/")).toEqual({});
  });

  it("encodes each segment and refuses to mint one without a choice", async () => {
    const frame = await open({ target: "table:example.com:warehouse/sales/orders" });
    expect(frame.url()).toBe("https://bigquery.googleapis.com/example.com%3Awarehouse/sales/orders");
    const empty = await open();
    expect(() => empty.url()).toThrow("Choose what to connect.");
  });
});
