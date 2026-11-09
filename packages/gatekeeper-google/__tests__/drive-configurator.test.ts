// The Drive configurator in a stand-in for the sandbox runtime: how it shows a file's size, what it
// shows when a location needs a grant the account lacks (shared drives), what it asks Workshop for,
// and its access choice, Read only or Read and write.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DriveNode, DriveNodePage, DriveWriteAccess, OfficeFileInspection,
} from "../src/configurator/drive-configurator-types";
import {
  GOOGLE_DOC_RESOURCE, GOOGLE_DRIVE_FILE_RESOURCE, GOOGLE_DRIVE_FOLDER_RESOURCE, GOOGLE_DRIVE_RESOURCE,
  GOOGLE_SHEETS_RESOURCE, GOOGLE_SLIDES_RESOURCE,
} from "../src/resources";
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
  RadioCards: "RadioCards",
  Section: "Section",
}));

const GRANT = "https://drive.google.com/drive/shared-drives";
const GRANT_NOTICE = { tone: undefined, text: expect.stringContaining('"View and download all your Drive files"') };

/** The grant a read and write connection needs, as the frame's gatekeeper names it. */
const WRITES = "https://drive.google.com/drive/writes";

type Values = Record<string, unknown>;
type Spec = {
  initial: Values;
  isReady(context: { values: Values; acceptedResourceUrlPatterns?: string[] }): boolean;
  resourceUrl(context: { values: Values; acceptedResourceUrlPatterns?: string[] }): string;
  initialValuesFromResourceUrl(context: {
    resourceUrl: string; resourceUrlPattern: string; ui: unknown; acceptedResourceUrlPatterns?: string[];
  }): Promise<Values>;
  render(context: unknown): unknown;
};

/**
 * A fresh module, since it keeps the pending grant and what it knows of the account at module level,
 * and its frame, over the types the Workshop accepts (any, when it does not say).
 *
 * The frame draws the form as the runtime does: once when it opens, and again only when the module
 * calls `setValues`, reading readiness from the same values each time. So what a test reads is what
 * is on screen, and a change to the module's own state that no `setValues` follows is not shown.
 */
async function open(accepted?: string[]) {
  vi.resetModules();
  const spec = (await import("../src/configurator/drive-configurator-ui")).default as unknown as Spec;
  let values: Values = { ...spec.initial };
  const ui = {
    listDriveNodes: vi.fn(async (): Promise<DriveNodePage> => ({ nodes: [] })),
    getDriveNode: vi.fn(),
    getWriteAccess: vi.fn(async (): Promise<DriveWriteAccess> => ({ grant: WRITES, held: false })),
    // A Docs, Sheets or Slides file is checked when chosen.
    inspectFile: vi.fn(async (): Promise<OfficeFileInspection> => ({ type: "native" })),
  };
  const ensureResources = vi.fn(async (_patterns: string[]): Promise<boolean> => false);
  const setValues = (patch: Values) => {
    values = { ...values, ...patch };
    drawn = draw();
  };
  const draw = () => ({
    tree: nodes(spec.render({
      values, setValues, clearFields: () => {}, ensureResources, ui, acceptedResourceUrlPatterns: accepted,
    })),
    ready: spec.isReady({ values, acceptedResourceUrlPatterns: accepted }),
  });
  let drawn = draw();
  const find = (component: string) => drawn.tree.filter(node => node.component === component);
  return {
    ui, ensureResources,
    list: (parentId: string, query = "") =>
      find("HierarchyPicker")[0].props.loadItems({ parentId, query, cursor: null }),
    load: (id: string) => find("HierarchyPicker")[0].props.loadItem(id),
    notices: () => find("Notice").map(node => ({ tone: node.props.tone, text: text(node) })),
    allow: () => find("Notice").find(node => node.props.action?.label === "Allow access")?.props.action.onClick(),
    /** The picker's choice of a node. */
    choose: (target: string | null) => find("HierarchyPicker")[0].props.onChange(target),
    /** The access cards' props, or undefined when the form shows none. */
    access: () => find("RadioCards").at(0)?.props,
    chooseAccess: (value: string) => find("RadioCards")[0].props.onChange(value),
    /** Whether the form was ready when it was last drawn, which is what the runtime tells the Workshop. */
    ready: () => drawn.ready,
    url: () => spec.resourceUrl({ values, acceptedResourceUrlPatterns: accepted }),
    values: () => values,
    /**
     * Opens the form on `resourceUrl`, as the runtime does before the first render, resolving to what
     * that seeded. The form is drawn with the seeded values, and not while the pre-fill runs.
     */
    prefill: async (resourceUrl: string) => {
      const seeded = await spec.initialValuesFromResourceUrl({
        resourceUrl, resourceUrlPattern: GOOGLE_DRIVE_RESOURCE.urlPattern, ui, acceptedResourceUrlPatterns: accepted,
      });
      values = { ...values, ...seeded };
      drawn = draw();
      return seeded;
    },
    /** The first notice action. */
    action: () => find("Notice").map(node => node.props.action).find(Boolean),
    /** What the form renders, in order: each notice as its text, and the picker and the access cards by name. */
    order: () => drawn.tree.flatMap(node =>
      node.component === "Notice" ? [text(node)]
        : node.component === "HierarchyPicker" || node.component === "RadioCards" ? [node.component]
        : []),
  };
}

