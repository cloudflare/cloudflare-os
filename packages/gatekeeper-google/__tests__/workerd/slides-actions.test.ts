import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActionDescription, ActionField, ActionKind,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  RestPageBackgroundFill, RestPresentation, RestThemeColorPair,
} from "../../src/slides-api";
import type { Slide, PresentationInfo, ShapeElement, TableElement } from "../../src/slides-read-types";
import type { SlideTextEdit } from "../../src/slides-types";
import { TEXT_STYLE_FIELDS } from "../../src/slides-text";
import { colorScheme, presentation, shape, SIMPLE_LIGHT, slide, text } from "../slides-fixture";
import { PICTURE_COPY, SlidesProvider, table } from "../slides-provider";
import { DRIVE_WRITES_GRANT, GOOGLE_DRIVE_RESOURCE } from "../../src/resources";
import { DriveFiles, SLIDES_MIME } from "../drive-files";

function hooks() {
  return env.TEST_HOOKS.getByName("hooks");
}

let facetCount = 0;

function textEdits(edits: SlideTextEdit[]) {
  return edits.map(edit => ({ op: "editText", ...edit }));
}

/** How a run reaches the presentation, and what it changes in what the suite asserts. */
type Run = {
  name: string;
  /** Calls through a fresh session each time, over a gatekeeper's own storage. */
  gatekeeper(): Slides;
  /** The fields a card shows before the editor's own. */
  file: ActionField[];
  /** A kind as the run's binding labels it. */
  kind(kind: ActionKind): ActionKind;
  /** What a fresh session observes before its call's own reads. */
  opened: string[];
  /** The catalog of a binding to the presentation whose Slides kinds are `kinds`. */
  catalog(kinds: ActionKind[]): ActionKind[];
  /** The refusal of a change the account cannot make. */
  cannotEdit: string;
  /** Prepares each test: the Drive run serves Drive beside Slides, and grants the account it. */
  setUp?(): Promise<void>;
};

type Slides = ReturnType<typeof bound>;

/** The calls a test makes, through `call`, `apply`, `reject` and the rest of what a run supplies. */
function bound(facet: string, through: {
  call(method: string, args: unknown[], entered?: () => void): Promise<{
    value?: unknown; error?: string; actionId?: number; action?: ActionDescription;
    observations: string[];
  }>;
  apply(actionId: number, entered?: () => void): Promise<string | null>;
  reject(actionId: number): Promise<{ restart?: boolean } | null>;
  autoApprovable(): Promise<ActionKind[]>;
  orphan(actionId: number): Promise<void>;
}) {
  let call = async (method: string, ...args: unknown[]) => through.call(method, args);
  let queued = async (method: string, ...args: unknown[]) => {
    let outcome = await call(method, ...args);
    if (outcome.error !== undefined) throw new Error(outcome.error);
    if (outcome.actionId === undefined) throw new Error(`${method} queued nothing`);
    return outcome;
  };
  return {
    facet,
    call,
    queued,
    /** `updateSlides` with text edits alone. */
    edit: (edits: SlideTextEdit[]) => queued("updateSlides", textEdits(edits)),
    callEdit: (edits: SlideTextEdit[]) => call("updateSlides", textEdits(edits)),
    slides: async (...ids: string[]) => (await call("getSlides", ids)).value as Slide[],
    /** `getSlides`, calling `entered` once the gatekeeper has started it. */
    slidesEntered: async (entered: () => void, ...ids: string[]) =>
      (await through.call("getSlides", [ids], entered)).value as Slide[],
    outline: async () => (await call("getPresentation")).value as PresentationInfo,
    apply: through.apply,
    reject: through.reject,
    autoApprovable: through.autoApprovable,
    orphan: through.orphan,
  };
}

/** The presentation bound directly. */
const STANDALONE: Run = {
  name: "bound directly",
  gatekeeper() {
    let facet = `slides-${++facetCount}`;
    return bound(facet, {
      call: (method, args, entered) => hooks().callSlides(facet, method as never, args, entered),
      apply: (actionId, entered) => hooks().applySlides(facet, actionId, entered),
      reject: actionId => hooks().rejectSlides(facet, actionId),
      autoApprovable: () => hooks().slidesAutoApprovable(facet),
      orphan: actionId => hooks().orphanSlidesClaim(facet, actionId),
    });
  },
  file: [],
  kind: kind => kind,
  opened: [],
  catalog: kinds => kinds,
  cannotEdit: "can view \"Quarterly review\" but not edit it",
};

/** A read and write Drive binding to the presentation alone. */
const DRIVE_FILE = { scope: { kind: "file", fileId: "deck-1" }, access: "write" } as const;
/** The name Drive gives the presentation's file. */
const FILE_NAME = "Quarterly review.pptx copy";

/** The presentation opened from a read and write Drive binding to its file. */
const THROUGH_DRIVE: Run = {
  name: "opened from a read and write Drive binding",
  gatekeeper() {
    let facet = `drive-slides-${++facetCount}`;
    return bound(facet, {
      call: (method, args, entered) => hooks().callDriveNative(
        facet, DRIVE_FILE, "openGoogleSlides", "deck-1", method, args, [], entered,
        ["getSlides", []]),
      apply: (actionId, entered) => hooks().applyDrive(facet, DRIVE_FILE, actionId, entered),
      reject: actionId => hooks().rejectDriveEdit(facet, DRIVE_FILE, actionId),
      // An exact-file binding learns which editor its file has when it describes it.
      autoApprovable: async () => {
        await hooks().describeDrive(facet, DRIVE_FILE);
        return hooks().driveAutoApprovable(facet, DRIVE_FILE);
      },
      orphan: actionId => hooks().orphanDriveClaim(facet, DRIVE_FILE, actionId),
    });
  },
  file: [
    { label: "File", kind: "inline", value: "deck-1" },
    { label: "File name", kind: "inline", value: FILE_NAME },
  ],
  kind: ({ tag, label }) => ({ tag, label: `${label}, in any presentation this connection reaches` }),
  opened: [
    "Check current metadata for Drive file deck-1 and open it as a Google Slides presentation.",
  ],
  catalog: kinds => [
    { tag: "driveComments", label: "Drive comments" },
    ...kinds.map(kind => THROUGH_DRIVE.kind(kind)),
  ],
  cannotEdit: "The connected Google account cannot edit that file.",
  async setUp() {
    SlidesProvider.companions = [new DriveFiles({
      "deck-1": {
        name: FILE_NAME, mimeType: SLIDES_MIME, parents: ["my-root"],
        // Google lets an account edit what it reports the revision of.
        canEdit: () => SlidesProvider.installed?.editable ?? true,
      },
    })];
    await hooks().setDriveGrants([GOOGLE_DRIVE_RESOURCE.urlPattern, DRIVE_WRITES_GRANT]);
  },
};

/**
 * Engine behaviour is the same whichever way the presentation is reached, so these suites run on
 * both. The stored-layout cases below read and seed the bound presentation's own storage, and run
 * on it alone.
 */
const RUNS = [STANDALONE, THROUGH_DRIVE];

/** A Slides gatekeeper over its own storage, reached as `run` reaches it. */
function gatekeeper(run: Run = STANDALONE): Slides {
  return run.gatekeeper();
}

/** Sets `run` up for each test of the suite that calls this. */
function useRun(run: Run): void {
  if (!run.setUp) return;
  beforeEach(() => run.setUp!());
  afterEach(() => { SlidesProvider.companions = []; });
}

function shapeText(slide: Slide, id: string): string {
  return (slide.elements.find(e => e.id === id) as ShapeElement).text;
}

