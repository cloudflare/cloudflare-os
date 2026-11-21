// A Node setup file: every suite's call that builds an edit from a whole tab's rendering also
// builds it from the closure of its own elements, failing the test where batch or refusal differ.
// Whole closures and tabs over 2,000 elements pass through; maps are weak; `renderRun` counts
// nothing.

import { vi } from "vitest";
import type { GoogleDocsRequest, GoogleDocsTab } from "../src/docs-api";
import type { DocEdit, MadeDocEdit, QueuedDocEdit } from "../src/docs-replay";
import type { DocTabSnapshot, OwnRange, TabReading } from "../src/markdown-converter";

/** What the shadow counts of the calls it sees. */
export type ShadowTally = {
  /** Calls whose tab was known: each is one of `strict`, `whole`, or refused before a piece. */
  shadowed: number;
  /** Calls built again from a closure that leaves an element of the tab out, and compared. */
  strict: number;
  /** Calls whose closure is the whole tab: not built again. */
  whole: number;
  /** Calls on a tab of more than 2,000 body elements: passed straight through. */
  large: number;
  /** Calls with no tab to cut from: a rendering of a tab no longer alive, or of a part. */
  skipped: number;
};

/** Another range than the closure, for a test of the shadow itself (`shrinkShadowForTest`). */
type ShadowShrink = (
  closure: { from: number; to: number }, own: { first: number; last: number }, flags: readonly number[],
) => { from: number; to: number };

/** What the pass that renders a tab as one run says of its elements, as numbers. */
type Told = {
  starts: Uint32Array; flags: Uint8Array;
  /** Where each element starts and ends in the tab's indexes. */
  indexStarts: readonly number[]; indexEnds: readonly number[];
};

type Converter = typeof import("../src/markdown-converter");
type State = {
  tally: ShadowTally;
  /** Above 0 inside a wrapped call or a shadow's own build: a call made there passes through. */
  depth: number;
  shrink?: ShadowShrink;
  /** The tab a rendering was made of, by the rendering's source map. */
  tabs: WeakMap<object, WeakRef<GoogleDocsTab>>;
  /** The last rendering made of a tab. */
  renderings: WeakMap<GoogleDocsTab, WeakRef<DocTabSnapshot>>;
  told: WeakMap<GoogleDocsTab, Told>;
  /** The one place an edit becomes requests, once the module that holds it is loaded. */
  tabEditRequests?: (tab: TabReading, edit: DocEdit) => GoogleDocsRequest[];
};

// One state a worker, shared by the setup file's instance and a test's import.
const KEY = Symbol.for("gatekeeper-google.docs-piece-suite-shadow");
const shared = globalThis as { [KEY]?: State };
const state: State = shared[KEY] ??= {
  tally: { shadowed: 0, strict: 0, whole: 0, large: 0, skipped: 0 },
  depth: 0, tabs: new WeakMap(), renderings: new WeakMap(), told: new WeakMap(),
};

/** What the shadow has counted in this worker so far. */
export function shadowTally(): ShadowTally {
  return { ...state.tally };
}

/** For a test of the shadow itself: builds from the range `shrink` makes of each closure. */
export function shrinkShadowForTest(shrink: ShadowShrink | undefined): void {
  state.shrink = shrink;
}

/** Thrown by the shadow's reading where the closure is the whole tab: nothing to build again. */
const WHOLE = Symbol("the closure is the whole tab");

/** What a build gave: its batch as JSON, or the refusal it threw. */
type Built = { requests: string } | { refused: string };

/** The outcome of `run`, or `undefined` where what it threw is no refusal of the builders. */
function builtBy(run: () => readonly GoogleDocsRequest[]): Built | undefined {
  try {
    return { requests: JSON.stringify(run()) };
  } catch (error) {
    if (error === WHOLE) throw error;
    if (!(error instanceof Error) || error instanceof TypeError) return undefined;
    return { refused: `${error.name}: ${error.message}` };
  }
}

/**
 * Holds `whole`, an edit's outcome from the whole rendering of `tab`, to the same built from
 * its closure; throws, naming `entry` and the kind of difference, where they differ.
 */
