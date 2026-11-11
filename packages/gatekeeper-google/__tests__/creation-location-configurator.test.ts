// The approver of a creation picks the Drive folder it goes in. This drives that frame as the
// sandbox runtime would, and reads what it mints back as the gatekeeper does.

import { describe, expect, it, vi } from "vitest";
import {
  CREATED_FILES_GRANT, GOOGLE_DRIVE_FOLDER_RESOURCE, GOOGLE_SHEETS_RESOURCE, parseResourceUrl,
} from "../src/resources";
import { nodes, text } from "./configurator-tree";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({
    component, props: props ?? {}, children,
  }),
  Field: "Field",
  HierarchyPicker: "HierarchyPicker",
  Notice: "Notice",
  Section: "Section",
}));

type Values = Record<string, unknown>;
type Spec = {
  initial: Values;
  isReady(context: { values: Values; acceptedResourceUrlPatterns?: string[] }): boolean;
  resourceUrl(context: { values: Values }): string;
  render(context: unknown): unknown;
};

/** A fresh module, since it keeps what it learned of grants at module level, opened for `pattern`. */
async function open(pattern: string, held: boolean) {
  vi.resetModules();
  const spec = (await import("../src/configurator/creation-location-configurator-ui")).default as unknown as Spec;
  let values: Values = { ...spec.initial };
  const accepted = [pattern];
  const ui = {
    listFolders: vi.fn(async (): Promise<unknown> => ({ nodes: [] })),
    hasCreationAccess: vi.fn(async () => held),
  };
  const ensureResources = vi.fn(async (_patterns: string[]) => true);
  const context = () => ({
    values, setValues: (patch: Values) => { values = { ...values, ...patch }; }, ensureResources, ui,
    acceptedResourceUrlPatterns: accepted,
  });
  const picker = () => nodes(spec.render(context())).find(node => node.component === "HierarchyPicker")!.props;
  const notices = () => nodes(spec.render(context())).filter(node => node.component === "Notice");
  return {
    ui, ensureResources, notices,
    ready: () => spec.isReady({ values, acceptedResourceUrlPatterns: accepted }),
    location: () => parseResourceUrl(spec.resourceUrl({ values })),
    list: (parentId: string) => picker().loadItems({ parentId, query: "", cursor: null }),
    choose: (folder: string | null) => picker().onChange(folder),
  };
}

describe("the creation location picker", () => {
  it("starts on My Drive, where a new file needs no grant", async () => {
    const frame = await open(GOOGLE_SHEETS_RESOURCE.urlPattern, false);
    await frame.list("folder:root");
    expect(frame.ready()).toBe(true);
    expect(frame.notices()).toEqual([]);
    expect(frame.location()).toEqual({ kind: "driveFolder", folderId: "root" });
  });

  it("asks for the created-files grant before a file goes in a folder", async () => {
    const frame = await open(GOOGLE_SHEETS_RESOURCE.urlPattern, false);
    await frame.list("folder:root");
    frame.choose("folder:plans-1");
    expect(frame.ready()).toBe(false);
    expect(frame.notices()).toHaveLength(1);

    await frame.notices()[0].props.action.onClick();
    expect(frame.ensureResources).toHaveBeenCalledWith([CREATED_FILES_GRANT]);
    expect(frame.ready()).toBe(true);
    expect(frame.notices()).toEqual([]);
    expect(frame.location()).toEqual({ kind: "driveFolder", folderId: "plans-1" });
  });

  it("needs the grant for a new folder even in My Drive, and asks nothing once it is held", async () => {
    const without = await open(GOOGLE_DRIVE_FOLDER_RESOURCE.urlPattern, false);
    await without.list("folder:root");
    expect(without.ready()).toBe(false);
    expect(text(without.notices()[0])).toMatch(/only the specific Google Drive files you use with this app/);

    const held = await open(GOOGLE_DRIVE_FOLDER_RESOURCE.urlPattern, true);
    await held.list("folder:root");
    expect(held.ready()).toBe(true);
    expect(held.notices()).toEqual([]);
  });

  it("offers only folders the account can add files to", async () => {
    const frame = await open(GOOGLE_SHEETS_RESOURCE.urlPattern, true);
    frame.ui.listFolders.mockResolvedValueOnce({
      nodes: [
        { id: "folder:open-1", title: "Open", kind: "folder", listable: true, addable: true },
        { id: "folder:viewer-1", title: "Read only", kind: "folder", listable: true, addable: false },
      ],
    });
    const page = await frame.list("folder:root");
    expect(page.items.map(({ id, kind, selectable }: Values) => ({ id, kind, selectable }))).toEqual([
      { id: "folder:open-1", kind: "container", selectable: true },
      { id: "folder:viewer-1", kind: "container", selectable: false },
    ]);
  });
});