function deck() {
  return presentation([
    slide("s1", [shape("t1", text(["Q3 review"]), { placeholder: "TITLE" })]),
    slide("s2", [
      shape("t2", text(["Revenue"]), { placeholder: "TITLE" }),
      shape("b2", text(["Revenue: $10M"], ["Margin: 20%"])),
      table("tb2", [["Region", "Sales"], ["EMEA", "4"]]),
    ], { notes: text(["Mention the outlook"]) }),
    slide("s3", [shape("t3", text(["Thanks"]), { placeholder: "TITLE" })], { notes: null }),
  ]);
}

// 30 pt by 20 pt from the corner, 500 pt by 50 pt.
const BOX = {
  size: { width: { magnitude: 6_350_000, unit: "EMU" }, height: { magnitude: 635_000, unit: "EMU" } },
  transform: { scaleX: 1, scaleY: 1, translateX: 381_000, translateY: 254_000, unit: "EMU" },
} as const;

/** `deck()` with its layouts as a layout page reads: each element with its ID, shape and geometry. */
function layoutDeck() {
  return {
    ...deck(),
    layouts: [
      { objectId: "layout-title", layoutProperties: { displayName: "Title slide", masterObjectId: "master-1" }, pageElements: [
        { objectId: "lt-title", ...BOX, shape: { shapeType: "TEXT_BOX", placeholder: { type: "CENTERED_TITLE" } } },
      ] },
      { objectId: "layout-title-body", layoutProperties: { displayName: "Title and body", masterObjectId: "master-1" }, pageElements: [
        { objectId: "ltb-rule", ...BOX, shape: { shapeType: "RECTANGLE" } },
        { objectId: "ltb-title", ...BOX, shape: { shapeType: "TEXT_BOX", placeholder: { type: "TITLE" } } },
        { objectId: "ltb-body", ...BOX, shape: { shapeType: "TEXT_BOX", placeholder: { type: "BODY" } } },
        { objectId: "ltb-body2", shape: { shapeType: "TEXT_BOX", placeholder: { type: "BODY", index: 1 } } },
      ] },
    ],
  };
}

/**
 * Runs `during` once the first write has committed but before Google answers it, and holds the
 * answer until the gatekeeper has started what `during` calls, which then either takes the write
 * into account or does not.
 */
function duringFirstWrite<T>(during: (entered: () => void) => Promise<T>): () => Promise<T> {
  let fetch = globalThis.fetch;
  let started: Promise<T> | undefined;
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    let response = await fetch(input, init);
    if (String(input).endsWith(":batchUpdate") && !started) {
      let entered = Promise.withResolvers<void>();
      started = during(entered.resolve);
      started.catch(() => {});
      await entered.promise;
    }
    return response;
  });
  return () => started!;
}

