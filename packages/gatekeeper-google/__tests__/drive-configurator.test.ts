// The Drive configurator in a stand-in for the sandbox runtime: what it shows when a location needs
// a grant the account lacks (shared drives), and what it asks Workshop for.

import { expect, it, vi } from "vitest";
import type { DriveNodePage } from "../src/configurator/drive-configurator-types";
import { nodes, text } from "./configurator-tree";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({
    component, props: props ?? {}, children,
  }),
  Button: "Button",
  Field: "Field",
  Fragment: "Fragment",
  HierarchyPicker: "HierarchyPicker",
  Notice: "Notice",
  Section: "Section",
}));

const GRANT = "https://drive.google.com/drive/shared-drives";
const GRANT_NOTICE = { tone: undefined, text: expect.stringContaining('"View and download all your Drive files"') };

/** A fresh module, since it keeps the pending grant at module level, and its frame. */
async function open() {
  vi.resetModules();
  const spec = (await import("../src/configurator/drive-configurator-ui")).default as unknown as {
    initial: Record<string, unknown>;
    render(context: unknown): unknown;
  };
  let values = { ...spec.initial };
  const ui = {
    listDriveNodes: vi.fn(async (): Promise<DriveNodePage> => ({ nodes: [] })),
    getDriveNode: vi.fn(),
  };
  const ensureResources = vi.fn(async (_patterns: string[]) => false);
  const find = (component: string) => nodes(spec.render({
    values,
    setValues: (patch: Record<string, unknown>) => { values = { ...values, ...patch }; },
    clearFields: () => {},
    ensureResources,
    ui,
  })).filter(node => node.component === component);
  return {
    ui, ensureResources,
    list: (parentId: string, query = "") =>
      find("HierarchyPicker")[0].props.loadItems({ parentId, query, cursor: null }),
    load: (id: string) => find("HierarchyPicker")[0].props.loadItem(id),
    notices: () => find("Notice").map(node => ({ tone: node.props.tone, text: text(node) })),
    allow: () => find("Button").find(node => text(node) === "Allow access")?.props.onClick(),
  };
}

it("asks for the grant a location names, then stops once a listing loads", async () => {
  const frame = await open();
  frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [], needsGrant: GRANT });

  // Expected, so said as an unavailable location rather than a failure the picker would report.
  await expect(frame.list("shared-drives")).resolves.toEqual(
    { items: [], unavailable: expect.stringContaining("Allow it below, then select Retry.") });
  expect(frame.notices()).toEqual([GRANT_NOTICE]);
  frame.allow();
  expect(frame.ensureResources).toHaveBeenCalledExactlyOnceWith([GRANT]);
  await vi.waitFor(() => expect(frame.notices()).toContainEqual(
    { tone: undefined, text: "Allow access in Google's window, then select Retry." }));

  await frame.list("shared-drives");
  expect(frame.notices()).toEqual([]);
});

// The picker drops a reply for a location it has left, but only once the module has seen it.
it.each([
  ["an earlier search's", "Q3", { nodes: [] }, { nodes: [], needsGrant: GRANT }, [GRANT_NOTICE]],
  ["Shared drives' earlier", "", { nodes: [], needsGrant: GRANT }, { nodes: [] }, []],
])("ignores %s reply that arrives after a newer listing's", async (_, query, older, newer, notices) => {
  const frame = await open();
  const reply = Promise.withResolvers<DriveNodePage>();
  frame.ui.listDriveNodes.mockReturnValueOnce(reply.promise).mockResolvedValueOnce(newer);

  const stale = frame.list("shared-drives", query);
  await frame.list("drive");
  reply.resolve(older);
  await stale;

  expect(frame.notices()).toEqual(notices);
});

it("says why the grant was not given", async () => {
  const frame = await open();
  frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [], needsGrant: GRANT });
  frame.ensureResources.mockRejectedValueOnce(new Error("The pop-up was closed."));

  await frame.list("shared-drives");
  frame.allow();

  await vi.waitFor(() => expect(frame.notices()).toContainEqual(
    { tone: "error", text: "The pop-up was closed." }));
});

it("offers only the folders on a pre-filled file's path that this account can list", async () => {
  const frame = await open();
  frame.ui.getDriveNode.mockResolvedValueOnce({
    id: "file:F9", title: "Q3.pdf", kind: "file",
    path: [
      { id: "folder:0AMyRoot", title: "My Drive", listable: true },
      { id: "folder:A", title: "Archive", listable: false },
    ],
  });

  const item = await frame.load("file:F9");

  expect(item.path.map(({ id, selectable }: { id: string; selectable: boolean }) => [id, selectable]))
    .toEqual([["folder:0AMyRoot", true], ["folder:A", false]]);
});