function held(
  converter: Converter, wholeTabReading: (render: DocTabSnapshot) => TabReading,
  hasModelIndexes: (tab: GoogleDocsTab) => boolean,
  entry: string, tab: GoogleDocsTab | undefined, rendering: DocTabSnapshot | undefined, edit: DocEdit,
  whole: Built | undefined,
): void {
  let build = state.tabEditRequests;
  if (!tab || !rendering || rendering.part || !build || !whole || !hasModelIndexes(tab)) {
    state.tally.skipped++;
    return;
  }
  let content = tab.body.content;
  if (content.length > 2_000) {
    state.tally.large++;
    return;
  }
  state.tally.shadowed++;
  let rendered = () => converter.renderRun(
    content, tab, converter.initialCarry(), { mdStart: 0, elements: true });
  // A tab seen for the first time is rendered once, and its piece cut from that run.
  let fresh: ReturnType<typeof rendered> | undefined;
  let told = state.told.get(tab);
  if (!told) {
    fresh = rendered();
    let { starts, flags } = fresh.elements!;
    let indexStarts: number[] = [], indexEnds: number[] = [];
    let end = 0;
    for (let [at, element] of content.entries()) {
      if (at === 0 && Number.isInteger(element.startIndex)) end = element.startIndex;
      indexStarts.push(Number.isInteger(element.startIndex) ? element.startIndex : end);
      if (Number.isInteger(element.endIndex)) end = element.endIndex;
      indexEnds.push(end);
    }
    state.told.set(tab, told = { starts, flags, indexStarts, indexEnds });
  }
  let { starts, flags, indexStarts, indexEnds } = told;
  let asked = wholeTabReading(rendering);
  let strict = false;
  let reading: TabReading = {
    tabId: asked.tabId,
    blank: () => asked.blank(),
    find: (text, lineBreakBefore) => asked.find(text, lineBreakBefore),
    tables: () => asked.tables(),
    tablesShaped: shape => asked.tablesShaped(shape),
    numberedAfter: table => asked.numberedAfter(table),
    lineBefore: mdStart => asked.lineBefore(mdStart),
    piece(own: OwnRange) {
      // The own elements, by `OwnRange`'s rule, and their closure in the tab whole.
      let holder = (offset: number) => starts.findLastIndex(start => start <= offset);
      let last = flags.length - 1;
      let table = (number: number) => Array.from(flags)
        .flatMap((flag, element) => flag & converter.ELEMENT_TABLE ? [element] : [])[number];
      let elements = own === "end" ? { first: last, last }
        : "table" in own ? { first: table(own.table), last: table(own.table) }
        : {
          first: holder(own.markdown.mdStart),
          last: holder(Math.max(own.markdown.mdStart, own.markdown.mdEnd - 1)),
        };
      let closure = converter.closureOf(flags, elements, { first: true, last: true });
      if ("more" in closure) throw new Error("The suites' shadow: a whole tab's closure asks for more.");
      let range = state.shrink ? state.shrink(closure, elements, Array.from(flags)) : closure;
      if (range.from === 0 && range.to === flags.length) throw WHOLE;
      strict = true;
      let joined = converter.noRenderedRuns();
      converter.joinRenderedRun(joined, fresh ?? rendered());
      fresh = undefined;
      let cut = converter.pieceRendering(joined, range.from, range.to);
      return {
        ...rendering, markdown: cut.markdown, sourceMap: cut.sourceMap,
        part: {
          mdStart: cut.mdStart, tablesBefore: cut.tablesBefore, first: range.from === 0,
          last: range.to === flags.length,
          inner: { from: indexEnds[range.from], to: indexStarts[range.to - 1] }, tab: reading,
        },
      };
    },
  };
  let again: Built | undefined;
  state.depth++;
  try {
    again = builtBy(() => build(reading, edit));
  } catch (signal) {
    if (signal !== WHOLE) throw signal;
    state.tally.whole++;
    return;
  } finally {
    state.depth--;
  }
  if (strict) state.tally.strict++;
  if (!again) throw new Error(`The suites' shadow: ${entry} faults where it builds from the closure of its edit.`);
  if (JSON.stringify(again) === JSON.stringify(whole)) return;
  let difference = "requests" in again && "requests" in whole ? "another batch"
    : "refused" in again && "refused" in whole ? "another refusal"
    : "refused" in again ? "a refusal the whole tab does not give" : "a batch where the whole tab refuses";
  throw new Error(
    `The suites' shadow: ${entry} builds ${difference} from the closure of its edit's own elements.`);
}

vi.mock("../src/markdown-converter", async importOriginal => {
  let converter = await importOriginal<Converter>();
  let docTabToMarkdown: Converter["docTabToMarkdown"] = tab => {
    let rendering = converter.docTabToMarkdown(tab);
    // Weak both ways, so that a rendering a test holds keeps no tab alive.
    state.tabs.set(rendering.sourceMap, new WeakRef(tab));
    state.renderings.set(tab, new WeakRef(rendering));
    return rendering;
  };
  return { ...converter, docTabToMarkdown };
});