/** Drops the next write, then edits as a collaborator would, so its resend is refused as stale. */
function dropNextWrite(provider: SlidesProvider, collaborate = (d: RestPresentation) => {
  d.slides![1].pageElements![1].shape!.text = text(["Revenue: $10M"], ["Margin: 21%"]);
}): void {
  provider.nextFailure = "dropped";
  let fetch = globalThis.fetch;
  let sent = false;
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    let response = await fetch(input, init);
    if (String(input).endsWith(":batchUpdate") && !sent) {
      sent = true;
      provider.edit(collaborate);
    }
    return response;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(RUNS)("Google Slides changes ($name)", run => {
  useRun(run);

  it("shows a queued edit in reads, then writes only the changed text at the read's revision", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);

    let { actionId, action, observations } = await slides.edit([
      { slideId: "s2", elementId: "b2", find: "Revenue: $10M", replace: "Revenue: $12M" },
    ]);

    expect(observations).toHaveLength(run.opened.length + 1);
    expect(action).toMatchObject({
      title: "Change slide 2 (\"Revenue\")",
      autoApprovable: true,
      actionKind: { tag: "editSlidesText" },
      descriptionIsComplete: true,
      fields: [
        ...run.file,
        { label: "Find", kind: "text", value: "Revenue: $10M" },
        { label: "Replace with", kind: "text", value: "Revenue: $12M" },
      ],
    });
    expect(shapeText((await slides.slides("s2"))[0], "b2")).toBe("Revenue: $12M\nMargin: 20%");
    expect(provider.text("s2", "b2")).toBe("Revenue: $10M\nMargin: 20%\n");

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.text("s2", "b2")).toBe("Revenue: $12M\nMargin: 20%\n");
    // Only "0" became "2": the label and unit are not rewritten, so they keep their own style, and
    // the "2" is given the style of the "0" it replaces, here none.
    expect(provider.batches).toEqual([{
      requiredRevisionId: "r1",
      requests: [
        { insertText: { objectId: "b2", text: "2", insertionIndex: 11 } },
        { updateTextStyle: {
          objectId: "b2", style: {}, fields: TEXT_STYLE_FIELDS,
          textRange: { type: "FIXED_RANGE", startIndex: 11, endIndex: 12 },
        } },
        { deleteText: { objectId: "b2", textRange: { type: "FIXED_RANGE", startIndex: 12, endIndex: 13 } } },
      ],
    }]);
    expect(shapeText((await slides.slides("s2"))[0], "b2")).toBe("Revenue: $12M\nMargin: 20%");
  });

  it("edits table cells and creates absent speaker notes, all in one approval", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);

    let { actionId } = await slides.edit([
      { slideId: "s2", elementId: "tb2", cell: { row: 1, column: 1 }, replace: "5" },
      { slideId: "s3", replace: "Close with questions" },
    ]);
    let [s2, s3] = await slides.slides("s2", "s3");
    expect((s2.elements.find(e => e.id === "tb2") as TableElement).cells[1][1]).toEqual({ text: "5" });
    expect(s3.speakerNotes).toBe("Close with questions");

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.batches).toHaveLength(1);
    let [after2, after3] = await slides.slides("s2", "s3");
    expect((after2.elements.find(e => e.id === "tb2") as TableElement).cells[1][1]).toEqual({ text: "5" });
    expect(after3.speakerNotes).toBe("Close with questions");
  });

  it("refuses an edit whose text is not there, or is there twice, without queuing it", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let refusal = async (find: string) => {
      let outcome = await slides.callEdit([{ slideId: "s2", elementId: "b2", find, replace: "x" }]);
      expect(outcome.actionId).toBeUndefined();
      return outcome.error;
    };

    expect(await refusal("Profit")).toContain("does not contain the text to find");
    // "0" is in both "$10M" and "20%".
    expect(await refusal("0")).toContain("more than once");
    expect((await slides.callEdit([
      { slideId: "s2", elementId: "b2", find: "$10M", replace: "x" },
    ])).actionId).toEqual(expect.any(Number));
  });

  it("lets later changes build on a queued copy, and applies them in order", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);

    let copy = await slides.queued("duplicateSlide", "s2");
    expect(copy.action).toMatchObject({ autoApprovable: true, actionKind: { tag: "arrange-slides" } });
    let copyId = copy.value as string;
    let [copied] = await slides.slides(copyId);
    let body = copied.elements.find(e => (e as ShapeElement).text?.startsWith("Revenue:"))!;
    expect(body.id).not.toBe("b2");
    let edit = await slides.edit([{ slideId: copyId, elementId: body.id, find: "$10M", replace: "$9M" }]);

    expect((await slides.outline()).slides.map(s => s.id)).toEqual(["s1", "s2", copyId, "s3"]);
    expect(await slides.apply(edit.actionId!)).toContain("apply in the order they were queued");
    expect(provider.batches).toEqual([]);

    expect(await slides.apply(copy.actionId!)).toBeNull();
    expect(await slides.apply(edit.actionId!)).toBeNull();

    expect(provider.deck.slides!.map(s => s.objectId)).toEqual(["s1", "s2", copyId, "s3"]);
    expect(provider.text(copyId, body.id)).toBe("Revenue: $9M\nMargin: 20%\n");
    expect(provider.text("s2", "b2")).toBe("Revenue: $10M\nMargin: 20%\n");
  });

  it("moves and deletes slides as previewed", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);

    let move = await slides.queued("moveSlides", ["s3", "s1"], "s2");
    expect(move.action).toMatchObject({
      autoApprovable: true,
      actionKind: run.kind({ tag: "arrange-slides", label: "Adding, copying and reordering slides" }),
    });
    expect((await slides.outline()).slides.map(s => s.id)).toEqual(["s2", "s1", "s3"]);
    let remove = await slides.queued("deleteSlide", "s1");
    // Deleting takes the slide's content and notes, so it always waits for approval.
    expect(remove.action).toMatchObject({
      title: "Delete slide 2 (\"Q3 review\")",
      autoApprovable: false,
      actionKind: run.kind({ tag: "delete-slides", label: "Deleting slides" }),
    });
    expect((await slides.outline()).slides.map(s => s.id)).toEqual(["s2", "s3"]);

    expect(await slides.apply(move.actionId!)).toBeNull();
    expect(provider.deck.slides!.map(s => s.objectId)).toEqual(["s2", "s1", "s3"]);
    expect(await slides.apply(remove.actionId!)).toBeNull();
    expect(provider.deck.slides!.map(s => s.objectId)).toEqual(["s2", "s3"]);
  });

  it("reports a queued edit a collaborator's change broke, and fails it without writing", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.edit([
      { slideId: "s2", elementId: "b2", find: "$10M", replace: "$12M" },
    ]);

    provider.edit(d => {
      d.slides![1].pageElements![1].shape!.text = text(["Revenue: $11M"]);
    });

    let [s2] = await slides.slides("s2");
    expect(shapeText(s2, "b2")).toBe("Revenue: $11M");
    expect(s2.queuedChangeConflict).toContain("does not contain the text to find");
    // Further changes to that slide would build on it; changes elsewhere still queue.
    let blocked = await slides.call("duplicateSlide", "s2");
    expect(blocked.error).toContain("until it is rejected");
    expect(blocked.actionId).toBeUndefined();
    expect((await slides.call("deleteSlide", "s3")).actionId).toEqual(expect.any(Number));
    expect(await slides.apply(actionId!)).toContain("This change no longer applies");
    expect(provider.batches).toEqual([]);
  });

  it("guards a whole-text replacement on the text it replaced", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId, action } = await slides.edit([
      { slideId: "s1", elementId: "t1", replace: "Q4 review" },
    ]);
    expect(action?.fields).toEqual([
      ...run.file,
      { label: "Current text", kind: "text", value: "Q3 review" },
      { label: "New text", kind: "text", value: "Q4 review" },
    ]);

    provider.edit(d => {
      d.slides![0].pageElements![0].shape!.text = text(["Q3 review (draft)"]);
    });

    expect(await slides.apply(actionId!)).toContain("the text has changed since this edit was made");
    expect(provider.text("s1", "t1")).toBe("Q3 review (draft)\n");
  });

  it("plans again when the presentation changes between its read and its write", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.edit([
      { slideId: "s2", elementId: "b2", find: "Margin: 20%", replace: "Margin: 25%" },
    ]);
    provider.beforeNextBatch = d => {
      d.slides![1].pageElements![1].shape!.text = text(["Revenue: $10M (est.)"], ["Margin: 20%"]);
    };

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.batches.map(b => b.requiredRevisionId)).toEqual(["r1", "r2"]);
    expect(provider.text("s2", "b2")).toBe("Revenue: $10M (est.)\nMargin: 25%\n");
  });

  it("resends a write whose response was lost only as first sent, and finds it landed", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.edit([
      { slideId: "s2", elementId: "b2", find: "$10M", replace: "$10M ($8M net)" },
    ]);
    provider.nextFailure = "lost";

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.batches).toHaveLength(2);
    expect(provider.batches[1]).toEqual(provider.batches[0]);
    expect(provider.text("s2", "b2")).toBe("Revenue: $10M ($8M net)\nMargin: 20%\n");
    expect(await slides.apply(actionId!)).toBeNull();
    expect(provider.batches).toHaveLength(2);
  });

  it("records an unknown outcome when a lost write cannot be shown to have landed", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.edit([
      { slideId: "s2", elementId: "b2", find: "$10M", replace: "$12M" },
    ]);
    dropNextWrite(provider);

    let error = await slides.apply(actionId!);

    expect(error).toContain("may or may not have taken effect");
    expect(provider.batches).toHaveLength(2);
    expect(await slides.apply(actionId!)).toBe(error);
    expect(provider.batches).toHaveLength(2);
    expect(await slides.reject(actionId!)).toBeNull();
  });

  // Text that ends as it began reads the same whether the batch landed or not.
  it("records an unknown outcome for a dropped batch whose edits undo each other", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.edit([
      { slideId: "s1", elementId: "t1", find: "Q3", replace: "Q4" },
      { slideId: "s1", elementId: "t1", find: "Q4", replace: "Q3" },
    ]);
    dropNextWrite(provider);

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
  });

  it("follows an edited cell through the rows a lost batch then adds and deletes", async () => {
    let outcome = async (...lines: { op: string; at: number }[]) => {
      let provider = new SlidesProvider(deck()).install();
      let slides = gatekeeper(run);
      let { actionId } = await slides.queued("updateSlides", [
        { op: "editText", slideId: "s2", elementId: "tb2", cell: { row: 1, column: 0 }, replace: "APAC" },
        ...lines.map(line => ({ ...line, slideId: "s2", elementId: "tb2" })),
      ]);
      provider.nextFailure = "lost";
      return slides.apply(actionId!);
    };

    expect(await outcome({ op: "insertTableRows", at: 1 }, { op: "insertTableRows", at: 3 })).toBeNull();
    expect(await outcome({ op: "deleteTableRows", at: 0 })).toBeNull();
    // Deleting its row deletes the text's evidence, but not the table's size.
    expect(await outcome({ op: "deleteTableRows", at: 1 })).toBeNull();
  });

  // The edited cell moves down a row, so the text its old place shows proves nothing.
  it("records an unknown outcome for a dropped batch that edits a cell, then adds a row above it", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", [
      { op: "editText", slideId: "s2", elementId: "tb2", cell: { row: 1, column: 0 }, replace: "APAC" },
      { op: "insertTableRows", slideId: "s2", elementId: "tb2", at: 1 },
    ]);
    // The new row would leave "" where "EMEA" was, as the collaborator does.
    dropNextWrite(provider, d => {
      d.slides![1].pageElements![2] = table("tb2", [["Region", "Sales"], ["", "4"]]);
    });

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
  });

  // The cell moves down onto one that already reads as the edit leaves it.
  it("records an unknown outcome for a dropped batch whose moved cell lands on text it matches", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", [
      { op: "editText", slideId: "s2", elementId: "tb2", cell: { row: 0, column: 0 }, replace: "EMEA" },
      { op: "insertTableRows", slideId: "s2", elementId: "tb2", at: 0 },
    ]);
    dropNextWrite(provider);

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
  });

  it("finds a lost batch landed by the cells of a table it only adds rows to", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", [
      { op: "insertTableRows", slideId: "s2", elementId: "tb2", at: 2 },
    ]);
    provider.nextFailure = "lost";

    expect(await slides.apply(actionId!)).toBeNull();
  });

  // A collaborator's change matches part of the batch, but not the table it would leave.
  it.each([
    {
      name: "types the edit's text where the new row would move it",
      changes: [
        { op: "editText", slideId: "s2", elementId: "tb2", cell: { row: 0, column: 0 }, replace: "Area" },
        { op: "insertTableRows", slideId: "s2", elementId: "tb2", at: 0 },
      ],
      collaborated: [["Region", "Sales"], ["Area", "4"]],
    },
    {
      name: "deletes a different row",
      changes: [{ op: "deleteTableRows", slideId: "s2", elementId: "tb2", at: 0 }],
      collaborated: [["Region", "Sales"]],
    },
  ])("records an unknown outcome for a dropped batch when a collaborator $name", async ({ changes, collaborated }) => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", changes);
    dropNextWrite(provider, d => {
      d.slides![1].pageElements![2] = table("tb2", collaborated);
    });

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
  });

  // The collaborator's 3 × 3 table, each row's first cell spanning two columns, holds the same
  // text row by row as the 3 × 2 table the batch plans; only their sizes and spans tell them apart.
  it("records an unknown outcome for a dropped row insertion when a collaborator merges cells instead", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", [
      { op: "insertTableRows", slideId: "s2", elementId: "tb2", at: 2 },
    ]);
    dropNextWrite(provider, d => {
      let merged = table("tb2", [["Region", "Sales"], ["EMEA", "4"], ["", ""]]);
      merged.table!.columns = 3;
      for (let row of merged.table!.tableRows!) {
        row.tableCells![0].columnSpan = 2;
        row.tableCells![1].location!.columnIndex = 2;
      }
      d.slides![1].pageElements![2] = merged;
    });

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
  });

  it("asks for a restart only when rejecting a change that later ones were built on", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let first = await slides.edit([{ slideId: "s1", elementId: "t1", find: "Q3", replace: "Q4" }]);
    let second = await slides.queued("deleteSlide", "s3");

    expect(await slides.reject(first.actionId!)).toEqual({ restart: true });
    expect(await slides.reject(second.actionId!)).toBeNull();
    expect(await slides.autoApprovable()).toEqual(run.catalog([
      { tag: "editSlidesText", label: "Slide text edits" },
      { tag: "formatSlides", label: "Slide formatting and arrangement" },
      { tag: "edit-slides", label: "Slide edits that keep every element, table row and column and download no images" },
      { tag: "arrange-slides", label: "Adding, copying and reordering slides" },
      { tag: "skipSlides", label: "Skipping slides" },
    ]));
  });

  it("does not show a change twice to a read made while it is being written", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.edit([
      { slideId: "s2", elementId: "b2", find: "Revenue", replace: "Revenue (USD)" },
    ]);
    let read = duringFirstWrite(entered => slides.slidesEntered(entered, "s2"));

    expect(await slides.apply(actionId!)).toBeNull();

    expect(shapeText((await read())[0], "b2")).toBe("Revenue (USD): $10M\nMargin: 20%");
  });

  it("lets reads overlap one another", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let fetch = globalThis.fetch;
    let outlines = 0;
    let both = Promise.withResolvers<void>();
    vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
      // Each read's outline is answered only once both reads have asked for theirs.
      if (new URL(String(input)).pathname === "/v1/presentations/deck-1" && ++outlines <= 2) {
        if (outlines === 2) both.resolve();
        await both.promise;
      }
      return fetch(input, init);
    });

    let read = await Promise.all([slides.slides("s1"), slides.slides("s3")]);

    expect(read.map(([slide]) => slide.id)).toEqual(["s1", "s3"]);
  });

  it("applies a change approved while the one before it is being written, after it", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let first = await slides.edit([{ slideId: "s1", elementId: "t1", find: "Q3", replace: "Q4" }]);
    let second = await slides.queued("deleteSlide", "s3");
    let applySecond = duringFirstWrite(entered => slides.apply(second.actionId!, entered));

    expect(await slides.apply(first.actionId!)).toBeNull();
    expect(await applySecond()).toBeNull();

    expect(provider.text("s1", "t1")).toBe("Q4 review\n");
    expect(provider.deck.slides!.map(s => s.objectId)).toEqual(["s1", "s2"]);
  });

  it("shows a batch in the outline only if all of it applies, tables included", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    await slides.edit([
      { slideId: "s2", elementId: "t2", find: "Revenue", replace: "Sales" },
      { slideId: "s2", elementId: "tb2", cell: { row: 1, column: 0 }, find: "EMEA", replace: "APAC" },
    ]);
    expect((await slides.outline()).slides[1].title).toBe("Sales");

    provider.edit(d => {
      d.slides![1].pageElements![2] = table("tb2", [["Region", "Sales"], ["LATAM", "4"]]);
    });

    let outline = await slides.outline();
    expect(outline.slides[1].title).toBe("Revenue");
    expect(outline.queuedChangeConflict).toContain("does not contain the text to find");
  });

  it("does not replay a change whose activation died applying it", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.edit([
      { slideId: "s2", elementId: "b2", find: "Revenue", replace: "Revenue (USD)" },
    ]);
    // Google committed it, but the activation died before the journal heard back.
    provider.edit(d => {
      d.slides![1].pageElements![1].shape!.text = text(["Revenue (USD): $10M"], ["Margin: 20%"]);
    });
    await slides.orphan(actionId!);

    expect(shapeText((await slides.slides("s2"))[0], "b2")).toBe("Revenue (USD): $10M\nMargin: 20%");
  });

  it("refuses to queue a change the account cannot make, but still reads", async () => {
    let provider = new SlidesProvider(deck()).install();
    provider.editable = false;
    let slides = gatekeeper(run);

    let refused = await slides.call("deleteSlide", "s3");

    expect(refused.error).toContain(run.cannotEdit);
    expect(refused.actionId).toBeUndefined();
    expect((await slides.outline()).slides.map(s => s.id)).toEqual(["s1", "s2", "s3"]);
  });
});

