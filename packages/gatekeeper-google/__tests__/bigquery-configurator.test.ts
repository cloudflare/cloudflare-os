// The BigQuery configurator in a stand-in for the sandbox runtime: how it lists what the gatekeeper
// answers, when it asks for a project to run queries in, and the URL it mints.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BigQueryNode, BigQueryNodePage } from "../src/configurator/bigquery-configurator-types";
import { nodes, text } from "./configurator-tree";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({
    component, props: props ?? {}, children,
  }),
  Autocomplete: "Autocomplete",
  Button: "Button",
  Field: "Field",
  HierarchyPicker: "HierarchyPicker",
  Section: "Section",
}));

const MINE: BigQueryNode = { id: "project:mine", kind: "project", title: "mine", subtitle: "My project", runsQueries: true };
const SHARED_PROJECT: BigQueryNode = { id: "project:theirs", kind: "project", title: "theirs", runsQueries: false };
const SHARED_DATASET: BigQueryNode = {
  id: "dataset:theirs/events", kind: "dataset", title: "events", runsQueries: false,
  path: [{ id: "project:theirs", kind: "project", title: "theirs" }],
};
const VIEW: BigQueryNode = {
  id: "table:mine/sales/daily", kind: "table", title: "daily", subtitle: "View", view: true, runsQueries: true,
  path: [{ id: "project:mine", kind: "project", title: "mine" }, { id: "dataset:mine/sales", kind: "dataset", title: "sales" }],
};

type Values = { target?: string | null; queryProject?: string | null };

/**
 * A fresh module, since it remembers which projects run queries at module level, and its frame,
 * seeded from `initial` or, as the runtime pre-fills a connection, from its resource URL.
 */