it.each([
  [0, "0 B"],
  [1023, "1023 B"],
  [1024, "1 KB"],
  [1536, "1.5 KB"],
  [10 * 1024 - 1, "10 KB"],
  [1024 * 1024 - 1, "1 MB"],
  [5.25 * 1024 ** 3, "5.3 GB"],
  [3 * 1024 ** 5, "3072 TB"],
])("shows a file of %i bytes as %s", async (size, meta) => {
  const frame = await open();
  frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [{ id: "file:F1", title: "Q3.pdf", kind: "file", size }] });

  await expect(frame.list("folder:A")).resolves.toMatchObject({ items: [{ meta }] });
});

it("shows no size for a folder, or for a file Drive gives none", async () => {
  const frame = await open();
  frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [
    { id: "folder:B", title: "Budgets", kind: "folder", listable: true },
    { id: "doc:D1", title: "Notes", kind: "file" },
  ] });

  const { items } = await frame.list("folder:A");

  expect(items.map(({ meta }: { meta?: string }) => meta)).toEqual([undefined, undefined]);
});

it("asks for the grant a location names, then stops once a listing loads", async () => {
  const frame = await open();
  frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [], needsGrant: GRANT });

  // Expected, so said as an unavailable location rather than a failure the picker would report.
  await expect(frame.list("shared-drives")).resolves.toEqual(
    { items: [], unavailable: expect.stringContaining("Allow it below, then select Retry.") });
  expect(frame.notices()).toEqual([GRANT_NOTICE]);
  frame.allow();
  expect(frame.ensureResources).toHaveBeenCalledExactlyOnceWith([GRANT]);
  await vi.waitFor(() => expect(frame.notices()).toEqual(
    [{ tone: undefined, text: "Allow access in Google's window, then select Retry." }]));

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

  await vi.waitFor(() => expect(frame.notices()).toEqual(
    [{ tone: "error", text: "The pop-up was closed." }]));
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

/** Info notices, as `notices()` reads them. */
const info = (...lines: string[]) => lines.map(line => ({ tone: undefined, text: line }));
/** The gatekeeper's answer for an account that allows changes. */
const held = (grant = WRITES): DriveWriteAccess => ({ grant, held: true });
const settle = () => vi.advanceTimersByTimeAsync(0);

/** Chooses a folder, then Read and write, and lets the account's answer arrive. */
const chooseWrite = async (frame: Awaited<ReturnType<typeof open>>) => {
  frame.choose("folder:F");
  frame.chooseAccess("write");
  await settle();
};