describe.each(RUNS)("Google Slides design changes ($name)", run => {
  useRun(run);

  const BADGE = {
    op: "createShape", slideId: "s2", ref: "badge", shapeType: "ROUND_RECTANGLE",
    bounds: { x: 10, y: 20, width: 100, height: 40 }, text: "New", fill: "ACCENT1",
  };

  it("queues a batch as one approval, shows it in reads, and writes it as one revision-pinned batch", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);

    let { actionId, action, value } = await slides.queued("updateSlides", [
      BADGE,
      { op: "formatText", slideId: "s2", elementId: "badge", format: { bold: true } },
      { op: "deleteElement", slideId: "s2", elementId: "b2" },
    ]);
    let { badge } = value as Record<string, string>;

    expect(action).toMatchObject({
      title: "Change slide 2 (\"Revenue\")",
      autoApprovable: false,
      actionKind: run.kind({
        tag: "update-slides",
        label: "Slide changes that delete elements, table rows or columns, or download images",
      }),
      descriptionIsComplete: true,
      fields: [...run.file, { label: "Change 1: Text", kind: "text", value: "New" }],
    });
    expect(action!.description).toContain(
      "2. On slide 2 (\"Revenue\"), format all of the text of the shape change 1 adds: bold");
    let [s2] = await slides.slides("s2");
    expect(s2.elements.map(e => e.id)).toEqual(["t2", "tb2", badge]);
    expect(s2.elements[2]).toMatchObject({ text: "New", formats: [{ start: 0, end: 3, bold: true }], fill: "ACCENT1" });
    expect(provider.batches).toEqual([]);

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.batches).toHaveLength(1);
    expect(provider.batches[0].requiredRevisionId).toBe("r1");
    expect(provider.slide("s2").pageElements!.map(e => e.objectId)).toEqual(["t2", "tb2", badge]);
    expect(provider.text("s2", badge)).toBe("New\n");
  });

  it("shows a font name in full, since any string is sent and kept", async () => {
    new SlidesProvider(deck()).install();
    let font = `${"Workspace data ".repeat(5)}*not* [shown] in prose`;
    let { action } = await gatekeeper(run).queued("updateSlides", [
      { op: "formatText", slideId: "s2", elementId: "t2", format: { fontFamily: font } },
    ]);

    expect(action).toMatchObject({
      descriptionIsComplete: true, fields: [...run.file, { label: "Font", value: font }],
    });
    expect(action!.description).toContain("the font below");
  });

  it("finds a batch whose response was lost landed by the element it created", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId, value } = await slides.queued("updateSlides", [BADGE]);
    provider.nextFailure = "lost";

    expect(await slides.apply(actionId!)).toBeNull();

    // The resend at the first revision was refused, and a read found the shape.
    expect(provider.batches).toHaveLength(2);
    expect(provider.text("s2", (value as Record<string, string>).badge)).toBe("New\n");
  });

  it("finds a lost batch landed when it deleted an element it created, and its edits", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", [
      BADGE,
      { op: "editText", slideId: "s2", elementId: "badge", replace: "Old" },
      { op: "deleteElement", slideId: "s2", elementId: "badge" },
      { op: "editText", slideId: "s2", elementId: "t2", replace: "Sales" },
    ]);
    provider.nextFailure = "lost";

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.batches).toHaveLength(2);
    expect(provider.text("s2", "t2")).toBe("Sales\n");
  });

  it("lets a batch apply without asking unless it deletes elements, table lines, or downloads an image", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let kindOf = async (...changes: object[]) => {
      let { action } = await slides.queued("updateSlides", changes);
      return action!.autoApprovable ? action!.actionKind!.tag : `manual ${action!.actionKind!.tag}`;
    };
    let format = (fields: object) => ({ op: "formatText", slideId: "s1", elementId: "t1", format: fields });

    expect(await kindOf(format({ bold: true }), { op: "arrange", slideId: "s1", elementId: "t1", to: "front" }))
      .toBe("formatSlides");
    // A font or link is not formatting alone, as Google keeps its whole string, but deletes nothing.
    expect(await kindOf(format({ fontFamily: "Georgia" }))).toBe("edit-slides");
    expect(await kindOf(format({ link: "https://example.com/" }))).toBe("edit-slides");
    expect(await kindOf(format({ italic: true }), { op: "editText", slideId: "s1", elementId: "t1", find: "Q3", replace: "Q4" }))
      .toBe("edit-slides");
    expect(await kindOf({ op: "setAltText", slideId: "s1", elementId: "t1", title: "Title" })).toBe("edit-slides");
    expect(await kindOf(BADGE)).toBe("edit-slides");
    expect(await kindOf({ op: "createTable", slideId: "s1", rows: 2, columns: 2 })).toBe("edit-slides");
    expect(await kindOf({ op: "insertTableRows", slideId: "s2", elementId: "tb2", at: 1 })).toBe("edit-slides");
    expect(await kindOf({ op: "formatTableCells", slideId: "s2", elementId: "tb2", fill: "ACCENT1" }))
      .toBe("edit-slides");

    expect(await kindOf({ op: "deleteElement", slideId: "s2", elementId: "b2" })).toBe("manual update-slides");
    expect(await kindOf({ op: "deleteTableRows", slideId: "s2", elementId: "tb2", at: 1 })).toBe("manual update-slides");
    expect(await kindOf({ op: "deleteTableColumns", slideId: "s2", elementId: "tb2", at: 1 }))
      .toBe("manual update-slides");
    // Google downloads the image from a URL the agent chose, which can carry what it encodes there.
    expect(await kindOf({ op: "insertImage", slideId: "s1", url: "https://example.com/chart.png" }))
      .toBe("manual update-slides");
    // One deletion or download holds back a batch that would otherwise be an edit.
    expect(await kindOf(BADGE, { op: "deleteElement", slideId: "s1", elementId: "t1" })).toBe("manual update-slides");
  });

  // Neither the created-then-deleted element nor the formatting differs between a batch that
  // landed and one that did not, so neither may count as having landed.
  it("records an unknown outcome for a dropped batch that leaves no trace", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", [
      BADGE,
      { op: "deleteElement", slideId: "s2", elementId: "badge" },
      { op: "formatText", slideId: "s2", elementId: "t2", format: { bold: true } },
    ]);
    dropNextWrite(provider);

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
    expect(provider.batches).toHaveLength(2);
  });

  it("refuses a ref that is also an element's ID, queuing nothing", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let outcome = await slides.call("updateSlides", [{ ...BADGE, ref: "b2" }]);
    expect(outcome.error).toContain('The ref "b2" is also an element\'s ID');
    expect(outcome.actionId).toBeUndefined();
  });
});

