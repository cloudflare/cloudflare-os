// The Drive picker connects a Docs, Sheets or Slides file as its editable type, converting an Office
// file into one first. This drives that flow as the sandbox runtime would.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_DOC_RESOURCE, GOOGLE_DRIVE_FILE_RESOURCE, GOOGLE_DRIVE_FOLDER_RESOURCE, GOOGLE_DRIVE_RESOURCE,
  GOOGLE_SHEETS_RESOURCE, GOOGLE_SLIDES_RESOURCE, OFFICE_IMPORT_GRANT, parseResourceUrl,
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
  Section: "Section",
}));

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

const COPY_DATE = "2026-10-04T00:00:00.000Z";

/**
 * A fresh module, since it keeps the flow at module level, and the frame the sandbox runtime gives
 * it: values, the calls it makes, and its rendered tree.
 */
async function open(accepted?: string[]) {
  vi.resetModules();
  const spec = (await import("../src/configurator/drive-configurator-ui")).default as unknown as Spec;
  let values: Values = { ...spec.initial };
  const ui = {
    inspectFile: vi.fn(async (_kind: string, _fileId: string): Promise<unknown> => ({ type: "native" })),
    listDriveNodes: vi.fn(async (_parentId: string): Promise<unknown> => ({ nodes: [] })),
    getDriveNode: vi.fn(async (_id: string): Promise<unknown> => null),
    hasConversionAccess: vi.fn(async () => false),
    convertFile: vi.fn(async (_kind: string, _fileId: string, _opts?: { reuse?: string }): Promise<unknown> =>
      ({ type: "needsAccess" })),
  };
  const ensureResources = vi.fn(async (_patterns: string[]) => true);
  const context = () => ({
    values,
    setValues: (patch: Values) => { values = { ...values, ...patch }; },
    ensureResources,
    ui,
    acceptedResourceUrlPatterns: accepted,
  });
  const find = (component: string) => nodes(spec.render(context())).filter(node => node.component === component);
  const prefill = (resourceUrl: string) => spec.initialValuesFromResourceUrl({
    resourceUrl, resourceUrlPattern: GOOGLE_SHEETS_RESOURCE.urlPattern, ui, acceptedResourceUrlPatterns: accepted,
  }).then(patch => {
    values = { ...values, ...patch };
    return patch;
  });
  return {
    spec, ui, ensureResources, find, prefill,
    values: () => values,
    ready: () => spec.isReady({ values, acceptedResourceUrlPatterns: accepted }),
    url: () => spec.resourceUrl({ values, acceptedResourceUrlPatterns: accepted }),
    choose: (target: string | null) => find("HierarchyPicker")[0].props.onChange(target),
    loadItem: (id: string) => find("HierarchyPicker")[0].props.loadItem(id),
    list: (parentId: string) => find("HierarchyPicker")[0].props.loadItems({ parentId, query: "", cursor: null }),
    notices: () => find("Notice").map(node => ({ tone: node.props.tone, text: text(node) })),
    action: () => find("Notice").map(node => node.props.action).find(Boolean),
    button: (label: string | RegExp) => find("Button").find(node =>
      typeof label === "string" ? text(node) === label : label.test(text(node)))?.props,
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

const officeFile = (overrides: Values = {}) => ({
  type: "office", canCopy: true, ...overrides,
});

const converted = (overrides: Values = {}) => ({
  type: "converted", fileId: "copy-1", title: "Report", location: "besideOriginal", reused: false, ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each([
  ["doc", GOOGLE_DOC_RESOURCE, "document", { kind: "doc", documentId: "native-1" }],
  ["sheets", GOOGLE_SHEETS_RESOURCE, "spreadsheets", { kind: "sheets", spreadsheetId: "native-1" }],
  ["slides", GOOGLE_SLIDES_RESOURCE, "presentation", { kind: "slides", presentationId: "native-1" }],
] as const)("a native %s file", (kind, resource, path, parsed) => {
  it("is checked, then connects as its editable type", async () => {
    const frame = await open();

    frame.choose(`${kind}:native-1`);
    expect(frame.ready()).toBe(false);
    await settle();

    expect(frame.ui.inspectFile).toHaveBeenCalledWith(kind, "native-1");
    expect(frame.ready()).toBe(true);
    expect(frame.notices()).toEqual([]);
    expect(frame.url()).toBe(`https://docs.google.com/${path}/d/native-1/edit`);
    expect(parseResourceUrl(frame.url())).toEqual(parsed);
  });

  // The configurator copies each type's pattern; a blueprint binding names one, as accepted.
  it("binds the type the Workshop accepts, read-only as a Drive file when that is all it takes", async () => {
    const editable = await open([resource.urlPattern]);
    editable.choose(`${kind}:native-1`);
    await settle();
    expect(editable.ready()).toBe(true);
    expect(editable.notices()).toEqual([]);

    const readOnly = await open([GOOGLE_DRIVE_FILE_RESOURCE.urlPattern]);
    readOnly.choose(`${kind}:native-1`);
    expect(readOnly.ui.inspectFile).not.toHaveBeenCalled();
    expect(readOnly.ready()).toBe(true);
    expect(parseResourceUrl(readOnly.url())).toEqual({ kind: "driveFile", fileId: "native-1" });
    expect(readOnly.notices()).toEqual([{ tone: undefined, text: "Connects read-only as a Drive file." }]);
    expect(readOnly.action()).toBeUndefined();
  });

  it("is read back from its editor's URL", async () => {
    const frame = await open();

    await expect(frame.prefill(`https://docs.google.com/${path}/d/native-1/edit?usp=sharing`))
      .resolves.toEqual({ target: `${kind}:native-1`, checked: `${kind}:native-1` });
    expect(frame.ready()).toBe(true);
  });
});

describe("the Drive picker's Office flow", () => {
  async function chooseOffice(overrides: Values = {}) {
    const frame = await open();
    frame.ui.inspectFile.mockResolvedValue(officeFile(overrides));
    frame.choose("sheets:source-1");
    await settle();
    return frame;
  }

  it("connects the file as it is when Drive cannot say what it is", async () => {
    const frame = await open();
    frame.ui.inspectFile.mockRejectedValue(new Error("Drive is down"));

    frame.choose("sheets:file-1");
    await settle();

    expect(frame.ready()).toBe(true);
  });

  it("connects a folder or a plain file without asking what it is", async () => {
    const frame = await open();

    frame.choose("file:F1");

    expect(frame.ready()).toBe(true);
    expect(frame.ui.inspectFile).not.toHaveBeenCalled();
  });

  it("holds an Office file back until it is converted, and says what converting does", async () => {
    const frame = await chooseOffice();

    expect(frame.ready()).toBe(false);
    expect(frame.values().target).toBe("sheets:source-1");
    expect(frame.notices()).toEqual([{
      tone: undefined,
      text: "Connecting makes a Google Sheets copy next to the original. The original is " +
        "unchanged, and later edits to it won't sync.",
    }]);
    expect(frame.button("Convert")).toEqual(expect.objectContaining({ variant: "primary" }));
    expect(frame.button(/^Use the copy/)).toBeUndefined();
  });

  it("refuses a file this kind cannot convert", async () => {
    const frame = await open();
    frame.ui.inspectFile.mockResolvedValue({ type: "unsupported" });

    frame.choose("sheets:csv-1");
    await settle();

    expect(frame.ready()).toBe(false);
    expect(frame.notices()).toEqual([expect.objectContaining({ tone: "error" })]);
    expect(frame.find("Button")).toEqual([]);
  });

  it("refuses a file the gatekeeper turns down, so it never becomes connectable", async () => {
    const frame = await open();
    frame.ui.inspectFile.mockResolvedValue({ type: "refused", message: "In the trash." });

    frame.choose("sheets:source-1");
    await settle();

    expect(frame.ready()).toBe(false);
    expect(frame.notices()).toEqual([{ tone: "error", text: "In the trash." }]);
    expect(frame.find("Button")).toEqual([]);
  });

  it.each([
    ["the gatekeeper turns down", { type: "refused", message: "In the trash." }, "In the trash."],
    ["cannot be converted", { type: "unsupported" }, "This file isn't a Google Sheets file, or an Office file that can be converted into one."],
  ])("opens a pasted URL whose file %s on why it cannot be connected", async (_, inspection, message) => {
    const frame = await open();
    frame.ui.inspectFile.mockResolvedValue(inspection);

    await expect(frame.prefill("https://docs.google.com/spreadsheets/d/source-1/edit"))
      .resolves.toEqual({ target: "sheets:source-1" });
    expect(frame.ready()).toBe(false);
    expect(frame.notices()).toEqual([{ tone: "error", text: message }]);
    expect(frame.find("Button")).toEqual([]);
  });

  it("offers no Convert when the owner has turned off copying", async () => {
    const frame = await chooseOffice({ canCopy: false });

    expect(frame.notices()).toEqual([{
      tone: "error",
      text: "The owner of this file has turned off copying, so it can't be converted into a Google Sheets file.",
    }]);
    expect(frame.find("Button")).toEqual([]);
    expect(frame.ready()).toBe(false);
  });

  it("still offers the copy made before once the owner has turned off copying", async () => {
    const convertedAt = new Date(COPY_DATE);
    const frame = await chooseOffice({
      canCopy: false, existingCopy: { fileId: "copy-a", title: "Report", convertedAt },
    });

    expect(frame.notices()).toEqual([{
      tone: "error",
      text: "The owner of this file has turned off copying, so it can't be converted again, but " +
        "the copy made before can still be used.",
    }]);
    expect(frame.button("Convert")).toBeUndefined();
    expect(frame.button(`Use the copy made on ${convertedAt.toLocaleDateString()}`)).toBeDefined();
    expect(frame.ready()).toBe(false);
  });

  it("asks for access from the click, then converts and connects the copy", async () => {
    const frame = await chooseOffice();
    frame.ui.convertFile.mockResolvedValue(converted());

    frame.button("Convert")!.onClick();
    // Synchronously, so the click's activation still lets Workshop open the pop-up.
    expect(frame.ensureResources).toHaveBeenCalledWith([OFFICE_IMPORT_GRANT]);
    expect(frame.button("Convert")!.disabled).toBe(true);
    await settle();

    expect(frame.ui.convertFile).toHaveBeenCalledWith("sheets", "source-1");
    expect(frame.values().target).toBe("sheets:copy-1");
    expect(frame.ready()).toBe(true);
    expect(frame.url()).toBe("https://docs.google.com/spreadsheets/d/copy-1/edit");
    expect(frame.notices()).toEqual([{
      tone: undefined,
      text: 'Made the Google Sheets copy "Report" next to the original. The original is ' +
        "unchanged, and later edits to it won't sync.",
    }]);
  });

  it("keeps the copy chosen while Drive cannot find it yet", async () => {
    const frame = await chooseOffice();
    frame.ui.convertFile.mockResolvedValue(converted());
    frame.button("Convert")!.onClick();
    await settle();

    frame.ui.getDriveNode.mockRejectedValueOnce(new Error("Drive is unavailable"));
    await expect(frame.loadItem("sheets:copy-1"))
      .resolves.toMatchObject({ id: "sheets:copy-1", title: "Report", kind: "leaf", icon: "sheet", selectable: true });
    await expect(frame.loadItem("sheets:copy-1")).resolves.toMatchObject({ id: "sheets:copy-1" });
    // Any other lookup is left to fail as it does.
    frame.ui.getDriveNode.mockRejectedValueOnce(new Error("Drive is unavailable"));
    await expect(frame.loadItem("file:other")).rejects.toThrow("Drive is unavailable");
    await expect(frame.loadItem("file:other")).resolves.toBeNull();
  });

  it("waits for the pop-up's grant, polling, and says when the copy is in My Drive", async () => {
    const frame = await chooseOffice();
    frame.ensureResources.mockResolvedValue(false);
    frame.ui.hasConversionAccess.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    frame.ui.convertFile.mockResolvedValue(converted({ location: "myDrive" }));

    frame.button("Convert")!.onClick();
    await settle();
    expect(frame.notices().map(notice => notice.text)).toContain("Waiting for access in the pop-up…");
    expect(frame.ui.convertFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.ui.hasConversionAccess).toHaveBeenCalledTimes(1);
    expect(frame.ui.convertFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(frame.ui.convertFile).toHaveBeenCalledTimes(1);
    expect(frame.values().target).toBe("sheets:copy-1");
    expect(frame.notices()[0].text).toContain("in My Drive, because the original's folder could not take it");
  });

  it("goes back to waiting when the gatekeeper says the pop-up's grant is not there yet", async () => {
    const frame = await chooseOffice();
    frame.ensureResources.mockResolvedValue(false);
    frame.ui.convertFile.mockResolvedValueOnce({ type: "needsAccess" }).mockResolvedValueOnce(converted());
    frame.ui.hasConversionAccess.mockResolvedValue(true);

    frame.button("Convert")!.onClick();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.ui.convertFile).toHaveBeenCalledTimes(1);
    expect(frame.notices().map(notice => notice.text)).toContain("Waiting for access in the pop-up…");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.ui.convertFile).toHaveBeenCalledTimes(2);
    expect(frame.values().target).toBe("sheets:copy-1");
  });

  it("does not wait for a pop-up that was never opened when the grant is reported held", async () => {
    const frame = await chooseOffice();
    frame.ui.convertFile.mockResolvedValue({ type: "needsAccess" });

    frame.button("Convert")!.onClick();
    await settle();

    expect(frame.notices()).toContainEqual({
      tone: "error", text: "Google hasn't granted access to copy the file. Select Convert to try again.",
    });
    expect(frame.button("Convert")!.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(frame.ui.hasConversionAccess).not.toHaveBeenCalled();
    expect(frame.ready()).toBe(false);
  });

  it("gives up after three minutes without the grant, and lets Convert be tried again", async () => {
    const frame = await chooseOffice();
    frame.ensureResources.mockResolvedValue(false);

    frame.button("Convert")!.onClick();
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(frame.ui.hasConversionAccess).toHaveBeenCalledTimes(90);
    expect(frame.ui.convertFile).not.toHaveBeenCalled();
    expect(frame.notices()).toContainEqual({
      tone: "error", text: "Access wasn't granted within 3 minutes. Select Convert to try again.",
    });
    expect(frame.button("Convert")!.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(frame.ui.hasConversionAccess).toHaveBeenCalledTimes(90);
  });

  it("shows why access was not given, and lets Convert be tried again", async () => {
    const frame = await chooseOffice();
    frame.ensureResources.mockRejectedValue(new Error("The pop-up was closed."));

    frame.button("Convert")!.onClick();
    await settle();

    expect(frame.notices()).toContainEqual({ tone: "error", text: "The pop-up was closed." });
    expect(frame.button("Convert")!.disabled).toBe(false);
    expect(frame.ui.convertFile).not.toHaveBeenCalled();
  });

  it("looks again after a failed copy, and offers a copy Drive made despite the failure", async () => {
    const frame = await chooseOffice();
    const convertedAt = new Date(COPY_DATE);
    frame.ui.convertFile.mockRejectedValue(new Error("Google Drive could not make the copy [http=500]."));
    frame.ui.inspectFile.mockResolvedValue(officeFile({
      existingCopy: { fileId: "copy-lost", title: "Report", convertedAt },
    }));

    frame.button("Convert")!.onClick();
    await settle();

    expect(frame.ui.inspectFile).toHaveBeenCalledTimes(2);
    expect(frame.notices()).toContainEqual({ tone: "error", text: "Google Drive could not make the copy [http=500]." });
    expect(frame.button("Convert")!.disabled).toBe(false);
    expect(frame.button(`Use the copy made on ${convertedAt.toLocaleDateString()}`)).toBeDefined();
    expect(frame.ready()).toBe(false);
  });

  it("shows a failed copy at once, before looking at the file again", async () => {
    const frame = await chooseOffice();
    frame.ui.convertFile.mockRejectedValue(new Error("Google Drive could not make the copy [http=500]."));
    frame.ui.inspectFile.mockReturnValue(new Promise(() => {}));

    frame.button("Convert")!.onClick();
    await settle();

    expect(frame.notices()).toContainEqual({ tone: "error", text: "Google Drive could not make the copy [http=500]." });
    expect(frame.notices().map(notice => notice.text)).not.toContain("Making the copy…");
  });

  it("drops a copy that is gone when reusing it fails", async () => {
    const convertedAt = new Date(COPY_DATE);
    const frame = await chooseOffice({
      canCopy: false, existingCopy: { fileId: "copy-a", title: "Report", convertedAt },
    });
    frame.ui.convertFile.mockRejectedValue(new Error("That copy is no longer available."));
    frame.ui.inspectFile.mockResolvedValue(officeFile({ canCopy: false }));

    frame.button(`Use the copy made on ${convertedAt.toLocaleDateString()}`)!.onClick();
    await settle();

    expect(frame.find("Button")).toEqual([]);
    expect(frame.ready()).toBe(false);
  });

  it("offers the copy made before, dated, and reuses it without asking for access", async () => {
    const convertedAt = new Date(COPY_DATE);
    const frame = await chooseOffice({ existingCopy: { fileId: "copy-a", title: "Report", convertedAt } });
    frame.ui.convertFile.mockResolvedValue(converted({ fileId: "copy-a", reused: true }));

    const reuse = frame.button(`Use the copy made on ${convertedAt.toLocaleDateString()}`);
    expect(reuse).toEqual(expect.objectContaining({ variant: "secondary" }));
    reuse!.onClick();
    await settle();

    expect(frame.ensureResources).not.toHaveBeenCalled();
    expect(frame.ui.convertFile).toHaveBeenCalledWith("sheets", "source-1", { reuse: "copy-a" });
    expect(frame.values().target).toBe("sheets:copy-a");
    expect(frame.notices()[0].text).toBe(
      'Using the Google Sheets copy "Report" made earlier, next to the original. Later edits to ' +
      "the original won't sync.");
  });

  it("drops a conversion whose file was changed while it waited for access", async () => {
    const frame = await chooseOffice();
    let grant!: (held: boolean) => void;
    frame.ensureResources.mockReturnValue(new Promise(resolve => { grant = resolve; }));

    frame.button("Convert")!.onClick();
    frame.ui.inspectFile.mockResolvedValue({ type: "native" });
    frame.choose("sheets:native-1");
    await settle();
    grant(true);
    await settle();

    expect(frame.ui.convertFile).not.toHaveBeenCalled();
    expect(frame.values().target).toBe("sheets:native-1");
    expect(frame.notices()).toEqual([]);
  });

  it("stops polling once the choice is let go of", async () => {
    const frame = await chooseOffice();
    frame.ensureResources.mockResolvedValue(false);

    frame.button("Convert")!.onClick();
    await settle();
    frame.choose(null);
    frame.ui.hasConversionAccess.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(frame.ui.convertFile).not.toHaveBeenCalled();
    expect(frame.values().target).toBeNull();
    expect(frame.notices()).toEqual([]);
  });

  it("drops a copy made after a newer choice", async () => {
    const frame = await chooseOffice();
    let finish!: (result: unknown) => void;
    frame.ui.convertFile.mockReturnValue(new Promise(resolve => { finish = resolve; }));

    frame.button("Convert")!.onClick();
    await settle();
    frame.choose("folder:D1");
    finish(converted());
    await settle();

    expect(frame.values().target).toBe("folder:D1");
    expect(frame.notices()).toEqual([]);
    expect(frame.ready()).toBe(true);
  });

  it("withdraws a connectable file at once when another is chosen", async () => {
    const frame = await open();
    frame.choose("sheets:native-1");
    await settle();
    expect(frame.ready()).toBe(true);
    frame.ui.inspectFile.mockReturnValueOnce(new Promise(() => {}));

    frame.choose("sheets:source-1");

    expect(frame.ready()).toBe(false);
  });

  it("says it is checking a file only once the check is slow", async () => {
    const frame = await open();
    let answer!: (inspection: unknown) => void;
    frame.ui.inspectFile.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));

    frame.choose("sheets:source-1");
    expect(frame.notices()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frame.notices()).toEqual([{ tone: undefined, text: "Checking the file…" }]);

    answer({ type: "native" });
    await settle();
    expect(frame.notices()).toEqual([]);
  });

  it("never says it is checking a file once a quick check has settled", async () => {
    const frame = await open();

    frame.choose("sheets:native-1");
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(frame.notices()).toEqual([]);
    expect(frame.ready()).toBe(true);
  });

  const NATIVE = "application/vnd.google-apps.spreadsheet";
  const OFFICE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  it.each([
    ["connects a listed native file without asking Drive", [NATIVE], true],
    ["still checks a listed Office file", [OFFICE], false],
    ["checks a file again once a later listing shows it is no longer native", [NATIVE, OFFICE], false],
  ])("%s", async (_, mimeTypes, native) => {
    const frame = await open();
    for (const mimeType of mimeTypes) {
      frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [{ id: "sheets:file-1", title: "Budget", kind: "file", mimeType }] });
      await frame.list("folder:A");
    }

    frame.choose("sheets:file-1");

    expect(frame.ready()).toBe(native);
    expect(frame.ui.inspectFile).toHaveBeenCalledTimes(native ? 0 : 1);
  });

  it("drops an inspection that a newer choice overtook", async () => {
    const frame = await open();
    let answer!: (inspection: unknown) => void;
    frame.ui.inspectFile.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));

    frame.choose("sheets:source-1");
    frame.choose("sheets:native-1");
    await settle();
    answer(officeFile());
    await settle();

    expect(frame.values().target).toBe("sheets:native-1");
    expect(frame.ready()).toBe(true);
    expect(frame.notices()).toEqual([]);
  });

  it("drops a pasted URL's inspection that a choice overtook", async () => {
    const frame = await open();
    let answer!: (inspection: unknown) => void;
    frame.ui.inspectFile.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));

    const prefilled = frame.prefill("https://docs.google.com/spreadsheets/d/source-1/edit");
    frame.choose("sheets:native-1");
    await settle();
    answer(officeFile());

    await expect(prefilled).resolves.toEqual({});
    expect(frame.values().target).toBe("sheets:native-1");
    expect(frame.notices()).toEqual([]);
  });

  it("opens a pasted Office file's URL on its conversion", async () => {
    const frame = await open();
    frame.ui.inspectFile.mockResolvedValue(officeFile());

    await expect(frame.prefill("https://docs.google.com/spreadsheets/d/source-1/edit?rtpof=true"))
      .resolves.toEqual({ target: "sheets:source-1" });

    expect(frame.ui.inspectFile).toHaveBeenCalledWith("sheets", "source-1");
    expect(frame.ready()).toBe(false);
    expect(frame.button("Convert")).toBeDefined();
  });

  // The server binds the segment as it is; the prefill leaves an ID outside Drive's alphabet,
  // which no Drive file has, to be chosen by hand rather than sent to `inspectFile`.
  it.for([
    "https://docs.google.com/spreadsheets/u/0/",
    "https://docs.google.com/spreadsheets/d/bad%2Fid/edit",
    "not a url",
  ])("prefills nothing, and asks nothing, for %s", async url => {
    const frame = await open();

    await expect(frame.prefill(url)).resolves.toEqual({});
    expect(frame.ui.inspectFile).not.toHaveBeenCalled();
  });
});

