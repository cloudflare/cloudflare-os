// The Docs, Sheets and Slides configurators share one Office conversion flow, but
// `scripts/build-gatekeeper-configurator.ts` transpiles each module on its own, so none can import
// it from another or from the gatekeeper. Each file carries a copy below its `// office-flow:`
// marker, kind-specific only through the constants above it. The first block keeps the copies, and
// their grant URL, in step; the rest drives the flow as the sandbox runtime would.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFICE_KINDS, type OfficeKind } from "../src/office-conversion";
import { OFFICE_IMPORT_GRANT, RESOURCE_BY_KIND } from "../src/resources";
import { nodes, text } from "./configurator-tree";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({
    component, props: props ?? {}, children,
  }),
  Autocomplete: "Autocomplete",
  Button: "Button",
  Field: "Field",
  Fragment: "Fragment",
  Notice: "Notice",
  Section: "Section",
}));

const MARKER = "// office-flow:";

type KindCase = {
  kind: OfficeKind;
  file: string;
  idField: string;
  urlPath: string;
  label: string;
  load: () => Promise<{ default: unknown }>;
};

const KIND_CASES: KindCase[] = [
  {
    kind: "doc", file: "google-doc-configurator-ui.tsx", idField: "docId", urlPath: "document",
    label: "docx", load: () => import("../src/configurator/google-doc-configurator-ui"),
  },
  {
    kind: "sheets", file: "google-sheets-configurator-ui.tsx", idField: "spreadsheetId",
    urlPath: "spreadsheets", label: "xlsx",
    load: () => import("../src/configurator/google-sheets-configurator-ui"),
  },
  {
    kind: "slides", file: "google-slides-configurator-ui.tsx", idField: "presentationId",
    urlPath: "presentation", label: "pptx",
    load: () => import("../src/configurator/google-slides-configurator-ui"),
  },
];

const source = (file: string) =>
  readFile(join(import.meta.dirname, "../src/configurator", file), "utf8");

/** A module's kind-specific head and its shared flow. */
async function split(file: string): Promise<{ head: string; flow: string }> {
  const contents = await source(file);
  const at = contents.indexOf(MARKER);
  expect(at, `${file} has no ${MARKER} marker`).toBeGreaterThan(0);
  expect(contents.indexOf(MARKER, at + 1)).toBe(-1);
  return { head: contents.slice(0, at), flow: contents.slice(at) };
}

function headConstants(head: string): Record<string, string> {
  return Object.fromEntries([...head.matchAll(/^const (\w+) = "([^"]*)";$/gm)]
    .map(([, name, value]) => [name, value]));
}

describe("the shared Office conversion flow", () => {
  it("is the same text in the Docs, Sheets and Slides configurators", async () => {
    const [doc, sheets, slides] = await Promise.all(KIND_CASES.map(({ file }) => split(file)));
    expect(sheets.flow).toBe(doc.flow);
    expect(slides.flow).toBe(doc.flow);
  });

  it("asks for the grant resources.ts defines", async () => {
    const { flow } = await split(KIND_CASES[0].file);
    expect(flow).toContain(`const OFFICE_IMPORT_GRANT = ${JSON.stringify(OFFICE_IMPORT_GRANT)};`);
  });

  it.each(KIND_CASES)("is specialised for $kind only by constants that match the gatekeeper", async (
    { kind, file, idField, urlPath },
  ) => {
    const { head } = await split(file);
    const constants = headConstants(head);
    expect(constants.ID_FIELD).toBe(idField);
    expect(RESOURCE_BY_KIND[kind].urlPattern)
      .toBe(`https://docs.google.com/${urlPath}/d/:${idField}/*`);
    expect(constants.URL_PATH).toBe(urlPath);
    expect(constants.KIND_TITLE).toBe(OFFICE_KINDS[kind].resourceTitle);
    // Nothing else in the head may vary the flow: just these constants and the listing call.
    const code = head
      .replace(/^import[\s\S]*?;$/gm, "")
      .replace(/^const \w+ = "[^"]*";$/gm, "")
      .replace(/^const loadFiles = \(ui: Rpc, query: string\) => ui\.\w+\(query\);$/m, "")
      .trim();
    expect(code).toBe("");
  });
});