describe.each(RUNS)("Google Slides new and skipped slides ($name)", run => {
  useRun(run);

  it("adds a slide from a layout, lets later edits fill its placeholders, and creates it as previewed", async () => {
    let provider = new SlidesProvider(layoutDeck()).install();
    let slides = gatekeeper(run);

    let create = await slides.queued("createSlide", "layout-title-body", "s1");
    let newId = create.value as string;

    expect(create.action).toMatchObject({
      title: "Add a slide",
      autoApprovable: true,
      actionKind: run.kind({ tag: "arrange-slides", label: "Adding, copying and reordering slides" }),
      descriptionIsComplete: true,
      description: 'Adds a slide with the layout "Title and body" after slide 1 ("Q3 review").',
    });
    expect(create.observations).toEqual([
      ...run.opened,
      'Read the slide order of "Quarterly review" and the placeholders of its layout "Title and ' +
        'body" to queue adding a slide.',
    ]);
    let [added] = await slides.slides(newId);
    expect(added).toMatchObject({ index: 1, layout: "Title and body", skipped: false, speakerNotes: "" });
    expect(added.elements.map(e => [(e as ShapeElement).placeholder, (e as ShapeElement).text]))
      .toEqual([["TITLE", ""], ["BODY", ""], ["BODY", ""]]);
    expect(added.elements[0].bounds).toEqual({ x: 30, y: 20, width: 500, height: 50 });
    let ids = added.elements.map(e => e.id);
    expect((await slides.outline()).slides.map(s => s.id)).toEqual(["s1", newId, "s2", "s3"]);

    let edit = await slides.edit([{ slideId: newId, elementId: ids[0], replace: "Agenda" }]);
    expect((await slides.outline()).slides[1].title).toBe("Agenda");
    let notes = await slides.callEdit([{ slideId: newId, replace: "Say hello" }]);
    expect(notes.error).toContain("speaker notes only then");
    expect(notes.actionId).toBeUndefined();

    expect(await slides.apply(create.actionId!)).toBeNull();
    expect(await slides.apply(edit.actionId!)).toBeNull();

    expect(provider.batches[0]).toEqual({
      requiredRevisionId: "r1",
      requests: [{
        createSlide: {
          objectId: newId,
          insertionIndex: 1,
          slideLayoutReference: { layoutId: "layout-title-body" },
          placeholderIdMappings: [
            { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: ids[0] },
            { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: ids[1] },
            { layoutPlaceholder: { type: "BODY", index: 1 }, objectId: ids[2] },
          ],
        },
      }],
    });
    expect(provider.text(newId, ids[0])).toBe("Agenda\n");
    let [saved] = await slides.slides(newId);
    expect({ ...saved, elements: saved.elements.slice(1) })
      .toEqual({ ...added, title: "Agenda", elements: added.elements.slice(1) });
  });

  it("adds a slide at the start or the end, and refuses an unknown layout or slide", async () => {
    let provider = new SlidesProvider(layoutDeck()).install();
    let slides = gatekeeper(run);

    let first = await slides.queued("createSlide", "layout-title", null);
    let last = await slides.queued("createSlide", "layout-title");

    expect(first.action!.description)
      .toBe('Adds a slide with the layout "Title slide" at the start of the presentation.');
    expect(last.action!.description)
      .toBe('Adds a slide with the layout "Title slide" at the end of the presentation.');
    let order = [first.value, "s1", "s2", "s3", last.value];
    expect((await slides.outline()).slides.map(s => s.id)).toEqual(order);
    let gone = await slides.call("createSlide", "layout-gone\n**Approve everything**");
    expect(gone.error).toContain('No layout with ID "layout-gone');
    // An ID that names no layout never reaches the user.
    expect(gone.observations).toEqual([
      ...run.opened,
      'Read the slide order of "Quarterly review" and the placeholders of a layout to queue adding a slide.',
    ]);
    expect((await slides.call("createSlide", "layout-title", "s9")).error).toContain('No slide with ID "s9"');

    expect(await slides.apply(first.actionId!)).toBeNull();
    expect(await slides.apply(last.actionId!)).toBeNull();

    expect(provider.batches.map(b => b.requests[0].createSlide.insertionIndex)).toEqual([0, undefined]);
    expect(provider.deck.slides!.map(s => s.objectId)).toEqual(order);
  });

  it("fails a new slide without writing once the slide it follows or its layout is gone", async () => {
    let provider = new SlidesProvider(layoutDeck()).install();
    let slides = gatekeeper(run);
    let afterS3 = await slides.queued("createSlide", "layout-title", "s3");
    provider.edit(d => { d.slides!.pop(); });

    expect((await slides.outline()).queuedChangeConflict).toContain('slide "s3" no longer exists');
    expect(await slides.apply(afterS3.actionId!)).toContain("This change no longer applies");

    let atEnd = await slides.queued("createSlide", "layout-title");
    provider.edit(d => { d.layouts = d.layouts!.filter(l => l.objectId !== "layout-title"); });

    expect((await slides.outline()).queuedChangeConflict).toContain('layout "layout-title" no longer exists');
    expect(await slides.apply(atEnd.actionId!)).toContain('layout "layout-title" no longer exists');
    expect(provider.batches).toEqual([]);
  });

  it("fails a new slide without writing once its layout loses a placeholder it maps", async () => {
    let provider = new SlidesProvider(layoutDeck()).install();
    let slides = gatekeeper(run);
    let created = await slides.queued("createSlide", "layout-title-body");
    provider.edit(d => {
      let layout = d.layouts!.find(l => l.objectId === "layout-title-body")!;
      layout.pageElements = layout.pageElements!.filter(e => e.objectId !== "ltb-body2");
    });

    expect(await slides.apply(created.actionId!))
      .toContain('layout "layout-title-body" no longer has its BODY placeholder 1');
    expect(provider.batches).toEqual([]);
  });

  it("adds a slide only after one of its layout's master, as Google requires", async () => {
    let themed = layoutDeck();
    themed.slides!.at(-1)!.slideProperties!.masterObjectId = "master-2";
    themed.layouts.push({ objectId: "layout-other", layoutProperties: { displayName: "Other", masterObjectId: "master-2" },
      pageElements: [] });
    let provider = new SlidesProvider(themed).install();
    let slides = gatekeeper(run);

    expect((await slides.outline()).layouts.map(({ id, master }) => [id, master]))
      .toEqual([["layout-title", "master-1"], ["layout-title-body", "master-1"], ["layout-other", "master-2"]]);
    expect((await slides.call("createSlide", "layout-other", "s1")).error)
      .toContain('Layout "layout-other" belongs to a different master than slide "s1"');
    let atEnd = await slides.queued("createSlide", "layout-other");
    expect(await slides.apply(atEnd.actionId!)).toBeNull();

    expect(provider.deck.slides!.at(-1)!.slideProperties!.masterObjectId).toBe("master-2");
  });

  it("drops a theme's layouts with its last slide, so no new slide is queued on one", async () => {
    let themed = layoutDeck();
    themed.masters = [{ objectId: "master-1" }, { objectId: "master-2" }];
    themed.slides!.at(-1)!.slideProperties!.masterObjectId = "master-2";
    themed.layouts.push({ objectId: "layout-other", layoutProperties: { displayName: "Other", masterObjectId: "master-2" },
      pageElements: [] });
    let provider = new SlidesProvider(themed).install();
    let slides = gatekeeper(run);

    let remove = await slides.queued("deleteSlide", "s3");
    expect((await slides.outline()).layouts.map(({ id }) => id)).toEqual(["layout-title", "layout-title-body"]);
    expect((await slides.call("createSlide", "layout-other")).error).toContain('Layout "layout-other" no longer exists');
    expect(await slides.apply(remove.actionId!)).toBeNull();

    expect(provider.deck.layouts!.map(l => l.objectId)).toEqual(["layout-title", "layout-title-body"]);
    expect((await slides.outline()).layouts.map(({ id }) => id)).toEqual(["layout-title", "layout-title-body"]);
  });

  it("skips and unskips slides as previewed, writing only the slides that change", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);

    let skip = await slides.queued("setSlidesSkipped", ["s3", "s1"], true);

    expect(skip.action).toMatchObject({
      title: "Skip 2 slides",
      autoApprovable: true,
      actionKind: run.kind({ tag: "skipSlides", label: "Skipping slides" }),
      description: 'Skips slide 1 ("Q3 review"), slide 3 ("Thanks"), leaving them out when presenting.',
    });
    expect((await slides.outline()).slides.map(s => s.skipped)).toEqual([true, false, true]);
    expect((await slides.slides("s1"))[0].skipped).toBe(true);
    expect((await slides.call("setSlidesSkipped", ["s1", "s3"], true)).error)
      .toBe("Those slides are already skipped.");
    expect((await slides.call("setSlidesSkipped", ["s2"], false)).error).toBe("None of those slides is skipped.");
    expect((await slides.call("setSlidesSkipped", ["s2", "s2"], true)).error).toBe("A slide is listed twice.");
    let unskip = await slides.queued("setSlidesSkipped", ["s1", "s2"], false);
    expect(unskip.action!.title).toBe("Stop skipping 2 slides");
    expect((await slides.outline()).slides.map(s => s.skipped)).toEqual([false, false, true]);

    provider.pageReads = [];
    expect(await slides.apply(skip.actionId!)).toBeNull();
    expect(await slides.apply(unskip.actionId!)).toBeNull();
    // The outline says which slides are skipped, so no slide is read to apply them.
    expect(provider.pageReads).toEqual([]);

    let update = (objectId: string, isSkipped: boolean) =>
      ({ updateSlideProperties: { objectId, slideProperties: { isSkipped }, fields: "isSkipped" } });
    // s2 was never skipped, so unskipping writes only s1.
    expect(provider.batches.map(b => b.requests)).toEqual([
      [update("s3", true), update("s1", true)],
      [update("s1", false)],
    ]);
    expect(provider.deck.slides!.map(s => s.slideProperties!.isSkipped)).toEqual([undefined, undefined, true]);
    expect((await slides.outline()).slides.map(s => s.skipped)).toEqual([false, false, true]);
  });
});