describe("the Drive picker's access choice", () => {
  const ACCOUNT = GOOGLE_DRIVE_RESOURCE.urlPattern;
  const FOLDER = GOOGLE_DRIVE_FOLDER_RESOURCE.urlPattern;
  const FILE = GOOGLE_DRIVE_FILE_RESOURCE.urlPattern;
  const DOC = GOOGLE_DOC_RESOURCE.urlPattern;
  const SHEETS = GOOGLE_SHEETS_RESOURCE.urlPattern;
  const SLIDES = GOOGLE_SLIDES_RESOURCE.urlPattern;

  const OPTIONS = [
    { value: "read", title: "Read only", description: "Files and their comments can be found and read. Nothing is changed." },
    {
      value: "write", title: "Read and write",
      description: "Comments can also be added, replied to and resolved. Each change waits for your approval.",
    },
  ];
  const WRITE_PROMPT = "Read and write needs one more permission from Google. Google will ask to " +
    "let this app \"See, edit, create, and delete all your Google Drive files\". It is used only " +
    "for changes you approve: a connection still reaches only what you choose.";
  const RESTART_HINT = "Allowing it can reset what you chose here: if it does, choose again.";
  const PRESET_READY = "Read and write access is chosen for this connection. To change it, see " +
    "Access, below the list.";
  const PRESET_PENDING = "Read and write access is chosen for this connection, and needs one more " +
    "step. See Access, below the list.";
  const WAITING = "Waiting for permission in Google's window…";
  const CHECKING = "Checking whether changes are allowed…";
  const ALLOWED = "Changes are allowed.";
  const AS_DRIVE_FILE = "Connects as a Drive file, whose content can be read but not edited.";
  const WRITE_URL = "https://drive.google.com/drive/folders/F?access=write";

  const NATIVE_DOC: DriveNode = {
    id: "doc:D", title: "Notes", kind: "file", mimeType: "application/vnd.google-apps.document",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers Read only and Read and write for a target that connects as a Drive type", async () => {
    const frame = await open();
    expect(frame.access()).toBeUndefined();

    for (const target of ["drive", "folder:F", "file:F"]) {
      frame.choose(target);
      expect(frame.order(), target).toEqual(["HierarchyPicker", "RadioCards"]);
      expect(frame.access(), target).toEqual({ value: "read", options: OPTIONS, onChange: expect.any(Function) });
    }

    frame.choose("shared-drives");
    expect(frame.access()).toBeUndefined();
  });

  it("offers no choice for a file that connects as its editable type, and offers it when the same file connects as a Drive file", async () => {
    const editable = await open();
    editable.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [NATIVE_DOC] });
    await editable.list("folder:A");
    editable.choose("doc:D");
    expect(editable.url()).toBe("https://docs.google.com/document/d/D/edit");
    expect(editable.access()).toBeUndefined();

    const asFile = await open([FILE]);
    asFile.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [NATIVE_DOC] });
    await asFile.list("folder:A");
    asFile.choose("doc:D");
    expect(asFile.url()).toBe("https://drive.google.com/file/d/D/view");
    expect(asFile.order().filter(name => name === "RadioCards")).toHaveLength(1);
    expect(asFile.access()).toMatchObject({ value: "read" });
  });

  it("is ready at once for Read only, minting no parameter and asking for nothing", async () => {
    const frame = await open();

    frame.choose("folder:F");

    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe("https://drive.google.com/drive/folders/F");
    expect(frame.ui.getWriteAccess).not.toHaveBeenCalled();
    expect(frame.ensureResources).not.toHaveBeenCalled();
  });

  it("is ready for Read and write as soon as the account is known to allow changes", async () => {
    const frame = await open();
    frame.ui.getWriteAccess.mockResolvedValue(held());
    frame.choose("folder:F");
    expect(frame.ready()).toBe(true);

    frame.chooseAccess("write");
    // Held back until the account has answered.
    expect(frame.ready()).toBe(false);
    await settle();

    expect(frame.access()).toMatchObject({ value: "write" });
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe(WRITE_URL);
    expect(frame.notices()).toEqual([]);
    expect(frame.ensureResources).not.toHaveBeenCalled();
  });

  // A grant no code holds, so a picker that kept its own copy of the writes grant would ask for another.
  it("holds Read and write back, and asks Google from the click for the grant the gatekeeper names", async () => {
    const NAMED = "https://example.test/from-rpc";
    const frame = await open();
    frame.ui.getWriteAccess.mockResolvedValue({ grant: NAMED, held: false });
    const asked = Promise.withResolvers<boolean>();
    frame.ensureResources.mockReturnValueOnce(asked.promise);

    await chooseWrite(frame);
    expect(frame.ready()).toBe(false);
    expect(frame.notices()).toEqual(info(WRITE_PROMPT));
    expect(WRITE_PROMPT).toContain('"See, edit, create, and delete all your Google Drive files"');
    expect(frame.action()).toMatchObject({ label: "Allow changes" });
    expect(frame.action().disabled).toBeFalsy();

    frame.action().onClick();
    // Synchronously, so the click's activation still lets Workshop open Google's window.
    expect(frame.ensureResources).toHaveBeenCalledExactlyOnceWith([NAMED]);
    // Held while Workshop has not answered, so a second click makes no second request.
    expect(frame.action().disabled).toBe(true);

    asked.resolve(false);
    await settle();
    expect(frame.notices()).toEqual(info(WAITING));
    expect(frame.action()).toMatchObject({ label: "Allow changes" });
    expect(frame.action().disabled).toBeFalsy();
    expect(frame.ready()).toBe(false);

    frame.ui.getWriteAccess.mockResolvedValue(held(NAMED));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.notices()).toEqual(info(ALLOWED));
    expect(frame.action()).toBeUndefined();
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe(WRITE_URL);
  });

  it("asks the gatekeeper once, at once, when Workshop says the account already holds the grant", async () => {
    const frame = await open();
    frame.ensureResources.mockResolvedValue(true);
    await chooseWrite(frame);
    frame.ui.getWriteAccess.mockResolvedValue(held());

    frame.action().onClick();
    await settle();

    // With no window to wait for, and so no wait before asking.
    expect(frame.ready()).toBe(true);
    expect(frame.notices()).toEqual(info(ALLOWED));
    expect(frame.ui.getWriteAccess).toHaveBeenCalledTimes(2);

    const refused = await open();
    refused.ensureResources.mockResolvedValue(true);
    await chooseWrite(refused);

    refused.action().onClick();
    await settle();

    expect(refused.notices()).toEqual(
      [{ tone: "error", text: "Google hasn't allowed changes. Select Allow changes to try again." }]);
    expect(refused.action()).toMatchObject({ label: "Allow changes" });
    expect(refused.action().disabled).toBeFalsy();
    expect(refused.ready()).toBe(false);
    // No window was opened, so no grant is on its way to keep asking for.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refused.ui.getWriteAccess).toHaveBeenCalledTimes(2);
  });

  it("gives up after three minutes, and lets Allow changes be tried again", async () => {
    const frame = await open();
    await chooseWrite(frame);

    frame.action().onClick();
    await vi.advanceTimersByTimeAsync(3 * 60_000 - 1);
    expect(frame.notices()).toEqual(info(WAITING));
    await vi.advanceTimersByTimeAsync(1);

    expect(frame.notices()).toEqual(
      [{ tone: "error", text: "Changes weren't allowed within 3 minutes. Select Allow changes to try again." }]);
    expect(frame.ready()).toBe(false);
    const reads = frame.ui.getWriteAccess.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(frame.ui.getWriteAccess).toHaveBeenCalledTimes(reads);

    frame.action().onClick();
    expect(frame.ensureResources).toHaveBeenCalledTimes(2);
  });

  it("says why Workshop refused, and keeps the action", async () => {
    const frame = await open();
    frame.ensureResources.mockRejectedValueOnce(new Error("The pop-up was closed."));
    await chooseWrite(frame);

    frame.action().onClick();
    await settle();

    expect(frame.notices()).toEqual([{ tone: "error", text: "The pop-up was closed." }]);
    expect(frame.action()).toMatchObject({ label: "Allow changes" });
    expect(frame.action().disabled).toBeFalsy();
    expect(frame.ready()).toBe(false);

    frame.ensureResources.mockRejectedValueOnce("refused");
    frame.action().onClick();
    await settle();

    expect(frame.notices()).toEqual([{ tone: "error", text: "Changes weren't allowed." }]);
    expect(frame.action()).toMatchObject({ label: "Allow changes" });
    // Workshop refused both requests, so the gatekeeper was asked only by the choice.
    expect(frame.ui.getWriteAccess).toHaveBeenCalledTimes(1);
  });

  it("lets a newer click take over from an older wait", async () => {
    const frame = await open();
    await chooseWrite(frame);
    frame.action().onClick();
    await settle();
    expect(frame.notices()).toEqual(info(WAITING));
    const newer = Promise.withResolvers<boolean>();
    frame.ensureResources.mockReturnValueOnce(newer.promise);

    frame.action().onClick();
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    // The older wait stopped, so it neither asked the gatekeeper nor timed out; the newer is still asking.
    expect(frame.ensureResources).toHaveBeenCalledTimes(2);
    expect(frame.notices()).toEqual(info(WRITE_PROMPT));
    expect(frame.action().disabled).toBe(true);
    expect(frame.ui.getWriteAccess).toHaveBeenCalledTimes(1);
  });

  it("says it is checking once the check is slow, and not before", async () => {
    const frame = await open();
    const read = Promise.withResolvers<DriveWriteAccess>();
    frame.ui.getWriteAccess.mockReturnValueOnce(read.promise);
    frame.choose("folder:F");

    frame.chooseAccess("write");
    expect(frame.notices()).toEqual([]);
    expect(frame.ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(399);
    expect(frame.notices()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(frame.notices()).toEqual(info(CHECKING));
    expect(frame.action()).toBeUndefined();
    expect(frame.ready()).toBe(false);

    read.resolve(held());
    await settle();
    expect(frame.notices()).toEqual([]);
    expect(frame.ready()).toBe(true);

    // A check that answers at once never says it is checking.
    const quick = await open();
    await chooseWrite(quick);
    await vi.advanceTimersByTimeAsync(400);
    expect(quick.notices()).toEqual(info(WRITE_PROMPT));

    // Read only lets go of a check that is slow.
    const left = await open();
    const stale = Promise.withResolvers<DriveWriteAccess>();
    left.ui.getWriteAccess.mockReturnValueOnce(stale.promise);
    left.choose("folder:F");
    left.chooseAccess("write");
    await vi.advanceTimersByTimeAsync(400);
    expect(left.notices()).toEqual(info(CHECKING));

    left.chooseAccess("read");
    expect(left.notices()).toEqual([]);
    expect(left.ready()).toBe(true);

    stale.resolve(held());
    await settle();
    expect(left.notices()).toEqual([]);
    expect(left.ready()).toBe(true);
    // Its answer was dropped, so Read and write asks afresh.
    left.chooseAccess("write");
    expect(left.ui.getWriteAccess).toHaveBeenCalledTimes(2);
  });

  it("shows nothing of a check that Read only let go of, neither its delay nor its failure", async () => {
    const frame = await open();
    const stale = Promise.withResolvers<DriveWriteAccess>();
    const latest = Promise.withResolvers<DriveWriteAccess>();
    frame.ui.getWriteAccess.mockReturnValueOnce(stale.promise).mockReturnValueOnce(latest.promise);
    frame.choose("folder:F");
    frame.chooseAccess("write");
    await vi.advanceTimersByTimeAsync(300);
    frame.chooseAccess("read");

    // The check that follows is timed from when it was asked.
    frame.chooseAccess("write");
    await vi.advanceTimersByTimeAsync(399);
    expect(frame.notices()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(frame.notices()).toEqual(info(CHECKING));

    stale.reject(new Error("Connection lost."));
    await settle();
    expect(frame.notices()).toEqual(info(CHECKING));
    expect(frame.action()).toBeUndefined();

    latest.resolve(held());
    await settle();
    expect(frame.notices()).toEqual([]);
    expect(frame.ready()).toBe(true);
  });

  it("says when it could not check, and checks again", async () => {
    const frame = await open();
    frame.ui.getWriteAccess.mockRejectedValueOnce(new Error("Drive is unavailable."));

    await chooseWrite(frame);

    expect(frame.notices()).toEqual([{ tone: "error", text: "Drive is unavailable." }]);
    expect(frame.action()).toMatchObject({ label: "Check again" });
    expect(frame.ready()).toBe(false);

    frame.action().onClick();
    await settle();

    expect(frame.notices()).toEqual(info(WRITE_PROMPT));
    expect(frame.action()).toMatchObject({ label: "Allow changes" });
    expect(frame.ensureResources).not.toHaveBeenCalled();

    const bare = await open();
    bare.ui.getWriteAccess.mockRejectedValueOnce("unavailable");
    await chooseWrite(bare);
    expect(bare.notices()).toEqual([{ tone: "error", text: "Couldn't check whether changes are allowed." }]);
    expect(bare.action()).toMatchObject({ label: "Check again" });
  });

  it("goes back to Read only without the grant, and stops waiting", async () => {
    const frame = await open();
    await chooseWrite(frame);
    frame.action().onClick();
    await settle();
    expect(frame.notices()).toEqual(info(WAITING));

    frame.chooseAccess("read");

    expect(frame.access()).toMatchObject({ value: "read" });
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe("https://drive.google.com/drive/folders/F");
    expect(frame.notices()).toEqual([]);
    const reads = frame.ui.getWriteAccess.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(frame.ui.getWriteAccess).toHaveBeenCalledTimes(reads);
    expect(frame.notices()).toEqual([]);

    // What is known of the account stays, so Read and write again says what it needs while it asks afresh.
    frame.chooseAccess("write");
    expect(frame.notices()).toEqual(info(WRITE_PROMPT));
    expect(frame.ui.getWriteAccess).toHaveBeenCalledTimes(reads + 1);
  });

  it("lets go of a request Workshop has not answered when Read only is chosen", async () => {
    const frame = await open();
    const asked = Promise.withResolvers<boolean>();
    frame.ensureResources.mockReturnValueOnce(asked.promise);
    await chooseWrite(frame);
    frame.action().onClick();
    expect(frame.action().disabled).toBe(true);

    frame.chooseAccess("read");
    asked.resolve(false);
    await vi.advanceTimersByTimeAsync(10_000);

    // Workshop's late answer starts no wait.
    expect(frame.ui.getWriteAccess).toHaveBeenCalledTimes(1);
    expect(frame.notices()).toEqual([]);
    expect(frame.ready()).toBe(true);

    // So Read and write, chosen again, asks the account afresh and offers the step again.
    frame.chooseAccess("write");
    await settle();
    expect(frame.ui.getWriteAccess).toHaveBeenCalledTimes(2);
    expect(frame.notices()).toEqual(info(WRITE_PROMPT));
    expect(frame.action()).toMatchObject({ label: "Allow changes" });
    expect(frame.action().disabled).toBeFalsy();
    expect(frame.ready()).toBe(false);
  });

  it("ignores Read and write left on a file that connects as its editable type", async () => {
    const frame = await open();
    await chooseWrite(frame);
    expect(frame.ready()).toBe(false);

    frame.choose("doc:D");
    await settle();

    expect(frame.ui.inspectFile).toHaveBeenCalledWith("doc", "D");
    expect(frame.values()).toMatchObject({ target: "doc:D", access: "write" });
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe("https://docs.google.com/document/d/D/edit");
    expect(frame.access()).toBeUndefined();
    expect(frame.notices()).toEqual([]);
  });

  it("keeps the shared-drives notice last", async () => {
    const frame = await open();
    frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [], needsGrant: GRANT });
    await frame.list("shared-drives");
    await chooseWrite(frame);
    expect(frame.notices()).toEqual([...info(WRITE_PROMPT), GRANT_NOTICE]);

    // A file's own notice comes before what its access choice needs.
    const asFile = await open([FILE]);
    asFile.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [NATIVE_DOC] });
    await asFile.list("folder:A");
    asFile.choose("doc:D");
    asFile.chooseAccess("write");
    await settle();
    expect(asFile.notices()).toEqual(info(AS_DRIVE_FILE, WRITE_PROMPT));
    // And before the cards: the Access field sits below the picker and the file's notice.
    expect(asFile.order()).toEqual(["HierarchyPicker", AS_DRIVE_FILE, "RadioCards", WRITE_PROMPT]);

    // The confirmation stays when the shared-drives notice then appears after it.
    const allowed = await open();
    await chooseWrite(allowed);
    allowed.action().onClick();
    allowed.ui.getWriteAccess.mockResolvedValue(held());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(allowed.notices()).toEqual(info(ALLOWED));
    allowed.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [], needsGrant: GRANT });
    await allowed.list("shared-drives");
    expect(allowed.notices()).toEqual([...info(ALLOWED), GRANT_NOTICE]);
    expect(allowed.ready()).toBe(true);
  });

  it("opens on Read and write when the resource URL asks for it", async () => {
    const ready = await open();
    ready.ui.getWriteAccess.mockResolvedValue(held());
    await ready.prefill(WRITE_URL);
    expect(ready.values()).toEqual({ target: "folder:F", access: "write" });
    expect(ready.access()).toMatchObject({ value: "write" });
    expect(ready.ready()).toBe(true);
    expect(ready.notices()).toEqual(info(PRESET_READY));
    expect(ready.ui.getWriteAccess).toHaveBeenCalledTimes(1);
    expect(ready.ensureResources).not.toHaveBeenCalled();

    const missing = await open();
    await missing.prefill(WRITE_URL);
    expect(missing.notices()).toEqual(info(PRESET_PENDING, WRITE_PROMPT));
    expect(missing.action()).toMatchObject({ label: "Allow changes" });
    expect(missing.ready()).toBe(false);

    const failing = await open();
    failing.ui.getWriteAccess.mockRejectedValueOnce(new Error("Drive is unavailable."));
    await failing.prefill(WRITE_URL);
    expect(failing.values()).toEqual({ target: "folder:F", access: "write" });
    expect(failing.notices()).toEqual(
      [...info(PRESET_PENDING), { tone: "error", text: "Drive is unavailable." }]);
    expect(failing.action()).toMatchObject({ label: "Check again" });
    expect(failing.ready()).toBe(false);

    const account = await open();
    await expect(account.prefill("https://drive.google.com/drive/my-drive?access=write"))
      .resolves.toEqual({ target: "drive", access: "write" });
    const file = await open();
    await expect(file.prefill("https://drive.google.com/file/d/F/view?access=write"))
      .resolves.toEqual({ target: "file:F", access: "write" });
  });

  it("opens on Read only for any other value, without asking the account", async () => {
    for (const query of ["?access=read", "?access=WRITE", "?access=", "?usp=sharing", ""]) {
      const frame = await open();
      const seeded = await frame.prefill(`https://drive.google.com/drive/folders/F${query}`);
      expect(seeded, query).toEqual({ target: "folder:F" });
      // `toEqual` reads a key holding undefined as absent.
      expect(seeded, query).not.toHaveProperty("access");
      expect(frame.access(), query).toMatchObject({ value: "read" });
      expect(frame.ui.getWriteAccess, query).not.toHaveBeenCalled();
    }

    const doc = await open();
    const seeded = await doc.prefill("https://docs.google.com/document/d/D1/edit?access=write");
    expect(seeded).toEqual({ target: "doc:D1", checked: "doc:D1" });
    expect(seeded).not.toHaveProperty("access");
    expect(doc.ui.getWriteAccess).not.toHaveBeenCalled();
  });

  it("says the choice may have to be made again on a card that lacks an editable type", async () => {
    // The Google Drive card of an account without the Sheets type.
    const lacking = await open([ACCOUNT, FOLDER, FILE, DOC, SLIDES]);
    await chooseWrite(lacking);
    expect(lacking.notices()).toEqual(info(`${WRITE_PROMPT} ${RESTART_HINT}`));

    // Said before the click only.
    lacking.action().onClick();
    await settle();
    expect(lacking.notices()).toEqual(info(WAITING));

    // An older Workshop, the whole card, and a blueprint's folder binding.
    for (const accepted of [undefined, [ACCOUNT, FOLDER, FILE, DOC, SHEETS, SLIDES], [FOLDER]]) {
      const frame = await open(accepted);
      await chooseWrite(frame);
      expect(frame.notices(), String(accepted)).toEqual(info(WRITE_PROMPT));
      frame.action().onClick();
      await settle();
      expect(frame.notices(), String(accepted)).toEqual(info(WAITING));
    }
  });

  it.each([
    ["failure", (read: PromiseWithResolvers<DriveWriteAccess>) => read.reject(new Error("Connection lost."))],
    ["answer", (read: PromiseWithResolvers<DriveWriteAccess>) => read.resolve(held())],
  ])("shows no older click's in-flight %s over a newer click's request", async (_, finish) => {
    const frame = await open();
    await chooseWrite(frame);
    frame.action().onClick();
    await settle();
    expect(frame.notices()).toEqual(info(WAITING));

    // The older click's poll is reading when the newer click is made.
    const older = Promise.withResolvers<DriveWriteAccess>();
    frame.ui.getWriteAccess.mockReturnValueOnce(older.promise);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.ui.getWriteAccess).toHaveBeenCalledTimes(2);
    const newer = Promise.withResolvers<boolean>();
    frame.ensureResources.mockReturnValueOnce(newer.promise);
    frame.action().onClick();
    expect(frame.ensureResources).toHaveBeenCalledTimes(2);
    expect(frame.notices()).toEqual(info(WRITE_PROMPT));
    expect(frame.action().disabled).toBe(true);

    finish(older);
    await settle();

    expect(frame.notices()).toEqual(info(WRITE_PROMPT));
    // Workshop is still opening the newer click's window, so no other click is taken.
    expect(frame.action().disabled).toBe(true);
    expect(frame.ready()).toBe(false);
  });

  it("says a level the resource URL chose in the form's first line, above the list", async () => {
    const ready = await open();
    ready.ui.getWriteAccess.mockResolvedValue(held());
    await ready.prefill(WRITE_URL);
    expect(ready.order()).toEqual([PRESET_READY, "HierarchyPicker", "RadioCards"]);
    expect(ready.ready()).toBe(true);

    const missing = await open();
    await missing.prefill(WRITE_URL);
    expect(missing.order()).toEqual([PRESET_PENDING, "HierarchyPicker", "RadioCards", WRITE_PROMPT]);
    expect(missing.ready()).toBe(false);
    // Allowing changes is not a choice of level: the line stays, and says the form is ready.
    missing.action().onClick();
    missing.ui.getWriteAccess.mockResolvedValue(held());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(missing.order()).toEqual([PRESET_READY, "HierarchyPicker", "RadioCards", ALLOWED]);
    expect(missing.ready()).toBe(true);

    const failing = await open();
    failing.ui.getWriteAccess.mockRejectedValueOnce(new Error("Drive is unavailable."));
    await failing.prefill(WRITE_URL);
    expect(failing.notices()).toEqual(
      [...info(PRESET_PENDING), { tone: "error", text: "Drive is unavailable." }]);
  });

  // Each call changes the value, as a real card's does: the cards report nothing for the one already selected.
  it("drops that line once Read only is chosen, and never shows it for a choice made by hand", async () => {
    const frame = await open();
    frame.ui.getWriteAccess.mockResolvedValue(held());
    await frame.prefill(WRITE_URL);
    expect(frame.notices()).toEqual(info(PRESET_READY));

    frame.chooseAccess("read");
    expect(frame.notices()).toEqual([]);
    expect(frame.url()).toBe("https://drive.google.com/drive/folders/F");

    // Read and write chosen again is the user's own choice, of an account known to allow changes.
    frame.chooseAccess("write");
    expect(frame.ready()).toBe(true);
    await settle();
    expect(frame.notices()).toEqual([]);
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe(WRITE_URL);
    expect(frame.ui.getWriteAccess).toHaveBeenCalledTimes(1);

    const byHand = await open();
    await chooseWrite(byHand);
    expect(byHand.notices()).toEqual(info(WRITE_PROMPT));

    const readOnly = await open();
    await readOnly.prefill("https://drive.google.com/drive/folders/F");
    expect(readOnly.notices()).toEqual([]);
  });

  it("shows that line only while the pre-set level would be connected", async () => {
    const frame = await open();
    frame.ui.getWriteAccess.mockResolvedValue(held());
    await frame.prefill(WRITE_URL);
    frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [NATIVE_DOC] });
    await frame.list("folder:F");

    // A Doc that connects as its editable type takes no access level.
    frame.choose("doc:D");
    expect(frame.notices()).toEqual([]);
    expect(frame.url()).toBe("https://docs.google.com/document/d/D/edit");

    // Read and write is still what a Drive type connects as, and still not the user's own choice.
    frame.choose("folder:G");
    expect(frame.order()).toEqual([PRESET_READY, "HierarchyPicker", "RadioCards"]);
    expect(frame.url()).toBe("https://drive.google.com/drive/folders/G?access=write");
  });
});