type Spec = {
  initial: Record<string, string | null | undefined>;
  isReady(context: { values: Record<string, unknown> }): boolean;
  initialValuesFromResourceUrl(context: {
    resourceUrl: string; resourceUrlPattern: string; ui: unknown;
  }): Promise<Record<string, unknown>>;
  render(context: unknown): unknown;
};

const XLSX_COPY = "2026-10-04T00:00:00.000Z";

/**
 * A fresh configurator module, and the frame the sandbox runtime gives it: values, the calls it
 * makes, and its rendered tree.
 */
async function open({ load }: KindCase) {
  vi.resetModules();
  const spec = (await load()).default as Spec;
  let values: Record<string, unknown> = { ...spec.initial };
  const cleared: string[] = [];
  const ui = {
    inspectFile: vi.fn(async (_fileId: string): Promise<unknown> => ({ type: "native" })),
    hasConversionAccess: vi.fn(async () => false),
    convertFile: vi.fn(async (_fileId: string, _opts?: { reuse?: string }): Promise<unknown> =>
      ({ type: "needsAccess" })),
  };
  const ensureResources = vi.fn(async (_patterns: string[]) => true);
  const context = () => ({
    values,
    setValues: (patch: Record<string, unknown>) => { values = { ...values, ...patch }; },
    clearFields: (...names: string[]) => cleared.push(...names),
    ensureResources,
    ui,
  });
  const tree = () => spec.render(context());
  const find = (component: string) => nodes(tree()).filter(node => node.component === component);
  return {
    spec, ui, ensureResources, cleared, tree, find,
    values: () => values,
    ready: () => spec.isReady({ values }),
    autocomplete: () => find("Autocomplete")[0].props,
    notices: () => find("Notice").map(node => ({ tone: node.props.tone, text: text(node) })),
    button: (label: string | RegExp) => find("Button").find(node =>
      typeof label === "string" ? text(node) === label : label.test(text(node)))?.props,
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

const officeFile = (label: string, overrides: Record<string, unknown> = {}) => ({
  type: "office", title: `Report.${label}`, label, canCopy: true, ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(KIND_CASES)("the $kind configurator's Office flow", testCase => {
  const { idField, label, kind } = testCase;
  const title = OFFICE_KINDS[kind].resourceTitle;

  async function selectOffice(overrides: Record<string, unknown> = {}) {
    const frame = await open(testCase);
    frame.ui.inspectFile.mockResolvedValue(officeFile(label, overrides));
    frame.autocomplete().onChange("source-1");
    await settle();
    return frame;
  }

  it("connects a native file as it is", async () => {
    const frame = await open(testCase);

    frame.autocomplete().onChange("native-1");
    await settle();

    expect(frame.ui.inspectFile).toHaveBeenCalledWith("native-1");
    expect(frame.values()[idField]).toBe("native-1");
    expect(frame.ready()).toBe(true);
    expect(frame.notices()).toEqual([]);
  });

  it("connects the file as it is when Drive cannot say what it is", async () => {
    const frame = await open(testCase);
    frame.ui.inspectFile.mockRejectedValue(new Error("Drive is down"));

    frame.autocomplete().onChange("file-1");
    await settle();

    expect(frame.values()[idField]).toBe("file-1");
    expect(frame.ready()).toBe(true);
  });

  it("holds an Office file back until it is converted, and says what converting does", async () => {
    const frame = await selectOffice();

    expect(frame.ready()).toBe(false);
    expect(frame.values()[idField]).toBeNull();
    expect(frame.notices()).toEqual([{
      tone: undefined,
      text: `Connecting makes a Google ${title} copy next to the original. The original is ` +
        "unchanged, and later edits to it won't sync.",
    }]);
    expect(frame.button("Convert")).toEqual(expect.objectContaining({ variant: "primary" }));
    expect(frame.button(/^Use the copy/)).toBeUndefined();
  });

  it("refuses a file this kind cannot convert", async () => {
    const frame = await open(testCase);
    frame.ui.inspectFile.mockResolvedValue({ type: "unsupported" });

    frame.autocomplete().onChange("csv-1");
    await settle();

    expect(frame.ready()).toBe(false);
    expect(frame.notices()).toEqual([expect.objectContaining({ tone: "error" })]);
    expect(frame.find("Button")).toEqual([]);
  });

  it.each([
    ["a trashed file", "This file is in the Drive trash. Restore it before converting it."],
    ["a malformed ID", "Not a Google Drive file ID."],
  ])("refuses %s the gatekeeper turns down, so its own ID never becomes connectable", async (
    _case, message,
  ) => {
    const frame = await open(testCase);
    frame.ui.inspectFile.mockResolvedValue({ type: "refused", message });

    frame.autocomplete().onChange("source-1");
    await settle();

    expect(frame.values()[idField]).toBeNull();
    expect(frame.ready()).toBe(false);
    expect(frame.notices()).toEqual([{ tone: "error", text: message }]);
    expect(frame.find("Button")).toEqual([]);
    expect(frame.autocomplete().value).toBe("source-1");
  });

  it("refuses a pasted URL whose file the gatekeeper turns down", async () => {
    const frame = await open(testCase);
    frame.ui.inspectFile.mockResolvedValue({ type: "refused", message: "In the trash." });

    const values = await frame.spec.initialValuesFromResourceUrl({
      resourceUrl: `https://docs.google.com/${testCase.urlPath}/d/source-1/edit`,
      resourceUrlPattern: RESOURCE_BY_KIND[kind].urlPattern,
      ui: frame.ui,
    });

    expect(values).toEqual({});
    expect(frame.notices()).toEqual([{ tone: "error", text: "In the trash." }]);
  });

  it("offers no Convert when the owner has turned off copying", async () => {
    const frame = await selectOffice({ canCopy: false });

    expect(frame.notices()).toEqual([{
      tone: "error",
      text: "The owner of this file has turned off copying, so it can't be converted into a " +
        `Google ${title} file.`,
    }]);
    expect(frame.find("Button")).toEqual([]);
    expect(frame.ready()).toBe(false);
  });

  it("still offers the copy made before once the owner has turned off copying", async () => {
    const convertedAt = new Date(XLSX_COPY);
    const frame = await selectOffice({
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

  it("asks for access from the click, then converts and connects the copy by its title", async () => {
    const frame = await selectOffice();
    frame.ui.convertFile.mockResolvedValue({
      type: "converted", fileId: "copy-1", title: "Report", location: "besideOriginal", reused: false,
    });

    frame.button("Convert")!.onClick();
    // Synchronously, so the click's activation still lets Workshop open the pop-up.
    expect(frame.ensureResources).toHaveBeenCalledWith([OFFICE_IMPORT_GRANT]);
    expect(frame.button("Convert")!.disabled).toBe(true);
    await settle();

    expect(frame.ui.convertFile).toHaveBeenCalledWith("source-1");
    expect(frame.values()[idField]).toBe("copy-1");
    expect(frame.ready()).toBe(true);
    // The typed query is cleared so the field shows the copy's title, not the Office file's.
    expect(frame.cleared).toEqual([idField]);
    expect(frame.autocomplete().placeholder).toBe("Report");
    expect(frame.notices()).toEqual([{
      tone: undefined,
      text: `Made the Google ${title} copy "Report" next to the original. The original is ` +
        "unchanged, and later edits to it won't sync.",
    }]);
  });

  it("waits for the pop-up's grant, polling, and says when the copy is in My Drive", async () => {
    const frame = await selectOffice();
    frame.ensureResources.mockResolvedValue(false);
    frame.ui.hasConversionAccess.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    frame.ui.convertFile.mockResolvedValue({
      type: "converted", fileId: "copy-1", title: "Report", location: "myDrive", reused: false,
    });

    frame.button("Convert")!.onClick();
    await settle();
    expect(frame.notices().map(notice => notice.text)).toContain("Waiting for access in the pop-up…");
    expect(frame.ui.convertFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.ui.hasConversionAccess).toHaveBeenCalledTimes(1);
    expect(frame.ui.convertFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(frame.ui.hasConversionAccess).toHaveBeenCalledTimes(2);
    expect(frame.ui.convertFile).toHaveBeenCalledTimes(1);
    expect(frame.values()[idField]).toBe("copy-1");
    expect(frame.notices()[0].text).toContain(
      "in My Drive, because the original's folder could not take it");
  });

  it("goes back to waiting when the gatekeeper says the pop-up's grant is not there yet", async () => {
    const frame = await selectOffice();
    frame.ensureResources.mockResolvedValue(false);
    frame.ui.convertFile
      .mockResolvedValueOnce({ type: "needsAccess" })
      .mockResolvedValueOnce({
        type: "converted", fileId: "copy-1", title: "Report", location: "besideOriginal",
        reused: false,
      });
    frame.ui.hasConversionAccess.mockResolvedValue(true);

    frame.button("Convert")!.onClick();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.ui.convertFile).toHaveBeenCalledTimes(1);
    expect(frame.notices().map(notice => notice.text)).toContain("Waiting for access in the pop-up…");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.ui.convertFile).toHaveBeenCalledTimes(2);
    expect(frame.values()[idField]).toBe("copy-1");
  });

  it("does not wait for a pop-up that was never opened when the grant is reported held", async () => {
    const frame = await selectOffice();
    frame.ensureResources.mockResolvedValue(true);
    frame.ui.convertFile.mockResolvedValue({ type: "needsAccess" });

    frame.button("Convert")!.onClick();
    await settle();

    expect(frame.ui.convertFile).toHaveBeenCalledTimes(1);
    expect(frame.notices()).toContainEqual({
      tone: "error",
      text: "Google hasn't granted access to copy the file. Select Convert to try again.",
    });
    expect(frame.notices().map(notice => notice.text))
      .not.toContain("Waiting for access in the pop-up…");
    expect(frame.button("Convert")!.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(frame.ui.hasConversionAccess).not.toHaveBeenCalled();
    expect(frame.ready()).toBe(false);
  });

  it("gives up after three minutes without the grant, and lets Convert be tried again", async () => {
    const frame = await selectOffice();
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
    const frame = await selectOffice();
    frame.ensureResources.mockRejectedValue(new Error("The pop-up was closed."));

    frame.button("Convert")!.onClick();
    await settle();

    expect(frame.notices()).toContainEqual({ tone: "error", text: "The pop-up was closed." });
    expect(frame.button("Convert")!.disabled).toBe(false);
    expect(frame.ui.convertFile).not.toHaveBeenCalled();
    expect(frame.ready()).toBe(false);
  });

  it("shows a failed copy and lets Convert be tried again", async () => {
    const frame = await selectOffice();
    frame.ui.convertFile.mockRejectedValue(new Error("Google Drive could not make the copy [http=500]."));

    frame.button("Convert")!.onClick();
    await settle();

    expect(frame.notices()).toContainEqual({
      tone: "error", text: "Google Drive could not make the copy [http=500].",
    });
    expect(frame.button("Convert")!.disabled).toBe(false);
  });

  it("looks again after a failed copy, and offers a copy Drive made despite the failure", async () => {
    const frame = await selectOffice();
    const convertedAt = new Date(XLSX_COPY);
    frame.ui.convertFile.mockRejectedValue(new Error("Google Drive could not make the copy [http=500]."));
    frame.ui.inspectFile.mockResolvedValue(officeFile(label, {
      existingCopy: { fileId: "copy-lost", title: "Report", convertedAt },
    }));

    frame.button("Convert")!.onClick();
    await settle();

    expect(frame.ui.inspectFile).toHaveBeenCalledTimes(2);
    expect(frame.notices()).toContainEqual({
      tone: "error", text: "Google Drive could not make the copy [http=500].",
    });
    expect(frame.button(`Use the copy made on ${convertedAt.toLocaleDateString()}`)).toBeDefined();
    expect(frame.ready()).toBe(false);
  });

  it("drops a copy that is gone when reusing it fails", async () => {
    const convertedAt = new Date(XLSX_COPY);
    const frame = await selectOffice({
      canCopy: false, existingCopy: { fileId: "copy-a", title: "Report", convertedAt },
    });
    frame.ui.convertFile.mockRejectedValue(new Error("That copy is no longer available."));
    frame.ui.inspectFile.mockResolvedValue(officeFile(label, { canCopy: false }));

    frame.button(`Use the copy made on ${convertedAt.toLocaleDateString()}`)!.onClick();
    await settle();

    expect(frame.find("Button")).toEqual([]);
    expect(frame.notices()).toEqual([{
      tone: "error",
      text: "The owner of this file has turned off copying, so it can't be converted into a " +
        `Google ${title} file.`,
    }]);
    expect(frame.ready()).toBe(false);
  });

  it("shows a failed copy at once, before looking at the file again", async () => {
    const frame = await selectOffice();
    frame.ui.convertFile.mockRejectedValue(new Error("Google Drive could not make the copy [http=500]."));
    frame.ui.inspectFile.mockReturnValue(new Promise(() => {}));

    frame.button("Convert")!.onClick();
    await settle();

    expect(frame.notices()).toContainEqual({
      tone: "error", text: "Google Drive could not make the copy [http=500].",
    });
    expect(frame.notices().map(notice => notice.text)).not.toContain("Making the copy…");
    expect(frame.button("Convert")!.disabled).toBe(false);
  });

  it("offers the copy made before, dated, and reuses it", async () => {
    const convertedAt = new Date(XLSX_COPY);
    const frame = await selectOffice({
      existingCopy: { fileId: "copy-a", title: "Report", convertedAt },
    });
    frame.ui.convertFile.mockResolvedValue({
      type: "converted", fileId: "copy-a", title: "Report", location: "besideOriginal", reused: true,
    });

    const reuse = frame.button(`Use the copy made on ${convertedAt.toLocaleDateString()}`);
    expect(reuse).toEqual(expect.objectContaining({ variant: "secondary" }));
    reuse!.onClick();
    await settle();

    // Reusing reads metadata the connection already sees, so no access is asked for.
    expect(frame.ensureResources).not.toHaveBeenCalled();
    expect(frame.ui.hasConversionAccess).not.toHaveBeenCalled();
    expect(frame.ui.convertFile).toHaveBeenCalledWith("source-1", { reuse: "copy-a" });
    expect(frame.values()[idField]).toBe("copy-a");
    expect(frame.notices()[0].text).toBe(
      `Using the Google ${title} copy "Report" made earlier, next to the original. Later edits to ` +
      "the original won't sync.");
  });

  it("drops a conversion whose file was changed while it waited for access", async () => {
    const frame = await selectOffice();
    let grant!: (held: boolean) => void;
    frame.ensureResources.mockReturnValue(new Promise(resolve => { grant = resolve; }));

    frame.button("Convert")!.onClick();
    frame.ui.inspectFile.mockResolvedValue({ type: "native" });
    frame.autocomplete().onChange("native-1");
    await settle();
    grant(true);
    await settle();

    expect(frame.ui.convertFile).not.toHaveBeenCalled();
    expect(frame.values()[idField]).toBe("native-1");
    expect(frame.notices()).toEqual([]);
  });

  it("stops polling once the selection is cleared", async () => {
    const frame = await selectOffice();
    frame.ensureResources.mockResolvedValue(false);

    frame.button("Convert")!.onClick();
    await settle();
    frame.autocomplete().onChange(null);
    frame.ui.hasConversionAccess.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(frame.ui.convertFile).not.toHaveBeenCalled();
    expect(frame.values()[idField]).toBeNull();
    expect(frame.notices()).toEqual([]);
  });

  it("drops a copy made after the selection was cleared with the field's clear button", async () => {
    const frame = await selectOffice();
    let finish!: (result: unknown) => void;
    frame.ui.convertFile.mockReturnValue(new Promise(resolve => { finish = resolve; }));

    frame.button("Convert")!.onClick();
    await settle();
    frame.autocomplete().onClear();
    finish({
      type: "converted", fileId: "copy-1", title: "Report", location: "besideOriginal", reused: false,
    });
    await settle();

    expect(frame.values()[idField]).toBeNull();
    expect(frame.cleared).toEqual([]);
    expect(frame.notices()).toEqual([]);
    expect(frame.ready()).toBe(false);
  });

  it("drops an inspection whose file was cleared before it answered", async () => {
    const frame = await open(testCase);
    let answer!: (inspection: unknown) => void;
    frame.ui.inspectFile.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));

    frame.autocomplete().onChange("native-1");
    frame.autocomplete().onChange(null);
    answer({ type: "native" });
    await settle();

    expect(frame.values()[idField]).toBeNull();
    expect(frame.ready()).toBe(false);
  });

  it("drops a pasted URL's inspection that a selection overtook", async () => {
    const frame = await open(testCase);
    let answer!: (inspection: unknown) => void;
    frame.ui.inspectFile.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));

    const prefilled = frame.spec.initialValuesFromResourceUrl({
      resourceUrl: `https://docs.google.com/${testCase.urlPath}/d/source-1/edit`,
      resourceUrlPattern: RESOURCE_BY_KIND[kind].urlPattern,
      ui: frame.ui,
    });
    frame.autocomplete().onChange("native-1");
    await settle();
    answer(officeFile(label));

    await expect(prefilled).resolves.toEqual({});
    expect(frame.values()[idField]).toBe("native-1");
    expect(frame.notices()).toEqual([]);
  });

  it("drops a copy made after a newer selection", async () => {
    const frame = await selectOffice();
    let finish!: (result: unknown) => void;
    frame.ui.convertFile.mockReturnValue(new Promise(resolve => { finish = resolve; }));

    frame.button("Convert")!.onClick();
    await settle();
    frame.ui.inspectFile.mockResolvedValue({ type: "native" });
    frame.autocomplete().onChange("native-1");
    await settle();
    finish({
      type: "converted", fileId: "copy-1", title: "Report", location: "besideOriginal", reused: false,
    });
    await settle();

    expect(frame.values()[idField]).toBe("native-1");
    expect(frame.cleared).toEqual([]);
  });

  it("withdraws a connectable file at once when another is picked", async () => {
    const frame = await open(testCase);
    frame.autocomplete().onChange("native-1");
    await settle();
    expect(frame.ready()).toBe(true);
    frame.ui.inspectFile.mockReturnValueOnce(new Promise(() => {}));

    frame.autocomplete().onChange("source-1");

    expect(frame.ready()).toBe(false);
    expect(frame.notices()).toEqual([{ tone: undefined, text: "Checking the file…" }]);
  });

  it("drops an inspection that a newer selection overtook", async () => {
    const frame = await open(testCase);
    let answer!: (inspection: unknown) => void;
    frame.ui.inspectFile.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));

    frame.autocomplete().onChange("source-1");
    frame.autocomplete().onChange("native-1");
    await settle();
    answer(officeFile(label));
    await settle();

    expect(frame.values()[idField]).toBe("native-1");
    expect(frame.notices()).toEqual([]);
  });

  it("opens a pasted Office file's URL on its conversion, named in the field", async () => {
    const frame = await open(testCase);
    frame.ui.inspectFile.mockResolvedValue(officeFile(label));

    const values = await frame.spec.initialValuesFromResourceUrl({
      resourceUrl: `https://docs.google.com/${testCase.urlPath}/d/source-1/edit?rtpof=true`,
      resourceUrlPattern: RESOURCE_BY_KIND[kind].urlPattern,
      ui: frame.ui,
    });

    expect(values).toEqual({});
    expect(frame.ui.inspectFile).toHaveBeenCalledWith("source-1");
    expect(frame.autocomplete()).toEqual(expect.objectContaining({
      value: "source-1", placeholder: `Report.${label}`,
    }));
    expect(frame.button("Convert")).toBeDefined();
  });

  it("names an Office file by its extension when its name lacks one", async () => {
    const frame = await open(testCase);
    frame.ui.inspectFile.mockResolvedValue(officeFile(label, { title: "Report" }));

    await frame.spec.initialValuesFromResourceUrl({
      resourceUrl: `https://docs.google.com/${testCase.urlPath}/d/source-1/edit`,
      resourceUrlPattern: RESOURCE_BY_KIND[kind].urlPattern,
      ui: frame.ui,
    });

    expect(frame.autocomplete().placeholder).toBe(`Report (${label})`);
  });
});
