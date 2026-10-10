import { describe, expect, it, vi } from "vitest";
import type { ConversationConfiguratorValues } from "./conversation-configurator-types";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) =>
    ({ component, props: props ?? {}, children: children.flat() }),
  Section: () => undefined,
  Field: () => undefined,
  Autocomplete: () => undefined,
}));

const { default: conversation } = await import("./conversation-configurator-ui");
const { default: workspace } = await import("./workspace-configurator-ui");

const unusedUi = {
  listWorkspaces: async () => { throw new Error("URL serialization must not query Slack."); },
  listConversations: async () => { throw new Error("URL serialization must not query Slack."); },
};

type RenderedNode = { props: Record<string, unknown>; children: unknown[] };

function control(tree: unknown, name: string): Record<string, unknown> {
  if (typeof tree !== "object" || tree === null || !("props" in tree) || !("children" in tree)) {
    throw new Error(`No control named ${name}.`);
  }
  let node = tree as RenderedNode;
  if (node.props.name === name) return node.props;
  for (let child of node.children) {
    try { return control(child, name); } catch { continue; }
  }
  throw new Error(`No control named ${name}.`);
}

function render(values: ConversationConfiguratorValues) {
  let patches: Partial<ConversationConfiguratorValues>[] = [];
  let ui = { listWorkspaces: vi.fn(async () => []), listConversations: vi.fn(async () => []) };
  let tree = conversation.render({
    values, setValues: patch => void patches.push(patch), clearFields() {}, ui,
  });
  return { tree, patches, ui };
}

describe("Slack workspace selection", () => {
  it("clears the selected conversation when the workspace changes", () => {
    let values = { teamId: "TONE", conversationId: "COLD" };
    let { tree, patches } = render(values);
    (control(tree, "teamId").onChange as (value: string) => void)("TTWO");
    expect(patches).toEqual([{ teamId: "TTWO", conversationId: null }]);
    expect(conversation.isReady({ values: { ...values, ...patches[0] } })).toBe(false);
  });

  it("scopes discovery and the runtime option cache to the selected workspace", async () => {
    let { tree, ui } = render({ teamId: "TTWO", conversationId: null });
    let picker = control(tree, "conversationId:TTWO");
    await (picker.loadOptions as (query: string) => Promise<unknown>)("general");
    expect(ui.listConversations).toHaveBeenCalledWith("TTWO", "general");
    expect(control(render({ teamId: "TONE" }).tree, "conversationId:TONE")).toBeDefined();
  });

  it("does not discover conversations without a workspace", async () => {
    let { tree, ui } = render({});
    let picker = control(tree, "conversationId:");
    expect(picker.disabled).toBe(true);
    expect(await (picker.loadOptions as (query: string) => Promise<unknown>)("")).toEqual([]);
    expect(ui.listConversations).not.toHaveBeenCalled();
  });

  it("round-trips the chosen workspace and conversation without token-based autodetection", () => {
    let values = { teamId: "TTWO", conversationId: "CTWO" };
    let url = conversation.resourceUrl({ values, ui: unusedUi });
    expect(url).toBe("https://app.slack.com/client/TTWO/CTWO");
    expect(conversation.initialValuesFromResourceUrl({ resourceUrl: url, resourceUrlPattern: "", ui: unusedUi }))
        .toEqual(values);
    expect(workspace.resourceUrl({ values: { teamId: "TTWO" }, ui: unusedUi }))
        .toBe("https://app.slack.com/client/TTWO");
    expect(workspace.initialValuesFromResourceUrl({
      resourceUrl: "https://app.slack.com/client/TTWO", resourceUrlPattern: "", ui: unusedUi,
    }))
        .toEqual({ teamId: "TTWO" });
  });

  it("rejects enterprise IDs and missing workspace selections", () => {
    for (let teamId of ["EORG", "", undefined]) {
      expect(workspace.isReady({ values: { teamId } })).toBe(false);
      expect(conversation.isReady({ values: { teamId, conversationId: "CONE" } })).toBe(false);
      expect(() => conversation.resourceUrl({ values: { teamId, conversationId: "CONE" }, ui: unusedUi }))
          .toThrow("Choose a workspace");
    }
    expect(workspace.initialValuesFromResourceUrl({
      resourceUrl: "https://app.slack.com/client/EORG", resourceUrlPattern: "", ui: unusedUi,
    }))
        .toEqual({});
  });
});