function background(target: object, value: unknown) {
  return { op: "setBackground", ...target, background: value };
}

describe.each(RUNS)("Google Slides backgrounds and theme ($name)", run => {
  useRun(run);

  const PICTURE_URL = "https://example.com/backdrop.png";
  const RED: RestPageBackgroundFill =
    { propertyState: "RENDERED", solidFill: { color: { rgbColor: { red: 1 } }, alpha: 1 } };

  it("formats with a slide's colour, none or inherited background, edits with a theme change, and asks for a picture", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let kindOf = async (...changes: object[]) => {
      let { action } = await slides.queued("updateSlides", changes);
      return action!.autoApprovable ? action!.actionKind!.tag : `manual ${action!.actionKind!.tag}`;
    };

    expect(await kindOf(background({ slideId: "s1" }, "#ff0000"))).toBe("formatSlides");
    expect(await kindOf(background({ slideId: "s1" }, "none"))).toBe("formatSlides");
    expect(await kindOf(
      background({ slideId: "s1" }, null),
      { op: "formatText", slideId: "s1", elementId: "t1", format: { bold: true } },
    )).toBe("formatSlides");
    // Google downloads a picture from the URL, wherever it goes.
    expect(await kindOf(background({ slideId: "s1" }, { imageUrl: PICTURE_URL }))).toBe("manual update-slides");
    expect(await kindOf(background({ layoutId: "layout-title" }, { imageUrl: PICTURE_URL })))
      .toBe("manual update-slides");
    // A layout or master reaches slides the user is not looking at, so it is no slide formatting.
    expect(await kindOf(background({ layoutId: "layout-title" }, "#ff0000"))).toBe("edit-slides");
    expect(await kindOf(background({ masterId: "master-1" }, "ACCENT1"))).toBe("edit-slides");
    expect(await kindOf({ op: "setThemeColors", masterId: "master-1", colors: { ACCENT1: "#ff0000" } }))
      .toBe("edit-slides");
  });

  it("queues slide and theme changes as one approval, shows them in reads, and writes them as one batch", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);

    let { actionId, action } = await slides.queued("updateSlides", [
      { op: "setBackground", slideId: "s2", background: "#ff0000" },
      { op: "setBackground", layoutId: "layout-title-body", background: { imageUrl: PICTURE_URL } },
      { op: "setThemeColors", masterId: "master-1", colors: { ACCENT1: "#123456" } },
    ]);

    expect(action).toMatchObject({
      title: "Change slide 2 (\"Revenue\") and the theme",
      autoApprovable: false,
      actionKind: { tag: "update-slides" },
      descriptionIsComplete: true,
      fields: [...run.file, { label: "Change 2: Background image URL", kind: "text", value: PICTURE_URL }],
    });
    expect(action!.description).toBe(
      "Makes 3 changes, all or none of which are applied:\n\n" +
      "1. On slide 2 (\"Revenue\"), set the background to #ff0000\n" +
      "2. On layout \"Title and body\" of master \"Simple Light\", set the background to a picture " +
      "downloaded from the URL below, stretched to fill it\n" +
      "3. On the master \"Simple Light\", set the theme colours ACCENT1 #123456\n\n" +
      "Each change to a master or layout reaches every slide made from it.");
    let queued = await slides.outline();
    expect(queued.slides.map(s => s.background)).toEqual([undefined, "#ff0000", undefined]);
    expect(queued.layouts.map(({ id, background: set }) => [id, set])).toEqual([
      ["layout-title", undefined], ["layout-title-body", "picture"],
    ]);
    expect(queued.masters).toEqual([{
      id: "master-1", name: "Simple Light", background: "LIGHT1",
      themeColors: { ...SIMPLE_LIGHT, ACCENT1: "#123456" },
    }]);
    expect(provider.batches).toEqual([]);

    expect(await slides.apply(actionId!)).toBeNull();

    let [{ requests, requiredRevisionId }] = provider.batches;
    expect(requiredRevisionId).toBe("r1");
    expect(requests.slice(0, 2)).toEqual([
      { updatePageProperties: { objectId: "s2", pageProperties: { pageBackgroundFill: RED }, fields: "pageBackgroundFill" } },
      { updatePageProperties: {
        objectId: "layout-title-body",
        pageProperties: { pageBackgroundFill: { propertyState: "RENDERED", stretchedPictureFill: { contentUrl: PICTURE_URL } } },
        fields: "pageBackgroundFill",
      } },
    ]);
    let scheme = requests[2].updatePageProperties;
    expect(scheme).toMatchObject({ objectId: "master-1", fields: "colorScheme" });
    expect(scheme.pageProperties.colorScheme.colors.map((pair: RestThemeColorPair) => pair.type))
      .toEqual(Object.keys(SIMPLE_LIGHT));
    expect(await slides.outline()).toEqual(queued);
  });

  it("titles a batch by the pages it changes", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let titleOf = async (...changes: object[]) =>
      (await slides.queued("updateSlides", changes)).action!.title;
    let layoutBackground = { op: "setBackground", layoutId: "layout-title", background: "none" };
    let theme = { op: "setThemeColors", masterId: "master-1", colors: { DARK1: "#111111" } };

    expect(await titleOf(theme)).toBe("Change the master \"Simple Light\"");
    expect(await titleOf(theme, { op: "setBackground", masterId: "master-1", background: "#ffffff" }))
      .toBe("Change the master \"Simple Light\"");
    expect(await titleOf(layoutBackground)).toBe("Change layout \"Title slide\" of master \"Simple Light\"");
    expect(await titleOf(layoutBackground, theme)).toBe("Change the theme");
    expect(await titleOf(
      { op: "setBackground", slideId: "s1", background: "none" },
      { op: "setBackground", slideId: "s3", background: "none" },
      theme,
    )).toBe("Change 2 slides and the theme");
  });

  it("reads only the outline to queue a theme change, and keeps a colour a collaborator changed meanwhile", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId, observations } = await slides.queued("updateSlides", [
      { op: "setThemeColors", masterId: "master-1", colors: { ACCENT1: "#123456" } },
    ]);
    expect(observations).toEqual([
      ...run.opened,
      "Read the masters and layouts of \"Quarterly review\" to queue changes to them.",
    ]);

    provider.edit(d => {
      d.masters![0].pageProperties!.colorScheme = colorScheme({ ...SIMPLE_LIGHT, DARK2: "#abcdef" });
    });

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.batches.map(b => b.requiredRevisionId)).toEqual(["r2"]);
    expect((await slides.outline()).masters[0].themeColors)
      .toEqual({ ...SIMPLE_LIGHT, DARK2: "#abcdef", ACCENT1: "#123456" });
    // Google works out the four that follow the 12 itself.
    let colors = provider.deck.masters![0].pageProperties!.colorScheme!.colors!;
    expect(colors.find(color => color.type === "BACKGROUND2")).toEqual({
      type: "BACKGROUND2", color: { red: 0xab / 255, green: 0xcd / 255, blue: 0xef / 255 },
    });
  });

  it("refuses a change to a layout or master the presentation does not have, queuing nothing", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let refusal = async (change: object) => {
      let outcome = await slides.call("updateSlides", [change]);
      expect(outcome.actionId).toBeUndefined();
      return outcome.error;
    };

    expect(await refusal({ op: "setBackground", layoutId: "layout-gone", background: "none" }))
      .toContain('the presentation has no layout "layout-gone"');
    // A master named as a layout is not one.
    expect(await refusal({ op: "setBackground", layoutId: "master-1", background: "none" }))
      .toContain('the presentation has no layout "master-1"');
    expect(await refusal({ op: "setThemeColors", masterId: "layout-title", colors: { DARK1: "#000001" } }))
      .toContain('the presentation has no master "layout-title"');
  });

  it("reports a queued change to a layout a collaborator deleted, and fails it without writing", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", [
      { op: "setBackground", layoutId: "layout-title", background: "#ff0000" },
    ]);

    provider.edit(d => {
      d.layouts = d.layouts!.filter(l => l.objectId !== "layout-title");
    });

    let outline = await slides.outline();
    expect(outline.layouts.map(l => l.id)).toEqual(["layout-title-body"]);
    expect(outline.queuedChangeConflict).toContain('the presentation has no layout "layout-title"');
    expect(await slides.apply(actionId!)).toContain("This change no longer applies");
    expect(provider.batches).toEqual([]);
  });

  it.each([
    { name: "a slide's colour", changes: [{ op: "setBackground", slideId: "s1", background: "#ff0000" }] },
    { name: "no master background", changes: [{ op: "setBackground", masterId: "master-1", background: "none" }] },
    { name: "theme colours", changes: [{ op: "setThemeColors", masterId: "master-1", colors: { ACCENT6: "#000000" } }] },
  ])("finds a lost batch that only sets $name landed", async ({ changes }) => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", changes);
    provider.nextFailure = "lost";

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.batches).toHaveLength(2);
    expect(provider.batches[1]).toEqual(provider.batches[0]);
  });

  // Every picture reads as "picture", so a collaborator's would read as the batch's own, even
  // where an earlier change in the batch sets the page a colour or its inherited background.
  it.each([
    { name: "alone", first: [] },
    { name: "after a colour", first: [{ op: "setBackground", slideId: "s1", background: "#00ff00" }] },
    { name: "after an inherited one", first: [{ op: "setBackground", slideId: "s1", background: null }] },
  ])("records an unknown outcome for a dropped picture background set $name, whatever picture the page has after", async ({ first }) => {
    let provider = new SlidesProvider(deck()).install();
    provider.slide("s1").pageProperties = { pageBackgroundFill: RED };
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", [
      ...first,
      { op: "setBackground", slideId: "s1", background: { imageUrl: PICTURE_URL } },
    ]);
    dropNextWrite(provider, d => {
      d.slides![0].pageProperties = {
        pageBackgroundFill: { stretchedPictureFill: { contentUrl: "https://example.com/other.png", size: {} } },
      };
    });

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
    expect(provider.batches).toHaveLength(2);
  });

  it("finds a lost reset to the inherited background landed", async () => {
    let provider = new SlidesProvider(deck()).install();
    provider.slide("s2").pageProperties = { pageBackgroundFill: RED };
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", [
      { op: "setBackground", slideId: "s2", background: null },
    ]);
    provider.nextFailure = "lost";

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.slide("s2").pageProperties).toEqual({ pageBackgroundFill: { propertyState: "INHERIT" } });
  });

  // The slide reads the same whether the batch landed or not.
  it("records an unknown outcome for a dropped batch setting a background the slide already has", async () => {
    let provider = new SlidesProvider(deck()).install();
    provider.slide("s1").pageProperties = { pageBackgroundFill: RED };
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", [
      { op: "setBackground", slideId: "s1", background: "#ff0000" },
    ]);
    dropNextWrite(provider);

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
    expect(provider.batches).toHaveLength(2);
  });

  // A read of the background shows the colour alone, so the opacity has to tell the two apart.
  it.each([
    { name: "slide", target: { slideId: "s1" }, page: (d: RestPresentation) => d.slides![0] },
    { name: "layout", target: { layoutId: "layout-title" }, page: (d: RestPresentation) => d.layouts![0] },
    { name: "master", target: { masterId: "master-1" }, page: (d: RestPresentation) => d.masters![0] },
  ])("records an unknown outcome for a dropped $name background when a collaborator sets its colour translucent", async ({ target, page }) => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", [background(target, "#ff0000")]);
    dropNextWrite(provider, d => {
      let translucent = { ...RED, solidFill: { ...RED.solidFill, alpha: 0.5 } };
      page(d).pageProperties = { ...page(d).pageProperties, pageBackgroundFill: translucent };
    });

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
    expect(provider.batches).toHaveLength(2);
  });

  it("records an unknown outcome for a dropped reset on a slide a collaborator then deleted", async () => {
    let provider = new SlidesProvider(deck()).install();
    provider.slide("s2").pageProperties = { pageBackgroundFill: RED };
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", [
      { op: "setBackground", slideId: "s2", background: null },
    ]);
    dropNextWrite(provider, d => {
      d.slides = d.slides!.filter(s => s.objectId !== "s2");
    });

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
  });

  it("checks a queued batch's slides before queuing a theme change to the master it also changes", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    await slides.queued("updateSlides", [
      { op: "editText", slideId: "s2", elementId: "b2", find: "$10M", replace: "$12M" },
      { op: "setThemeColors", masterId: "master-1", colors: { ACCENT1: "#123456" } },
    ]);
    provider.edit(d => {
      d.slides![1].pageElements![1].shape!.text = text(["Revenue: $11M"], ["Margin: 20%"]);
    });

    let outcome = await slides.call("updateSlides", [
      { op: "setThemeColors", masterId: "master-1", colors: { ACCENT2: "#654321" } },
    ]);
    expect(outcome.actionId).toBeUndefined();
    expect(outcome.error).toContain("No more changes can be queued until it is rejected");
  });

  it("never reads back the URL Google serves a picture background from", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper(run);
    let { actionId } = await slides.queued("updateSlides", [
      { op: "setBackground", slideId: "s1", background: { imageUrl: PICTURE_URL } },
      { op: "setBackground", masterId: "master-1", background: { imageUrl: PICTURE_URL } },
    ]);
    expect(await slides.apply(actionId!)).toBeNull();
    expect(JSON.stringify(provider.deck)).toContain(PICTURE_COPY);

    let outline = await slides.outline();
    let [s1] = await slides.slides("s1");

    expect(outline.masters[0].background).toBe("picture");
    expect(outline.slides[0].background).toBe("picture");
    expect(s1.background).toBe("picture");
    expect(JSON.stringify([outline, s1])).not.toContain("googleusercontent");
  });
});