describe("the Drive picker on a Drive card account without an editable type's grant", () => {
  const DRIVE_TYPES = [GOOGLE_DRIVE_RESOURCE, GOOGLE_DRIVE_FOLDER_RESOURCE, GOOGLE_DRIVE_FILE_RESOURCE]
    .map(resource => resource.urlPattern);

  it("connects a file read-only, and offers to ask for every editable type the account lacks", async () => {
    const frame = await open([...DRIVE_TYPES, GOOGLE_DOC_RESOURCE.urlPattern]);
    const asked = Promise.withResolvers<boolean>();
    frame.ensureResources.mockReturnValue(asked.promise);
    frame.choose("sheets:native-1");

    expect(frame.ready()).toBe(true);
    expect(parseResourceUrl(frame.url())).toEqual({ kind: "driveFile", fileId: "native-1" });
    expect(frame.notices()).toEqual([{
      tone: undefined,
      text: "Connects read-only as a Drive file. To edit it as a Google Sheets file, allow editing and choose it again.",
    }]);

    frame.action()!.onClick();
    // Synchronously, so the click's activation still lets Workshop open the pop-up.
    expect(frame.ensureResources).toHaveBeenCalledWith([GOOGLE_SHEETS_RESOURCE.urlPattern, GOOGLE_SLIDES_RESOURCE.urlPattern]);
    // Held while Google's window is open, so a second click opens no second window.
    expect(frame.action()!.disabled).toBe(true);
    asked.resolve(false);
    await settle();
    expect(frame.action()!.disabled).toBeFalsy();
  });

  it("shows why asking failed until another file is chosen, and once the account holds the types the card leaves out, says so", async () => {
    const frame = await open([...DRIVE_TYPES, GOOGLE_DOC_RESOURCE.urlPattern]);
    frame.ensureResources.mockRejectedValueOnce(new Error("The pop-up was blocked.")).mockResolvedValueOnce(true);
    frame.choose("sheets:native-1");

    frame.action()!.onClick();
    await settle();
    expect(frame.notices()).toEqual([{ tone: "error", text: "The pop-up was blocked." }]);
    frame.choose("slides:native-2");
    expect(frame.notices()).toEqual([{
      tone: undefined,
      text: "Connects read-only as a Drive file. To edit it as a Google Slides file, allow editing and choose it again.",
    }]);

    frame.action()!.onClick();
    await settle();
    expect(frame.notices()).toEqual([{
      tone: undefined, text: "Editing isn't available here, so this connects read-only as a Drive file.",
    }]);
    expect(frame.action()).toBeUndefined();
    expect(frame.ready()).toBe(true);
  });
});
