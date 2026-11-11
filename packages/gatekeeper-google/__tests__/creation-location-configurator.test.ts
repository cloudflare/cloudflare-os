// The approver of a creation picks the Drive folder it goes in. This drives that frame as the
// sandbox runtime would, and reads what it mints back as the gatekeeper does.

import { describe, expect, it, onTestFinished, vi } from "vitest";
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
  initialValuesFromResourceUrl(context: { resourceUrl: string; ui: unknown }): Promise<Values>;
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
    getFolder: vi.fn(async (_id: string): Promise<unknown> => null),
    folderForUrl: vi.fn(async (_url: string): Promise<string | null> => null),
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
    lookUp: (id: string) => picker().loadItem(id),
    choose: (folder: string | null) => picker().onChange(folder),
    prefill: async (resourceUrl: string) => {
      values = { ...values, ...await spec.initialValuesFromResourceUrl({ resourceUrl, ui }) };
    },
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

  it("unlocks once Google's pop-up grants access, without asking again", async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const frame = await open(GOOGLE_SHEETS_RESOURCE.urlPattern, false);
    await frame.list("folder:root");
    frame.choose("folder:plans-1");
    frame.ensureResources.mockResolvedValueOnce(false);
    frame.ui.hasCreationAccess.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const allowing = frame.notices()[0].props.action.onClick();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.ready()).toBe(false);
    expect(text(frame.notices()[0])).toBe("Allow access in Google's window.");

    await vi.advanceTimersByTimeAsync(2_000);
    await allowing;
    expect(frame.ready()).toBe(true);
    expect(frame.notices()).toEqual([]);
    expect(frame.ensureResources).toHaveBeenCalledTimes(1);
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

  // A suggested place is a folder only the gatekeeper, which reads Drive, can tell from its URL, and
  // anyone the folder is shared with sees what lands there, so the approver is told it was suggested.
  it("pre-selects a suggested folder and says the agent suggested it, until another is chosen", async () => {
    const frame = await open(GOOGLE_SHEETS_RESOURCE.urlPattern, true);
    frame.ui.folderForUrl.mockResolvedValueOnce("folder:plans-1");
    await frame.prefill("https://drive.google.com/drive/u/1/folders/plans-1");
    expect(frame.ui.folderForUrl).toHaveBeenCalledWith("https://drive.google.com/drive/u/1/folders/plans-1");
    expect(frame.location()).toEqual({ kind: "driveFolder", folderId: "plans-1" });
    expect(frame.notices().map(text)).toEqual([expect.stringMatching(/^The agent suggested this folder/)]);

    frame.choose("folder:root");
    expect(frame.notices()).toEqual([]);
  });

  it("stays on My Drive, unremarked, when the suggestion is My Drive", async () => {
    const frame = await open(GOOGLE_SHEETS_RESOURCE.urlPattern, true);
    frame.ui.folderForUrl.mockResolvedValueOnce("folder:root");
    await frame.prefill("https://drive.google.com/drive/my-drive");
    expect(frame.location()).toEqual({ kind: "driveFolder", folderId: "root" });
    expect(frame.notices()).toEqual([]);
  });

  // Falling back to My Drive would have the approver approve it believing it is the agent's place.
  it.each([
    ["names no folder this account can reach", async () => null],
    ["cannot be looked up", async () => { throw new Error("Drive is down"); }],
  ])("selects nothing, and says so, when a suggestion %s", async (_name, lookUp) => {
    const frame = await open(GOOGLE_SHEETS_RESOURCE.urlPattern, true);
    frame.ui.folderForUrl.mockImplementationOnce(lookUp);
    await frame.prefill("https://drive.google.com/open?id=plans-1");
    expect(frame.ready()).toBe(false);
    expect(frame.notices().map(text)).toEqual([expect.stringMatching(/^The agent suggested a place this Google account can't find/)]);

    frame.choose("folder:root");
    expect(frame.ready()).toBe(true);
    expect(frame.notices()).toEqual([]);
  });

  it("shows a pre-selected folder where it lives, selectable only if it takes new files", async () => {
    const frame = await open(GOOGLE_SHEETS_RESOURCE.urlPattern, true);
    frame.ui.getFolder.mockResolvedValueOnce({
      id: "folder:plans-1", title: "Plans", kind: "folder", listable: true, addable: true,
      path: [{ id: "folder:root", title: "My Drive", listable: true, addable: true }, { id: "folder:team", title: "Team", listable: true }],
    });
    expect(await frame.lookUp("folder:plans-1")).toMatchObject({
      id: "folder:plans-1", selectable: true,
      path: [{ id: "folder:root", selectable: true }, { id: "folder:team", selectable: false }],
    });
    expect(frame.ui.getFolder).toHaveBeenCalledWith("folder:plans-1");
    expect(await frame.lookUp("folder:gone")).toBeNull();
  });
});