vi.mock("../src/docs-tables", async importOriginal => {
  let tables = await importOriginal<typeof import("../src/docs-tables")>();
  let converter = await vi.importActual<Converter>("../src/markdown-converter");
  let { hasModelIndexes } = await vi.importActual<typeof import("../src/docs-model")>("../src/docs-model");
  let tableChangeRequests: typeof tables.tableChangeRequests = (render, change) => {
    if (state.depth > 0) return tables.tableChangeRequests(render, change);
    let requests: GoogleDocsRequest[] | undefined, thrown: unknown;
    state.depth++;
    try {
      requests = tables.tableChangeRequests(render, change);
    } catch (error) {
      thrown = error;
    } finally {
      state.depth--;
    }
    held(
      converter, tables.wholeTabReading, hasModelIndexes, "tableChangeRequests",
      state.tabs.get(render.sourceMap)?.deref(), render, change,
      builtBy(() => {
        if (requests) return requests;
        throw thrown;
      }));
    if (requests) return requests;
    throw thrown;
  };
  return { ...tables, tableChangeRequests };
});

vi.mock("../src/docs-replay", async importOriginal => {
  let replay = await importOriginal<typeof import("../src/docs-replay")>();
  let converter = await vi.importActual<Converter>("../src/markdown-converter");
  let { wholeTabReading } = await vi.importActual<typeof import("../src/docs-tables")>("../src/docs-tables");
  let { hasModelIndexes } = await vi.importActual<typeof import("../src/docs-model")>("../src/docs-model");
  state.tabEditRequests = replay.tabEditRequests;

  /**
   * `run`, an entry point, its outcome then held to the closure's; `found` says what it built
   * from, and `build: false` for a throw that is no outcome of the builders.
   */
  let shadowed = <T>(
    entry: string, edit: DocEdit, run: () => T,
    found: (made: { value: T } | { thrown: unknown }) => {
      tab?: GoogleDocsTab; rendering?: DocTabSnapshot; requests?: readonly GoogleDocsRequest[];
      build?: false;
    },
  ): T => {
    if (state.depth > 0) return run();
    let made: { value: T } | { thrown: unknown };
    state.depth++;
    try {
      made = { value: run() };
    } catch (thrown) {
      made = { thrown };
    } finally {
      state.depth--;
    }
    let { tab, rendering, requests, build } = found(made);
    if (build !== false) {
      held(converter, wholeTabReading, hasModelIndexes, entry, tab, rendering, edit, builtBy(() => {
        if (requests) return requests;
        throw (made as { thrown: unknown }).thrown;
      }));
    }
    if ("thrown" in made) throw made.thrown;
    return made.value;
  };
  /** Whether `thrown` is the model's refusal of a batch the builders had built. */
  let byModel = (thrown: unknown) => thrown instanceof replay.DocModelError &&
    !(thrown.cause instanceof replay.DocPieceOverreachError) &&
    !(thrown.cause instanceof Error && thrown.cause.name === "DocPieceError");

  let docEditRequests: typeof replay.docEditRequests = (render, edit) => shadowed(
    "docEditRequests", edit, () => replay.docEditRequests(render, edit),
    made => ({
      tab: state.tabs.get(render.sourceMap)?.deref(), rendering: render,
      ...("value" in made ? { requests: made.value } : {}),
    }));
  let makeAs = (
    entry: string, tab: GoogleDocsTab, edit: DocEdit, rendering?: DocTabSnapshot,
  ): MadeDocEdit => shadowed(
    entry, edit, () => rendering ? replay.makeDocEdit(tab, edit, rendering) : replay.makeDocEdit(tab, edit),
    made => "value" in made
      ? { tab, rendering: rendering ?? state.renderings.get(tab)?.deref(), requests: made.value.requests }
      : byModel(made.thrown) ? { build: false }
      : { tab, rendering: rendering ?? state.renderings.get(tab)?.deref() });
  let makeDocEdit: typeof replay.makeDocEdit = (tab, edit, rendering) =>
    makeAs("makeDocEdit", tab, edit, rendering);
  // `applyDocEdit` is `makeDocEdit(tab, edit).after`, made through the shadowed entry.
  let applyDocEdit: typeof replay.applyDocEdit = (tab, edit) => makeAs("applyDocEdit", tab, edit).after;
  let materializeDocEdit: typeof replay.materializeDocEdit = (tabs, action: QueuedDocEdit) => shadowed(
    "materializeDocEdit", action, () => replay.materializeDocEdit(tabs, action),
    made => {
      if ("value" in made) {
        let { tab: rendering, requests } = made.value;
        return { tab: state.tabs.get(rendering.sourceMap)?.deref(), rendering, requests };
      }
      // A throw before the build (the edit no longer replays, or names no tab) builds nothing.
      try {
        replay.assertDocEditReplayable(action);
        let tab = replay.docEditTab(tabs, action);
        return { tab, rendering: state.renderings.get(tab)?.deref() };
      } catch {
        return { build: false };
      }
    });
  return { ...replay, docEditRequests, makeDocEdit, applyDocEdit, materializeDocEdit };
});