// What a bound presentation stores, by its literal keys, so that moving its code cannot move its
// storage.
describe("Google Slides stored layout", () => {
  /** The value under `key`, as the synchronous KV reads it. */
  async function stored(facet: string, key: string): Promise<unknown> {
    let { kv } = await hooks().storedValue(facet, "slides", key);
    return kv === undefined ? undefined : JSON.parse(kv);
  }

  const EDIT = { slideId: "s2", elementId: "b2", find: "Revenue: $10M", replace: "Revenue: $12M" };

  it("keeps its journal under the keys it has always used, and nothing else", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let first = await slides.edit([EDIT]);
    let second = await slides.edit([{ ...EDIT, find: "Margin: 20%", replace: "Margin: 25%" }]);
    expect(await hooks().storedKeys(slides.facet, "slides"))
      .toEqual(["slides:action:1", "slides:action:2", "slides:nextActionId"]);
    expect(await stored(slides.facet, "slides:action:1")).toEqual({
      v: 2, state: "pending",
      // Stored under its definition's name, which is not its kind's tag.
      action: {
        kind: "editText",
        payload: {
          changes: [{ op: "editText", ...EDIT }], slides: { s2: { number: 2, title: "Revenue" } },
        },
      },
    });

    expect(await slides.apply(first.actionId!)).toBeNull();
    expect(await slides.reject(second.actionId!)).toBeNull();
    let third = await slides.edit([{ ...EDIT, find: "Margin: 20%", replace: "Margin: 30%" }]);

    expect(third.actionId).toBe(3);
    expect(await hooks().storedKeys(slides.facet, "slides"))
      .toEqual(["applied:slides:action:", "slides:action:3", "slides:nextActionId"]);
    expect(await stored(slides.facet, "slides:nextActionId")).toBe(4);
    expect(await stored(slides.facet, "applied:slides:action:")).toEqual([1]);
  });

  it("carries on a counter stored before it first starts", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    await hooks().writeStored(
      slides.facet, "slides", [{ kind: "put", key: "slides:nextActionId", value: 12 }], "kv");
    await hooks().restartFacet(slides.facet);

    expect((await slides.edit([EDIT])).actionId).toBe(12);
  });
});
