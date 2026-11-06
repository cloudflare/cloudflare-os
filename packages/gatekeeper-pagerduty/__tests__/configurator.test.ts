// The configurator frame is transpiled alone and can't import `RESOURCES`, so it holds its own copy
// of each resource's URL pattern, which it matches against the patterns the Workshop says it will
// take. This keeps the copies in step: a node of each kind is choosable exactly when its own
// resource's pattern is accepted, and a refusal names the kinds that are.

import { beforeAll, describe, expect, it, vi } from "vitest";
import configurator from "../src/configurator/pagerduty-configurator-ui";
import type { PagerDutyNode, PagerDutyNodeKind } from "../src/configurator/pagerduty-configurator-types";
import { RESOURCES, type ResourceKind } from "../src/pagerduty-env";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({ component, props: props ?? {}, children }),
  Field: "Field",
  HierarchyPicker: "HierarchyPicker",
  Notice: "Notice",
  Section: "Section",
}));

type Tree = { component: unknown; props: Record<string, unknown>; children: unknown[] };
type Spec = {
  isReady(context: { values: Record<string, unknown>; acceptedResourceUrlPatterns?: string[] }): boolean;
  render(context: unknown): Tree;
};

// The frame's callbacks, called here with only the context fields they read.
const spec = configurator as unknown as Spec;

const KINDS = Object.keys(RESOURCES) as ResourceKind[];
const patternOf = (kind: ResourceKind) => RESOURCES[kind].urlPattern;

function find(node: unknown, component: string): Tree | undefined {
  if (!node || typeof node !== "object") return undefined;
  const tree = node as Tree;
  if (tree.component === component) return tree;
  for (const child of (tree.children ?? []).flat()) {
    const found = find(child, component);
    if (found) return found;
  }
  return undefined;
}

const ready = Promise.resolve({ state: "ready", account: { ref: "account", host: "acme.pagerduty.com" } });

/** The picker as the frame renders it once the connection is ready, under `accepted`. */
function picker(accepted: string[] | undefined, rows: PagerDutyNode[] = []) {
  const ui = { getStatus: () => ready, loadItems: async () => ({ items: rows }) };
  const tree = spec.render({ values: {}, setValues: () => {}, ui, acceptedResourceUrlPatterns: accepted });
  return find(tree, "HierarchyPicker")?.props as {
    loadItems(request: { parentId: string; query: string; cursor: string | null }): Promise<{ items: { selectable: boolean; unselectableReason?: string }[] }>;
  };
}

beforeAll(async () => {
  // The frame asks for the connection's status once, on first render, and is ready once it answers.
  picker(undefined);
  await ready;
});

describe("the configurator's copy of the resource URL patterns", () => {
  it.each(KINDS)("lets a %s be chosen exactly when its resource's pattern is accepted", kind => {
    const values = { ref: kind === "account" ? "account" : `${kind}:PABC123`, kind };
    expect(spec.isReady({ values, acceptedResourceUrlPatterns: [patternOf(kind)] })).toBe(true);
    expect(spec.isReady({ values, acceptedResourceUrlPatterns: KINDS.filter(k => k !== kind).map(patternOf) })).toBe(false);
    expect(spec.isReady({ values })).toBe(true);
  });

  it.each(KINDS.filter(kind => kind !== "account") as Exclude<PagerDutyNodeKind, "account">[])(
    "names what is accepted when a %s isn't", async kind => {
      const row: PagerDutyNode = { ref: `${kind}:PABC123`, kind, title: "Row" };
      const others = KINDS.filter(k => k !== kind && k !== "account");
      const { items: [refused] } = await picker([patternOf(others[0])], [row]).loadItems({ parentId: "teams", query: "", cursor: null });
      expect(refused).toMatchObject({ selectable: false, unselectableReason: `This connection needs a ${others[0]}.` });
      const { items: [chosen] } = await picker([patternOf(kind)], [row]).loadItems({ parentId: "teams", query: "", cursor: null });
      expect(chosen).toMatchObject({ selectable: true });
    });
});