async function open(initial: Values | string = {}) {
  vi.resetModules();
  const spec = (await import("../src/configurator/bigquery-configurator-ui")).default as unknown as {
    initial: Values;
    isReady(context: { values: Values }): boolean;
    resourceUrl(context: { values: Values; ui: unknown }): string;
    initialValuesFromResourceUrl(context: { resourceUrl: string; resourceUrlPattern: string; ui: unknown }): Values;
    render(context: unknown): unknown;
  };
  const seeded = typeof initial === "string"
    ? spec.initialValuesFromResourceUrl({ resourceUrl: initial, resourceUrlPattern: "https://bigquery.googleapis.com/:projectId/*", ui: null })
    : initial;
  let values: Values = { ...spec.initial, ...seeded };
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
    /** The label of the one Button rendered, if any. */
    button: () => { const [button] = find("Button"); return button && text(button); },
    click: () => find("Button")[0]!.props.onClick(),
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
      id: "table:theirs/events/clicks", kind: "table", title: "clicks", runsQueries: false,
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
    // Nothing can be typed while the suggestion is on its way, so it cannot land on an edit, even
    // after the choice moves within the shared project.
    expect(frame.autocomplete()).toMatchObject({ name: "queryProject", value: null, disabled: true });
    frame.picker().onChange("project:theirs", null);
    expect(frame.autocomplete()).toMatchObject({ value: null, disabled: true });
    await vi.waitFor(() => expect(frame.values().queryProject).toBe("mine"));
    expect(frame.autocomplete()).toMatchObject({ value: "mine", disabled: false });
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe("https://bigquery.googleapis.com/theirs/?queryProject=mine");
  });

  it("lands a suggestion only while the choice stays in the data project it was made for", async () => {
    const frame = await open();
    const projects = Promise.withResolvers<{ value: string; title: string }[]>();
    frame.ui.listProjects.mockReturnValueOnce(projects.promise);
    const LOGS: BigQueryNode = { id: "dataset:others/logs", kind: "dataset", title: "logs", runsQueries: false };
    frame.ui.listNodes.mockResolvedValueOnce({ nodes: [SHARED_DATASET, LOGS, MINE] });
    await frame.list("bigquery");
    frame.picker().onChange("dataset:theirs/events", null);
    // Moving to a project of the account's own while it is on its way, then to another shared one.
    frame.picker().onChange("project:mine", null);
    projects.resolve([{ value: "mine", title: "mine" }]);
    frame.picker().onChange("dataset:others/logs", null);
    await vi.waitFor(() => expect(frame.values()).toEqual({ target: "dataset:others/logs", queryProject: "mine" }));
    // The first answer, which arrived while "mine" was chosen, filled nothing in there.
    expect(frame.setValues.mock.calls.filter(([patch]) => patch.queryProject === "mine")).toHaveLength(1);
  });

  it("is chosen by the user when the account has several projects, and dropped on leaving the shared project", async () => {
    const frame = await open();
    frame.ui.listNodes.mockResolvedValueOnce({ nodes: [SHARED_DATASET, MINE] });
    await frame.list("bigquery");
    frame.picker().onChange("dataset:theirs/events", null);
    await vi.waitFor(() => expect(frame.autocomplete().disabled).toBe(false));
    expect(frame.values().queryProject).toBeNull();
    expect(frame.ready()).toBe(false);
    frame.autocomplete().onChange("other");
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe("https://bigquery.googleapis.com/theirs/events?queryProject=other");
    // Another choice in the same project keeps it, even after nothing was chosen for a moment, as
    // while the user opens a location or searches; one in a project of the account's own drops it.
    frame.clearFields.mockClear();
    frame.picker().onChange(null, null);
    expect(frame.values()).toEqual({ target: null, queryProject: "other" });
    frame.picker().onChange("project:theirs", null);
    expect(frame.values()).toEqual({ target: "project:theirs", queryProject: "other" });
    expect(frame.clearFields).not.toHaveBeenCalled();
    frame.picker().onChange("project:mine", null);
    expect(frame.values()).toEqual({ target: "project:mine", queryProject: null });
    expect(frame.clearFields).toHaveBeenCalledWith("queryProject");
    expect(frame.fields()).toEqual(["What to connect"]);
  });

  it("keeps a pre-filled query project in view for a project of the account's own, until cleared", async () => {
    const frame = await open("https://bigquery.googleapis.com/mine/sales?queryProject=other");
    frame.ui.getNode.mockResolvedValueOnce({ id: "dataset:mine/sales", kind: "dataset", title: "sales", runsQueries: true });
    await frame.load("dataset:mine/sales");
    expect(frame.ready()).toBe(true);
    expect(frame.fields()).toEqual(["What to connect", "Run queries in"]);
    expect(frame.autocomplete()).toMatchObject({ value: "other", optional: true });
    expect(frame.url()).toBe("https://bigquery.googleapis.com/mine/sales?queryProject=other");
    expect(frame.button()).toBe(`Run queries in "mine"`);
    // Typing over the choice abandons it without taking the field away, and the form waits for
    // another to be picked, or for the user to run queries in the data project instead.
    frame.autocomplete().onChange(null);
    expect(frame.fields()).toEqual(["What to connect", "Run queries in"]);
    expect(frame.ready()).toBe(false);
    expect(frame.button()).toBe(`Run queries in "mine"`);
    frame.autocomplete().onChange("third");
    expect(frame.ready()).toBe(true);
    expect(frame.button()).toBe(`Run queries in "mine"`);
    expect(frame.url()).toBe("https://bigquery.googleapis.com/mine/sales?queryProject=third");
    // Clear, which shows while a project is picked, drops it just as the button does.
    frame.autocomplete().onClear();
    expect(frame.values()).toEqual({ target: "dataset:mine/sales", queryProject: null });
    expect(frame.fields()).toEqual(["What to connect"]);
    expect(frame.button()).toBeUndefined();
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe("https://bigquery.googleapis.com/mine/sales");
  });

  it("runs queries in the data project when the user asks to, after typing over a pre-filled query project", async () => {
    const frame = await open("https://bigquery.googleapis.com/mine/sales?queryProject=other");
    frame.ui.getNode.mockResolvedValueOnce({ id: "dataset:mine/sales", kind: "dataset", title: "sales", runsQueries: true });
    await frame.load("dataset:mine/sales");
    frame.autocomplete().onChange(null);
    frame.click();
    expect(frame.clearFields).toHaveBeenCalledWith("queryProject");
    expect(frame.values()).toEqual({ target: "dataset:mine/sales", queryProject: null });
    expect(frame.fields()).toEqual(["What to connect"]);
    expect(frame.button()).toBeUndefined();
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe("https://bigquery.googleapis.com/mine/sales");
  });

  it("keeps a pre-filled query project while the choice moves within its data project, and drops it on leaving", async () => {
    const frame = await open("https://bigquery.googleapis.com/mine/?queryProject=other");
    frame.ui.getNode.mockResolvedValueOnce({ ...MINE, runsQueries: true });
    await frame.load("project:mine");
    // Opening a dataset lets go of the project before the dataset, or a table in it, is chosen.
    frame.picker().onChange(null, null);
    expect(frame.values()).toEqual({ target: null, queryProject: "other" });
    expect(frame.fields()).toEqual(["What to connect"]);
    frame.picker().onChange("dataset:mine/sales", null);
    frame.picker().onChange("table:mine/sales/orders", null);
    expect(frame.fields()).toEqual(["What to connect", "Run queries in"]);
    expect(frame.autocomplete()).toMatchObject({ value: "other", optional: true });
    expect(frame.url()).toBe("https://bigquery.googleapis.com/mine/sales/orders?queryProject=other");
    frame.picker().onChange(null, null);
    frame.picker().onChange("dataset:yours/web", null);
    expect(frame.values()).toEqual({ target: "dataset:yours/web", queryProject: null });
    expect(frame.clearFields).toHaveBeenCalledWith("queryProject");
    expect(frame.url()).toBe("https://bigquery.googleapis.com/yours/web");
  });

  it("holds a pre-filled choice back until the lookup says whether its project is the account's", async () => {
    const frame = await open("https://bigquery.googleapis.com/theirs/events?queryProject=mine");
    expect(frame.ready()).toBe(false);
    frame.ui.getNode.mockResolvedValueOnce(SHARED_DATASET);
    await expect(frame.load("dataset:theirs/events")).resolves.toMatchObject({ id: "dataset:theirs/events", kind: "container" });
    expect(frame.setValues).toHaveBeenCalledWith({});
    expect(frame.ready()).toBe(true);
  });

  it("keeps a pre-filled query project for a choice made in its data project before the lookup answers", async () => {
    const frame = await open("https://bigquery.googleapis.com/mine/sales?queryProject=other");
    // Shown, but not yet ready, while the lookup is on its way.
    expect(frame.fields()).toEqual(["What to connect", "Run queries in"]);
    expect(frame.ready()).toBe(false);
    // A search lets go of the choice, and finds a table in the same dataset.
    frame.picker().onChange(null, null);
    frame.ui.listNodes.mockResolvedValueOnce({ nodes: [{ id: "table:mine/sales/orders", kind: "table", title: "orders", runsQueries: true }] });
    await frame.list("bigquery", "mine.sales.orders");
    frame.picker().onChange("table:mine/sales/orders", null);
    expect(frame.fields()).toEqual(["What to connect", "Run queries in"]);
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe("https://bigquery.googleapis.com/mine/sales/orders?queryProject=other");
  });

  it("fills in nothing for a pre-filled choice whose lookup answers after the user moved to another project", async () => {
    const frame = await open("https://bigquery.googleapis.com/theirs/events");
    frame.ui.listProjects.mockResolvedValue([{ value: "mine", title: "mine" }]);
    const lookup = Promise.withResolvers<BigQueryNode | null>();
    frame.ui.getNode.mockReturnValueOnce(lookup.promise);
    const loading = frame.load("dataset:theirs/events");
    // Before the lookup answers, a search finds a dataset in a project that runs queries.
    frame.picker().onChange(null, null);
    frame.ui.listNodes.mockResolvedValueOnce({ nodes: [{ id: "dataset:yours/web", kind: "dataset", title: "web", runsQueries: true }] });
    await frame.list("bigquery", "yours.web");
    frame.picker().onChange("dataset:yours/web", null);
    // The late answer says the pre-filled dataset was shared; it must not look for a query project
    // to fill in here, where none is needed.
    lookup.resolve(SHARED_DATASET);
    await loading;
    expect(frame.ui.listProjects).not.toHaveBeenCalled();
    expect(frame.values()).toEqual({ target: "dataset:yours/web", queryProject: null });
    expect(frame.url()).toBe("https://bigquery.googleapis.com/yours/web");
  });

  it("still suggests a query project for a pre-filled shared choice the user only searched away from", async () => {
    const frame = await open("https://bigquery.googleapis.com/theirs/events");
    frame.ui.listProjects.mockResolvedValue([{ value: "mine", title: "mine" }]);
    const lookup = Promise.withResolvers<BigQueryNode | null>();
    frame.ui.getNode.mockReturnValueOnce(lookup.promise);
    const loading = frame.load("dataset:theirs/events");
    frame.picker().onChange(null, null);
    lookup.resolve(SHARED_DATASET);
    await loading;
    await vi.waitFor(() => expect(frame.values().queryProject).toBe("mine"));
    frame.picker().onChange("table:theirs/events/clicks", null);
    expect(frame.url()).toBe("https://bigquery.googleapis.com/theirs/events/clicks?queryProject=mine");
  });

  it("suggests a query project for a choice in a pre-filled shared project that a search found before the lookup answered", async () => {
    const frame = await open("https://bigquery.googleapis.com/theirs/events");
    frame.ui.listProjects.mockResolvedValue([{ value: "mine", title: "mine" }]);
    const lookup = Promise.withResolvers<BigQueryNode | null>();
    frame.ui.getNode.mockReturnValueOnce(lookup.promise);
    const loading = frame.load("dataset:theirs/events");
    // The search result is the first to say the project is shared.
    frame.picker().onChange(null, null);
    frame.ui.listNodes.mockResolvedValueOnce({ nodes: [{ id: "table:theirs/events/clicks", kind: "table", title: "clicks", runsQueries: false }] });
    await frame.list("bigquery", "theirs.events.clicks");
    frame.picker().onChange("table:theirs/events/clicks", null);
    await vi.waitFor(() => expect(frame.values().queryProject).toBe("mine"));
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe("https://bigquery.googleapis.com/theirs/events/clicks?queryProject=mine");
    lookup.resolve(SHARED_DATASET);
    await loading;
    expect(frame.url()).toBe("https://bigquery.googleapis.com/theirs/events/clicks?queryProject=mine");
  });

  it("leaves a pre-filled query project the user typed over for them to replace as the choice narrows", async () => {
    const frame = await open("https://bigquery.googleapis.com/theirs/events?queryProject=compute");
    frame.ui.listProjects.mockResolvedValue([{ value: "mine", title: "mine" }]);
    frame.ui.getNode.mockResolvedValueOnce(SHARED_DATASET);
    await frame.load("dataset:theirs/events");
    frame.autocomplete().onChange(null);
    frame.picker().onChange(null, null);
    frame.picker().onChange("table:theirs/events/clicks", null);
    // Nothing is suggested in place of what the user is replacing.
    expect(frame.ui.listProjects).not.toHaveBeenCalled();
    expect(frame.values()).toEqual({ target: "table:theirs/events/clicks", queryProject: null });
    expect(frame.ready()).toBe(false);
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
