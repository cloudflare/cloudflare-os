import { abortAllDurableObjects, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { googleDocActionTab } from "../../src/google";
import { MARKDOWN_RENDERING_VERSION } from "../../src/markdown-converter";
import type { GoogleDocsTab } from "../../src/docs-api";
import { buildTab } from "../doc-fixture";

/** Every write coordinate names the tab it applies to; tab bodies index independently. */
type DocCoordinate = { tabId?: string };

type BatchRequest = {
  createNamedRange?: { name: string; range: DocCoordinate };
  deleteNamedRange?: { namedRangeId: string };
  insertText?: { location: DocCoordinate & { index: number }; text: string };
  deleteContentRange?: { range: DocCoordinate & { startIndex: number; endIndex: number } };
  updateParagraphStyle?: {
    range: DocCoordinate & { startIndex: number; endIndex: number };
    paragraphStyle: { namedStyleType?: string };
    fields: string;
  };
  createParagraphBullets?: {
    range: DocCoordinate & { startIndex: number; endIndex: number };
    bulletPreset: string;
  };
  deleteParagraphBullets?: {
    range: DocCoordinate & { startIndex: number; endIndex: number };
  };
  updateTextStyle?: {
    range: DocCoordinate & { startIndex: number; endIndex: number };
    textStyle?: { link?: { url: string } };
    fields?: string;
  };
};

type ModelListItem = { id: string; preset: string };
/** `"indented"` is the indent Google leaves on a paragraph whose bullet was removed. */
type ModelListSlot = ModelListItem | "indented" | null;

function isListItem(slot: ModelListSlot | undefined): slot is ModelListItem {
  return typeof slot === "object" && slot !== null;
}

/** One tab of the model document: its own text, and its place in the tab tree. */
type ModelTab = {
  id: string;
  title: string;
  parentId?: string;
  text: string;
  table?: { before: string; rows: string[][]; after: string };
  body?: GoogleDocsTab["body"];
  links: { start: number; end: number; url: string }[];
  paragraphStyles?: string[];
  paragraphLists?: ModelListSlot[];
};
type BodyElement = GoogleDocsTab["body"]["content"][number];

function withoutDeletedParagraphs<T>(
  text: string,
  values: T[],
  start: number,
  end: number,
): T[] {
  let kept: T[] = [];
  let paragraph = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    if (index < start || index >= end) kept.push(values[paragraph]);
    paragraph++;
  }
  return kept;
}

/** Indexes of the plain-text paragraphs `range` touches. */
function paragraphsIn(text: string, range: { startIndex: number; endIndex: number }): number[] {
  let startIndex = 1;
  return text.split("\n").flatMap((paragraph, index) => {
    let endIndex = startIndex + paragraph.length + 1;
    let overlaps = range.startIndex < endIndex && range.endIndex > startIndex;
    startIndex = endIndex;
    return overlaps ? [index] : [];
  });
}

/** The tab a single-tab document has, and the one the tab-agnostic tests exercise. */
const MAIN_TAB = "tab-1";

/** A batch either carries the edit and its marker, or deletes a marker on its own. */
type BatchKind = "content" | "cleanup";

class DocsModel {
  cleanupFailures = 0;
  ambiguousContentResponses = 0;
  contentBatches = 0;
  maxMarkerCount = 0;
  /** Google withholds `revisionId` from a caller without edit access. */
  editable = true;
  /** Full `documents.get` calls, excluding the lightweight revision probe. */
  documentFetches = 0;
  revisionProbes = 0;
  driveFetches = 0;
  /** Drive's modification time for the document. */
  driveModifiedTime = "2026-01-02T03:04:05Z";
  /** What Drive answers with instead of that time, if anything. */
  driveFailure: { status: number; reason?: string } | "malformed" | null = null;
  readonly deletedMarkerIds: string[] = [];
  /** Marker ID to its name and owning tab. */
  readonly markers = new Map<string, { name: string; tabId: string }>();
  /** Tab each write marker was anchored in, retained after cleanup deletes the marker. */
  readonly markerTabIds: string[] = [];
  /** Every tab in preorder; the first is the one a single-tab document has. */
  readonly tabs: ModelTab[] = [{ id: MAIN_TAB, title: "Main", text: "", links: [] }];
  #revision = 1;
  #nextMarkerId = 1;
  #nextListId = 1;
  readonly #held = new Map<BatchKind, { reach: () => void; released: Promise<void> }>();

  install(): void {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) =>
      this.fetch(input, init)));
  }

  addMarker(name: string, id: string, tabId = MAIN_TAB): void {
    this.markers.set(id, { name, tabId });
    this.#recordMarkerCount();
  }

  addTab(id: string, title: string, parentId: string, text = ""): void {
    this.tabs.push({ id, title, parentId, text, links: [] });
  }

  removeTab(id: string): void {
    this.tabs.splice(this.tabs.findIndex(tab => tab.id === id), 1);
    this.#revision++;
  }

  setText(tabId: string, text: string): void {
    this.#tab(tabId).text = text;
  }

  setLinkedText(tabId: string, text: string, url: string): void {
    let tab = this.#tab(tabId);
    tab.text = text;
    tab.links = [{ start: 0, end: text.length, url }];
  }

  setParagraphs(
    tabId: string, paragraphs: { text: string; namedStyleType: string }[],
  ): void {
    let tab = this.#tab(tabId);
    tab.text = paragraphs.map(paragraph => paragraph.text).join("\n");
    tab.paragraphStyles = paragraphs.map(paragraph => paragraph.namedStyleType);
  }

  setNumberedList(tabId: string, items: string[]): void {
    this.#setList(tabId, items, "NUMBERED_DECIMAL_ALPHA_ROMAN");
  }

  setBulletedList(tabId: string, items: string[]): void {
    this.#setList(tabId, items, "BULLET_DISC_CIRCLE_SQUARE");
  }

  #setList(tabId: string, items: string[], preset: string): void {
    let tab = this.#tab(tabId);
    let list = { id: `list-${this.#nextListId++}`, preset };
    tab.text = items.join("\n");
    tab.paragraphLists = items.map(() => list);
  }
  interruptList(tabId: string, index: number): void {
    this.#tab(tabId).paragraphLists![index] = null;
  }

  setTable(tabId: string, before: string, rows: string[][], after: string): void {
    this.#tab(tabId).table = { before, rows, after };
  }
  setBody(tabId: string, body: GoogleDocsTab["body"]): void {
    this.#tab(tabId).body = body;
  }

  text(tabId = MAIN_TAB): string {
    let tab = this.#tab(tabId);
    if (!tab.body) return tab.text;
    return tab.body.content.flatMap(element =>
      element.paragraph?.elements.flatMap(part => part.textRun?.content ?? []) ?? [],
    ).join("").replace(/\n$/, "");
  }

  renderedText(tabId = MAIN_TAB): string {
    let tab = this.#tab(tabId);
    let counts = new Map<string, number>();
    return tab.text.split("\n").map((text, index) => {
      let list = tab.paragraphLists?.[index];
      if (list === "indented") return `\t${text}`;
      if (!list) return text;
      let number = (counts.get(list.id) ?? 0) + 1;
      counts.set(list.id, number);
      return `${number}. ${text}`;
    }).join("\n");
  }

  clearMarkers(): void {
    this.markers.clear();
  }

  /**
   * Holds the next write of `kind` open, so another request can interleave with it mid-flight.
   *
   * `reached` resolves once the provider has the request in hand, before anything is applied.
   */
  hold(kind: BatchKind): { reached: Promise<void>; release: () => void } {
    let reach!: () => void;
    let release!: () => void;
    let reached = new Promise<void>(resolve => { reach = resolve; });
    let released = new Promise<void>(resolve => { release = resolve; });
    this.#held.set(kind, { reach, released });
    return { reached, release };
  }

  /** A collaborator edit: the document changes without this gatekeeper writing to it. */
  externalEdit(tabId = MAIN_TAB, text?: string): void {
    let tab = this.#tab(tabId);
    tab.text = text ?? tab.text + "collaborator";
    this.#revision++;
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "www.googleapis.com") {
      this.driveFetches++;
      if (this.driveFailure === "malformed") {
        return Response.json({ id: "doc-1", name: "Test document" });
      }
      if (this.driveFailure) {
        let { status, reason } = this.driveFailure;
        return Response.json(
          { error: { code: status, errors: reason ? [{ reason }] : [] } }, { status });
      }
      return Response.json(
        { id: "doc-1", name: "Test document", modifiedTime: this.driveModifiedTime });
    }
    if (url.hostname !== "docs.googleapis.com") {
      throw new Error(`Unexpected provider request: ${url}`);
    }
    if (!url.pathname.endsWith(":batchUpdate")) {
      let fields = url.searchParams.get("fields");
      if (fields === null) this.documentFetches++;
      else if (fields === "revisionId") this.revisionProbes++;
      return Response.json(this.#document());
    }

    let body = JSON.parse(String(init?.body)) as {
      requests: BatchRequest[];
      writeControl?: { requiredRevisionId?: string };
    };
    let isDelete = body.requests.length === 1 && !!body.requests[0].deleteNamedRange;
    await this.#hold(isDelete ? "cleanup" : "content");
    if (isDelete && this.cleanupFailures > 0) {
      this.cleanupFailures--;
      throw new Error("cleanup failed");
    }
    if (body.writeControl?.requiredRevisionId &&
        body.writeControl.requiredRevisionId !== `revision-${this.#revision}`) {
      return Response.json({ error: { code: 400, message: "revision mismatch" } }, { status: 400 });
    }

    let replies: unknown[] = [];
    let hasContent = false;
    for (const request of body.requests) {
      if (request.deleteNamedRange) {
        this.markers.delete(request.deleteNamedRange.namedRangeId);
        this.deletedMarkerIds.push(request.deleteNamedRange.namedRangeId);
        replies.push({});
        continue;
      }

      // Google resolves an unqualified coordinate against a default tab, so a request that omits
      // the ID would edit whichever tab that happens to be.
      let coordinate = request.createNamedRange?.range ?? request.insertText?.location ??
        request.deleteContentRange?.range ?? request.updateParagraphStyle?.range ??
        request.createParagraphBullets?.range ?? request.deleteParagraphBullets?.range ??
        request.updateTextStyle?.range;
      if (!coordinate?.tabId) {
        throw new Error(`Google Docs request is missing tabId: ${JSON.stringify(request)}`);
      }
      let tab = this.#tab(coordinate.tabId);

      if (request.createNamedRange) {
        let id = `marker-${this.#nextMarkerId++}`;
        this.addMarker(request.createNamedRange.name, id, tab.id);
        this.markerTabIds.push(tab.id);
        replies.push({ createNamedRange: { namedRangeId: id } });
        continue;
      }

      hasContent = true;
      if (request.insertText) {
        this.#insertText(
          tab, request.insertText.location.index, request.insertText.text,
        );
      } else if (request.deleteContentRange) {
        let { startIndex, endIndex } = request.deleteContentRange.range;
        this.#deleteText(tab, startIndex, endIndex);
      } else if (request.updateParagraphStyle) {
        let { range, paragraphStyle, fields } = request.updateParagraphStyle;
        if (paragraphStyle.namedStyleType) {
          this.#setParagraphStyle(tab, range, paragraphStyle.namedStyleType);
        }
        if (fields.split(",").includes("indentStart")) this.#clearIndent(tab, range);
      } else if (request.deleteParagraphBullets) {
        this.#setBullets(tab, request.deleteParagraphBullets.range);
      } else if (request.createParagraphBullets) {
        this.#setBullets(
          tab, request.createParagraphBullets.range, request.createParagraphBullets.bulletPreset,
        );
      } else if (request.updateTextStyle && (
        request.updateTextStyle.textStyle?.link || request.updateTextStyle.fields?.includes("link")
      )) {
        let { startIndex, endIndex } = request.updateTextStyle.range;
        this.#setLink(
          tab, startIndex - 1, endIndex - 1,
          request.updateTextStyle.textStyle?.link?.url,
        );
      }
      replies.push({});
    }
    if (hasContent) this.contentBatches++;
    this.#revision++;
    this.#recordMarkerCount();

    if (hasContent && this.ambiguousContentResponses > 0) {
      this.ambiguousContentResponses--;
      throw new Error("content response lost");
    }
    return Response.json({
      replies,
      writeControl: { requiredRevisionId: `revision-${this.#revision}` },
    });
  }

  #insertText(tab: ModelTab, index: number, text: string): void {
    if (tab.body) {
      this.#replaceBodyText(tab, index, index, text);
      return;
    }
    if (tab.table) {
      this.#replaceTableText(tab, index, index, text);
      return;
    }
    let offset = index - 1;
    let paragraph = tab.text.slice(0, offset).split("\n").length - 1;
    let insertedParagraphs = text.split("\n").length - 1;
    if (tab.paragraphStyles) {
      let style = tab.paragraphStyles[paragraph];
      tab.paragraphStyles.splice(paragraph, 0, ...Array(insertedParagraphs).fill(style));
    }
    if (tab.paragraphLists) {
      let list = tab.paragraphLists[paragraph] ?? null;
      tab.paragraphLists.splice(paragraph, 0, ...Array(insertedParagraphs).fill(list));
    }
    for (const link of tab.links) {
      if (link.start >= offset) {
        link.start += text.length;
        link.end += text.length;
      } else if (link.end > offset) {
        link.end += text.length;
      }
    }
    tab.text = tab.text.slice(0, offset) + text + tab.text.slice(offset);
  }

  #deleteText(tab: ModelTab, startIndex: number, endIndex: number): void {
    if (tab.body) {
      this.#replaceBodyText(tab, startIndex, endIndex, "");
      return;
    }
    if (tab.table) {
      this.#replaceTableText(tab, startIndex, endIndex, "");
      return;
    }
    let start = startIndex - 1;
    let end = endIndex - 1;
    let removed = end - start;
    let fullText = `${tab.text}\n`;
    if (tab.paragraphStyles) {
      tab.paragraphStyles = withoutDeletedParagraphs(fullText, tab.paragraphStyles, start, end);
    }
    if (tab.paragraphLists) {
      tab.paragraphLists = withoutDeletedParagraphs(fullText, tab.paragraphLists, start, end);
    }
    let links: ModelTab["links"] = [];
    for (const link of tab.links) {
      if (link.end <= start) links.push(link);
      else if (link.start >= end) {
        links.push({ ...link, start: link.start - removed, end: link.end - removed });
      } else {
        if (link.start < start) links.push({ ...link, end: start });
        if (link.end > end) {
          links.push({ ...link, start, end: link.end - removed });
        }
      }
    }
    tab.links = this.#normalizeLinks(links);
    tab.text = tab.text.slice(0, start) + tab.text.slice(end);
  }

  #replaceBodyText(
    tab: ModelTab, startIndex: number, endIndex: number, replacement: string,
  ): void {
    let content = tab.body!.content;
    for (let structureIndex = 0; structureIndex < content.length; structureIndex++) {
      let structure = content[structureIndex];
      let elements = structure.paragraph?.elements;
      if (!elements) continue;
      let elementIndex = elements.findIndex(element => element.textRun &&
        startIndex >= element.startIndex && endIndex <= element.endIndex);
      if (elementIndex < 0) continue;

      let element = elements[elementIndex];
      let text = element.textRun!.content;
      let start = startIndex - element.startIndex;
      let end = endIndex - element.startIndex;
      element.textRun!.content = text.slice(0, start) + replacement + text.slice(end);
      let delta = replacement.length - (endIndex - startIndex);
      element.endIndex += delta;
      for (let index = elementIndex + 1; index < elements.length; index++) {
        elements[index].startIndex += delta;
        elements[index].endIndex += delta;
      }
      structure.endIndex += delta;
      for (let index = structureIndex + 1; index < content.length; index++) {
        this.#shiftBodyElement(content[index], delta);
      }
      return;
    }
    throw new Error("Fixture cannot edit structured content");
  }

  #shiftBodyElement(element: BodyElement, delta: number): void {
    element.startIndex += delta;
    element.endIndex += delta;
    for (let part of element.paragraph?.elements ?? []) {
      part.startIndex += delta;
      part.endIndex += delta;
    }
    for (let row of element.table?.tableRows ?? []) {
      row.startIndex += delta;
      row.endIndex += delta;
      for (let cell of row.tableCells ?? []) {
        cell.startIndex += delta;
        cell.endIndex += delta;
        for (let child of cell.content ?? []) this.#shiftBodyElement(child, delta);
      }
    }
  }

  #setBullets(
    tab: ModelTab,
    range: { startIndex: number; endIndex: number },
    preset?: string,
  ): void {
    let indexes = paragraphsIn(tab.text, range);
    if (!preset) {
      for (let index of indexes) if (tab.paragraphLists?.[index]) tab.paragraphLists[index] = "indented";
      return;
    }
    let lists = tab.paragraphLists ??= tab.text.split("\n").map(() => null);
    let first = indexes[0];
    if (first === undefined) return;
    let preceding = lists[first - 1];
    let id = isListItem(preceding) && preceding.preset === preset
      ? preceding.id : `list-${this.#nextListId++}`;
    for (let index of indexes) lists[index] = { id, preset };
  }

  #clearIndent(tab: ModelTab, range: { startIndex: number; endIndex: number }): void {
    let lists = tab.paragraphLists;
    for (let index of paragraphsIn(tab.text, range)) {
      if (lists?.[index] === "indented") lists[index] = null;
    }
  }

  #setLink(tab: ModelTab, start: number, end: number, url?: string): void {
    let links: ModelTab["links"] = [];
    for (const link of tab.links) {
      if (link.end <= start || link.start >= end) links.push(link);
      else {
        if (link.start < start) links.push({ ...link, end: start });
        if (link.end > end) links.push({ ...link, start: end });
      }
    }
    if (url) links.push({ start, end, url });
    tab.links = this.#normalizeLinks(links);
  }

  #normalizeLinks(links: ModelTab["links"]): ModelTab["links"] {
    links.sort((a, b) => a.start - b.start || a.end - b.end);
    let normalized: ModelTab["links"] = [];
    for (const link of links) {
      if (link.start === link.end) continue;
      let previous = normalized.at(-1);
      if (previous?.url === link.url && previous.end >= link.start) {
        previous.end = Math.max(previous.end, link.end);
      } else {
        normalized.push({ ...link });
      }
    }
    return normalized;
  }

  #setParagraphStyle(
    tab: ModelTab,
    range: { startIndex: number; endIndex: number },
    namedStyleType: string,
  ): void {
    if (tab.body) {
      for (let element of tab.body.content) {
        if (element.paragraph && range.startIndex < element.endIndex &&
            range.endIndex > element.startIndex) {
          element.paragraph.paragraphStyle.namedStyleType = namedStyleType;
        }
      }
      return;
    }
    let styles = tab.paragraphStyles ??=
      tab.text.split("\n").map(() => "NORMAL_TEXT");
    for (let index of paragraphsIn(tab.text, range)) styles[index] = namedStyleType;
  }

  #replaceTableText(
    tab: ModelTab, startIndex: number, endIndex: number, replacement: string,
  ): void {
    let table = tab.table;
    if (!table) throw new Error("Expected a table-backed tab");
    let start = this.#tableTextPoint(table, startIndex);
    let end = this.#tableTextPoint(table, endIndex);
    if (!start || !end || start.field !== end.field) {
      throw new Error("Fixture cannot edit table structure");
    }
    let text = table[start.field];
    table[start.field] = text.slice(0, start.offset) + replacement + text.slice(end.offset);
  }

  #tableTextPoint(table: NonNullable<ModelTab["table"]>, index: number): {
    field: "before" | "after";
    offset: number;
  } | undefined {
    let content = this.#tableBody(table).content;
    let paragraphs = [
      { field: "before" as const, element: content[1] },
      { field: "after" as const, element: content.at(-1)! },
    ];
    for (const { field, element } of paragraphs) {
      if (index >= element.startIndex && index <= element.endIndex - 1) {
        return { field, offset: index - element.startIndex };
      }
    }
  }

  #tableBody(table: NonNullable<ModelTab["table"]>): GoogleDocsTab["body"] {
    return buildTab([
      { runs: [`${table.before}\n`] },
      { table: table.rows.map(row => row.map(cell => `${cell}\n`)) },
      { runs: [`${table.after}\n`] },
    ]).body;
  }

  /** Blocks a held write until the test releases it. One hold, so a retry is never held twice. */
  async #hold(kind: BatchKind): Promise<void> {
    let held = this.#held.get(kind);
    if (!held) return;
    this.#held.delete(kind);
    held.reach();
    await held.released;
  }

  #recordMarkerCount(): void {
    this.maxMarkerCount = Math.max(this.maxMarkerCount, this.markers.size);
  }

  #tab(id: string): ModelTab {
    let tab = this.tabs.find(candidate => candidate.id === id);
    if (!tab) throw new Error(`Google Docs has no tab "${id}"`);
    return tab;
  }

  #documentTab(tab: ModelTab): unknown {
    let text = `${tab.text}\n`;
    let namedRanges: Record<string, { namedRanges: { namedRangeId: string; name: string }[] }> = {};
    for (const [namedRangeId, marker] of this.markers) {
      if (marker.tabId !== tab.id) continue;
      (namedRanges[marker.name] ??= { namedRanges: [] })
        .namedRanges.push({ namedRangeId, name: marker.name });
    }
    let body = tab.body;
    if (!body && tab.table) body = this.#tableBody(tab.table);
    let lists: GoogleDocsTab["lists"] = {};
    let paragraphLists = tab.paragraphLists;
    let paragraphStyles = tab.paragraphStyles;
    // One paragraph per line, carrying whichever of the per-paragraph attributes this tab has.
    let paragraphBody = () => buildTab(tab.text.split("\n").map((paragraphText, index) => {
      let list = paragraphLists?.[index];
      return {
        runs: [`${paragraphText}\n`],
        namedStyleType: paragraphStyles?.[index],
        ...isListItem(list) ? { bullet: { listId: list.id } } : {},
      };
    }), lists).body;

    if (!body && paragraphLists) {
      for (let item of paragraphLists) {
        if (!isListItem(item)) continue;
        let level = item.preset.startsWith("BULLET_")
          ? { glyphSymbol: "●" } : { glyphType: "DECIMAL" };
        lists[item.id] ??= { listProperties: { nestingLevels: [level] } };
      }
      body = paragraphBody();
    }
    if (!body && tab.links.length > 0) {
      let textCursor = 0;
      let runs: ({ text: string; style: { link: { url: string } } } | string)[] = [];
      for (const link of tab.links) {
        if (link.start > textCursor) runs.push(text.slice(textCursor, link.start));
        runs.push({ text: text.slice(link.start, link.end), style: { link: { url: link.url } } });
        textCursor = link.end;
      }
      if (textCursor < text.length) runs.push(text.slice(textCursor));
      body = buildTab([{ runs, namedStyleType: paragraphStyles?.[0] }]).body;
    }
    if (!body && paragraphStyles) body = paragraphBody();
    body ??= buildTab([{ runs: [text] }]).body;
    return {
      tabProperties: { tabId: tab.id, title: tab.title },
      documentTab: { body, lists, namedRanges },
      childTabs: this.tabs.filter(child => child.parentId === tab.id)
        .map(child => this.#documentTab(child)),
    };
  }

  #document() {
    return {
      documentId: "doc-1",
      title: "Test document",
      ...this.editable ? { revisionId: `revision-${this.#revision}` } : {},
      tabs: this.tabs.filter(tab => tab.parentId === undefined)
        .map(tab => this.#documentTab(tab)),
    };
  }
}

function hooks() {
  return env.TEST_HOOKS.getByName("hooks");
}

function markdownField(label: string, value: string) {
  return { label, kind: "text", value, syntax: "markdown" };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Google Doc tables", () => {
  it("returns table cells with their row structure", async () => {
    let docs = new DocsModel();
    docs.setTable(MAIN_TAB, "Before", [["Owner", "Status"], ["Alice", "Ready"]], "After");
    docs.install();

    await expect(hooks().readContent("table-read")).resolves.toContain(
      "<tr>\n    <td><p>Alice</p></td>\n    <td><p>Ready</p></td>\n  </tr>",
    );
  });

  it("refuses an append when the tab ends in a table", async () => {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, buildTab([{ table: [["Cell\n"]] }]).body);
    docs.install();

    await expect(Promise.resolve(
      hooks().submitAppend("table-append", "added"),
    )).rejects.toThrow("appendText: the selected tab does not end in a paragraph");
    expect(await hooks().lastActionDescription).toBe("");
    expect(docs.contentBatches).toBe(0);
  });

  it("drops a queued append from replay when a table becomes last", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Before");
    docs.install();
    let actionId = await hooks().submitAppend("table-append-replay", "added");

    docs.setBody(MAIN_TAB, buildTab([
      { runs: ["Before\n"] },
      { table: [["Cell\n"]] },
    ]).body);
    docs.externalEdit();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    expect(await hooks().readContent("table-append-replay")).not.toContain("added");
    expect(await hooks().applyAction("table-append-replay", actionId))
      .toContain("appendText: the selected tab does not end in a paragraph");
  });

  it("invalidates a queued append before writing when a table becomes last", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "Before");
    docs.install();
    let actionId = await hooks().submitAppend("table-append-apply", "added");

    docs.setBody(MAIN_TAB, buildTab([
      { runs: ["Before\n"] },
      { table: [["Cell\n"]] },
    ]).body);
    docs.externalEdit();

    expect(await hooks().applyAction("table-append-apply", actionId))
      .toContain("appendText: the selected tab does not end in a paragraph");
    expect(docs.contentBatches).toBe(0);
    expect(docs.markers.size).toBe(0);
  });

  it("applies and rereads text after a table", async () => {
    let docs = new DocsModel();
    docs.setTable(MAIN_TAB, "Before", [["Owner", "Status"]], "After");
    docs.install();
    let actionId = await hooks().submitReplace("table-after", "After", "Later");

    expect(await hooks().applyAction("table-after", actionId)).toBeNull();
    expect(await hooks().readContent("table-after")).toContain("\n\nLater\n");
  });

  it("uses unchanged table context to disambiguate an edit", async () => {
    let docs = new DocsModel();
    docs.setTable(MAIN_TAB, "Repeat", [["Owner"]], "Repeat");
    docs.install();
    let content = await hooks().readContent("table-context");
    let oldMarkdown = content.trimEnd();
    let newMarkdown = oldMarkdown.replace(/Repeat$/, "Updated");
    let actionId = await hooks().submitReplace("table-context", oldMarkdown, newMarkdown);

    expect(await hooks().readContent("table-context")).toBe(
      content.replace(/Repeat\n$/, "Updated\n"),
    );
    expect(await hooks().applyAction("table-context", actionId)).toBeNull();
    expect(await hooks().readContent("table-context")).toBe(
      content.replace(/Repeat\n$/, "Updated\n"),
    );
  });

  it("rejects an edit spanning a table before requesting approval", async () => {
    let docs = new DocsModel();
    docs.setTable(MAIN_TAB, "Before", [["Owner", "Alice"]], "After");
    docs.install();
    await hooks().submitReplace("table-edit", "Before", "Long before");
    let content = await hooks().readContent("table-edit");

    await expect(Promise.resolve(
      hooks().submitReplace("table-edit", content.trimEnd(), "Updated"),
    )).rejects.toThrow("replaceText: structured content cannot be edited");
    expect(await hooks().lastActionDescription).toBe("");
    expect(docs.contentBatches).toBe(0);
  });
});

describe("Google Doc structured elements", () => {
  it("rejects a rich-link URL edit before requesting approval", async () => {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, buildTab([{ runs: [
      "See ",
      { richLink: { title: "Launch plan", uri: "https://docs.google.com/document/d/plan" } },
      " today\n",
    ] }]).body);
    docs.install();

    await expect(Promise.resolve(hooks().submitReplace(
      "chip-url", "https://docs.google.com/document/d/plan", "https://example.com/new",
    ))).rejects.toThrow("replaceText: structured content cannot be edited");
    expect(await hooks().lastActionDescription).toBe("");
    expect(docs.contentBatches).toBe(0);
  });

  it("rejects insertion at a protected paragraph boundary", async () => {
    let docs = new DocsModel();
    let tab = buildTab([{ runs: ["Caption\n"] }]);
    tab.body.content[1].paragraph!.positionedObjectIds = ["image-1"];
    docs.setBody(MAIN_TAB, tab.body);
    docs.install();

    await expect(Promise.resolve(hooks().submitReplace(
      "image-boundary", "[Image] Caption", "X[Image] Caption",
    ))).rejects.toThrow("structured content cannot be edited");
    expect(await hooks().lastActionDescription).toBe("");
  });

  it("applies a heading immediately before structured content", async () => {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, buildTab([
      { runs: ["Before\n"] },
      { runs: [{ date: "Sep 16, 2026" }, "\n"] },
    ]).body);
    docs.install();
    let actionId = await hooks().submitReplace("heading-before-chip", "Before", "# Before");

    expect(await hooks().applyAction("heading-before-chip", actionId)).toBeNull();
    expect(await hooks().readContent("heading-before-chip")).toBe(
      "# Before\n\nSep 16, 2026\n",
    );
  });
});

describe("Google Doc list edits", () => {
  it("prepends an item to the existing numbered list", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["Existing"]);
    docs.install();
    let actionId = await hooks().submitReplace(
      "prepend-list", "1. Existing", "1. New\n1. Existing",
    );

    await hooks().applyAction("prepend-list", actionId);

    expect(docs.renderedText()).toBe("1. New\n2. Existing");
  });

  it("rewrites multiple items in one numbered list", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["First", "Second"]);
    docs.install();
    let actionId = await hooks().submitReplace(
      "rewrite-list", "1. First\n1. Second", "1. Changed first\n1. Changed second",
    );

    expect(await hooks().applyAction("rewrite-list", actionId)).toBeNull();
    expect(docs.renderedText()).toBe("1. Changed first\n2. Changed second");
  });

  it("normalizes an unsupported interrupted numbered-list start", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["First", "prose", "Second"]);
    docs.interruptList(MAIN_TAB, 1);
    docs.install();
    let actionId = await hooks().submitReplace(
      "restart-list", "2. Second", "3. Second",
    );
    expect(await hooks().lastActionFields).toEqual([
      markdownField("Old", "2. Second"),
      markdownField("Requested New", "3. Second"),
      markdownField("New", "1. Second"),
    ]);
    let preview = await hooks().readContent("restart-list");

    expect(preview).toBe("1. First\n\nprose\n\n1. Second\n");
    expect(await hooks().applyAction("restart-list", actionId)).toBeNull();
    expect(docs.renderedText()).toBe("1. First\nprose\n1. Second");
    expect(await hooks().readContent("restart-list")).toBe(preview);
  });

  it("rewrites a list item and the prose after it", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["First", "Body"]);
    docs.interruptList(MAIN_TAB, 1);
    docs.install();
    let actionId = await hooks().submitReplace(
      "list-prose", "1. First\n\nBody", "1. Changed\n\nUpdated",
    );
    let preview = await hooks().readContent("list-prose");

    expect(preview).toBe("1. Changed\n\nUpdated\n");
    expect(await hooks().applyAction("list-prose", actionId)).toBeNull();
    expect(docs.renderedText()).toBe("1. Changed\nUpdated");
    expect(await hooks().readContent("list-prose")).toBe(preview);
  });

  it("keeps one list while rewriting the section around it", async () => {
    let docs = new DocsModel();
    docs.setBulletedList(MAIN_TAB, ["Intro", "Ship", "Docs", "Owner"]);
    docs.interruptList(MAIN_TAB, 0);
    docs.interruptList(MAIN_TAB, 3);
    docs.install();
    let actionId = await hooks().submitReplace(
      "section", "Intro\n\n- Ship\n- Docs\n\nOwner",
      "Intro edited\n\n- Ship now\n- Docs\n- Launch\n\nOwner: Bob",
    );
    let preview = await hooks().readContent("section");

    expect(preview).toBe("Intro edited\n\n- Ship now\n- Docs\n- Launch\n\nOwner: Bob\n");
    expect(await hooks().applyAction("section", actionId)).toBeNull();
    expect(docs.renderedText()).toBe("Intro edited\n1. Ship now\n2. Docs\n3. Launch\nOwner: Bob");
    expect(await hooks().readContent("section")).toBe(preview);
  });

  it("restores a kept paragraph's style after deleting the final paragraph", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [
      { text: "Kept", namedStyleType: "TITLE" },
      { text: "Removed", namedStyleType: "NORMAL_TEXT" },
    ]);
    docs.install();
    let actionId = await hooks().submitReplace("final", "# Kept\n\nRemoved", "# Added\n\n# Kept");
    let preview = await hooks().readContent("final");

    expect(preview).toBe("# Added\n\n# Kept\n");
    expect(await hooks().applyAction("final", actionId)).toBeNull();
    expect(await hooks().readContent("final")).toBe(preview);
  });

  let paragraphs = (...texts: string[]) => (docs: DocsModel) => docs.setParagraphs(
    MAIN_TAB, texts.map(text => ({ text, namedStyleType: "NORMAL_TEXT" })));
  let bullets = (...texts: string[]) => (docs: DocsModel) => docs.setBulletedList(MAIN_TAB, texts);
  it.each<[string, (docs: DocsModel) => void, string, string, string]>([
    ["split-around-empties", paragraphs("ab"), "ab", "a\n\n\n\n\n\nb", "a\n\n\n\n\n\nb\n"],
    ["merge", paragraphs("a", "b"), "a\n\nb", "ab", "ab\n"],
    ["drop-empty", paragraphs("a", "", "b"), "a\n\n\n\nb", "a\n\nb", "a\n\nb\n"],
    ["expand", paragraphs("a", "b", "c"), "b", "x\n\n\n\ny", "a\n\nx\n\n\n\ny\n\nc\n"],
    ["empty-list-gap", bullets("a", "b"), "- a\n- b", "- a\n\n\n\n- b", "- a\n\n\n\n- b\n"],
    ["end-list", bullets("a", "b"), "- a\n- b", "- a\n\nb", "- a\n\nb\n"],
    ["split-list-item", bullets("ab"), "- ab", "- a\n\nb", "- a\n\nb\n"],
    ["split-heading", docs => docs.setParagraphs(MAIN_TAB, [{ text: "Hx", namedStyleType: "HEADING_1" }]),
      "# Hx", "# H\n\nx", "# H\n\nx\n"],
    ["make-list", paragraphs("a", "b", "c"), "a\n\nb\n\nc", "- a\n- b\n- c", "- a\n- b\n- c\n"],
  ])("applies the %s paragraph structure it previews", async (facet, setup, from, to, expected) => {
    let docs = new DocsModel();
    setup(docs);
    docs.install();
    let actionId = await hooks().submitReplace(facet, from, to);

    expect(await hooks().readContent(facet)).toBe(expected);
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe(expected);
  });

  let styled = (namedStyleType: string) => (docs: DocsModel) =>
    docs.setParagraphs(MAIN_TAB, [{ text: "Plan", namedStyleType }]);
  it.each<[string, (docs: DocsModel) => void, string, string]>([
    ["heading", styled("HEADING_1"), "Notes", "# Plan\n\nNotes\n"],
    ["title", styled("TITLE"), "Notes", "# Plan\n\nNotes\n"],
    ["numbered-list", docs => docs.setNumberedList(MAIN_TAB, ["one"]), "Notes", "1. one\n\nNotes\n"],
    ["bulleted-list", bullets("one"), "a\n\nb", "- one\n\na\n\nb\n"],
    ["list-continuation", bullets("one"), "- two", "- one\n- two\n"],
  ])("appends after a %s as previewed", async (name, setup, markdown, expected) => {
    let docs = new DocsModel();
    setup(docs);
    docs.install();
    let facet = `append-after-${name}`;
    let actionId = await hooks().submitAppend(facet, markdown);

    expect(await hooks().readContent(facet)).toBe(expected);
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe(expected);
  });

  it("replays a dependent edit after appending adjacent mixed lists", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["base"]);
    docs.interruptList(MAIN_TAB, 0);
    docs.install();
    let facet = "mixed-list-replay";
    let appendId = await hooks().submitAppend(facet, "- one\n1. two");
    let replaceId = await hooks().submitReplace(facet, "1. two", "1. changed");

    expect(await hooks().readContent(facet)).toBe("base\n\n- one\n\n1. changed\n");
    expect(await hooks().applyAction(facet, appendId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("base\n\n- one\n\n1. changed\n");
    expect(await hooks().applyAction(facet, replaceId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("base\n\n- one\n\n1. changed\n");
  });

  it("joins a plain paragraph added to the preceding numbered list", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["First", "Second"]);
    docs.interruptList(MAIN_TAB, 1);
    docs.install();
    let actionId = await hooks().submitReplace(
      "join-list", "Second", "1. Second",
    );
    let preview = await hooks().readContent("join-list");

    expect(preview).toBe("1. First\n1. Second\n");
    expect(await hooks().applyAction("join-list", actionId)).toBeNull();
    expect(await hooks().readContent("join-list")).toBe(preview);
  });

  it("separates a paragraph removed from a numbered list", async () => {
    let docs = new DocsModel();
    docs.setNumberedList(MAIN_TAB, ["First", "Second"]);
    docs.install();
    let actionId = await hooks().submitReplace(
      "leave-list", "1. Second", "Second",
    );
    let preview = await hooks().readContent("leave-list");

    expect(preview).toBe("1. First\n\nSecond\n");
    expect(await hooks().applyAction("leave-list", actionId)).toBeNull();
    expect(docs.renderedText()).toBe("1. First\nSecond");
    expect(await hooks().readContent("leave-list")).toBe(preview);
  });

  it("separates adjacent lists when an item changes list type", async () => {
    let docs = new DocsModel();
    docs.setBulletedList(MAIN_TAB, ["First", "Second"]);
    docs.install();
    let actionId = await hooks().submitReplace(
      "change-list-type", "- First", "1. First",
    );
    let preview = await hooks().readContent("change-list-type");

    expect(preview).toBe("1. First\n\n- Second\n");
    expect(await hooks().applyAction("change-list-type", actionId)).toBeNull();
    expect(await hooks().readContent("change-list-type")).toBe(preview);
  });
});

describe("Google Doc write receipts", () => {
  it("applies content once and immediately deletes its exact marker", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("normal", "first");

    await hooks().applyAction("normal", actionId);

    expect(docs.text()).toContain("first");
    expect(docs.contentBatches).toBe(1);
    expect(docs.deletedMarkerIds).toEqual(["marker-1"]);
    expect(docs.markers.size).toBe(0);
    expect(await hooks().applyAction("normal", actionId)).toMatch(/Unknown pending/);
  });

  it("replays a queued edit after applying an escaped parenthesized link", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "target");
    docs.install();
    let link = "[link](https://en.wikipedia.org/wiki/Function_\\(mathematics\\))";
    let firstId = await hooks().submitReplace("escaped-link-replay", "target", link);
    let secondId = await hooks().submitReplace(
      "escaped-link-replay", link, `${link} after`,
    );

    expect(await hooks().applyAction("escaped-link-replay", firstId)).toBeNull();
    expect(await hooks().applyAction("escaped-link-replay", secondId)).toBeNull();
    expect(await hooks().readContent("escaped-link-replay")).toContain(`${link} after`);
  });

  it("replays a queued edit using its rendered Markdown", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "target");
    docs.install();
    let firstId = await hooks().submitReplace("escaped-replay", "target", String.raw`\* literal`);
    let rendered = await hooks().readContent("escaped-replay");
    let secondId = await hooks().submitReplace("escaped-replay", rendered.trimEnd(), "updated");

    expect(rendered).toBe("* literal\n");
    expect(await hooks().applyAction("escaped-replay", firstId)).toBeNull();
    expect(await hooks().applyAction("escaped-replay", secondId)).toBeNull();
    expect(await hooks().readContent("escaped-replay")).toBe("updated\n");
  });

  it("replays an edit after inserting a paragraph between separators", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [
      { text: "A", namedStyleType: "NORMAL_TEXT" },
      { text: "B", namedStyleType: "NORMAL_TEXT" },
    ]);
    docs.install();
    let facet = "separator-insert-replay";
    let firstId = await hooks().submitReplace(facet, "A\n\nB", "A\n\nX\n\nB");
    let preview = await hooks().readContent(facet);
    let secondId = await hooks().submitReplace(facet, "X\n\nB", "Y\n\nB");

    expect(preview).toBe("A\n\nX\n\nB\n");
    expect(await hooks().applyAction(facet, firstId)).toBeNull();
    expect(docs.text()).toBe("A\nX\nB");
    expect(await hooks().applyAction(facet, secondId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("A\n\nY\n\nB\n");
  });

  it("replays an edit after splitting a paragraph with an odd separator", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "AB", namedStyleType: "NORMAL_TEXT" }]);
    docs.install();
    let facet = "odd-separator-replay";
    let firstId = await hooks().submitReplace(facet, "AB", "A\n\n\nB");
    let preview = await hooks().readContent(facet);
    let secondId = await hooks().submitReplace(facet, preview.trimEnd(), "updated");

    expect(preview).toBe("A\n\n\n\nB\n");
    expect(await hooks().applyAction(facet, firstId)).toBeNull();
    expect(docs.text()).toBe("A\n\nB");
    expect(await hooks().applyAction(facet, secondId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("updated\n");
  });

  it("queues a dependent edit with canonical replacement formatting", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "target");
    docs.install();
    let facet = "formatted-link-replacement";
    await hooks().submitReplace(facet, "target", "**[x](https://e.com)**");
    let rendered = await hooks().readContent(facet);
    await hooks().submitReplace(facet, rendered.trimEnd(), "updated");

    expect(rendered).toBe("[**x**](https://e.com)\n");
    expect(await hooks().readContent(facet)).toBe("updated\n");
  });

  it("replays a dependent edit after extending a paragraph", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "A", namedStyleType: "NORMAL_TEXT" }]);
    docs.install();
    let facet = "extended-paragraph-replay";
    let firstId = await hooks().submitReplace(facet, "A", "A\nB");
    let preview = await hooks().readContent(facet);
    let secondId = await hooks().submitReplace(facet, preview.trimEnd(), "updated");

    expect(preview).toBe("A\n\nB\n");
    expect(await hooks().applyAction(facet, firstId)).toBeNull();
    expect(await hooks().applyAction(facet, secondId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("updated\n");
  });

  it("replays a dependent edit after splitting existing paragraph text", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "AB", namedStyleType: "NORMAL_TEXT" }]);
    docs.install();
    let facet = "split-paragraph-replay";
    let firstId = await hooks().submitReplace(facet, "AB", "A\nB");
    let preview = await hooks().readContent(facet);
    let secondId = await hooks().submitReplace(facet, preview.trimEnd(), "updated");

    expect(preview).toBe("A\n\nB\n");
    expect(await hooks().applyAction(facet, firstId)).toBeNull();
    expect(await hooks().applyAction(facet, secondId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("updated\n");
  });

  it("replays a dependent edit after inserting a paragraph between contextual blocks", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [
      { text: "A", namedStyleType: "NORMAL_TEXT" },
      { text: "B", namedStyleType: "NORMAL_TEXT" },
    ]);
    docs.install();
    let facet = "paragraph-boundary-replay";
    let firstId = await hooks().submitReplace(facet, "A\n\nB", "A\nX\nB");
    let preview = await hooks().readContent(facet);
    let secondId = await hooks().submitReplace(facet, preview.trimEnd(), "updated");

    expect(preview).toBe("A\n\nX\n\nB\n");
    expect(await hooks().applyAction(facet, firstId)).toBeNull();
    expect(await hooks().applyAction(facet, secondId)).toBeNull();
    expect(await hooks().readContent(facet)).toBe("updated\n");
  });

  it("invalidates a canonical no-op after its target vanishes", async () => {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, buildTab([{ runs: [
      { text: "x", style: { italic: true } }, "\n",
    ] }]).body);
    docs.install();
    let facet = "canonical-no-op-invalidation";
    await hooks().submitReplace(facet, "*x*", String.raw`\*x\*`);
    let appendId = await hooks().submitAppend(facet, "after");

    docs.setBody(MAIN_TAB, buildTab([{ runs: ["gone\n"] }]).body);
    docs.externalEdit(MAIN_TAB, "gone");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    expect(await hooks().readContent(facet)).toBe("gone\n\nafter\n");
    expect(await hooks().applyAction(facet, appendId)).toBeNull();
    expect(docs.text()).toBe("gone\nafter");
  });

  it("rejects a range that splits an escaped linked-label character", async () => {
    let docs = new DocsModel();
    docs.setLinkedText(MAIN_TAB, "a]b", "https://e.com");
    docs.install();

    await expect(Promise.resolve(
      hooks().submitReplace("split-linked-escape", "]b", "x]b"),
    )).rejects.toThrow("replaceText: Markdown escape syntax cannot be edited partially");
    expect(await hooks().lastActionDescription).toBe("");
  });

  it("materializes a link added to bracketed text", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "[x]");
    docs.install();
    let facet = "bracketed-link-replacement";
    let actionId = await hooks().submitReplace(facet, "[x]", "[x](https://e.com)");
    let preview = await hooks().readContent(facet);

    expect(preview).toBe("[x](https://e.com)\n");
    await hooks().applyAction(facet, actionId);
    expect(docs.text()).toBe("x");
    expect(await hooks().readContent(facet)).toBe(preview);
  });

  it("matches literal backslashes exactly", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, String.raw`Path \*.txt`);
    docs.install();
    let actionId = await hooks().submitReplace("literal-backslash", String.raw`\*.txt`, "files");

    expect(await hooks().applyAction("literal-backslash", actionId)).toBeNull();
    expect(await hooks().readContent("literal-backslash")).toBe("Path files\n");
  });

  it("applies the replacement its approval shows for literal escapes", async () => {
    let docs = new DocsModel();
    docs.setBody(MAIN_TAB, buildTab([{ runs: [
      { text: "x", style: { italic: true } }, "\n",
    ] }]).body);
    docs.install();
    let facet = "literal-markdown-approval";
    let actionId = await hooks().submitReplace(facet, "*x*", String.raw`\*x\*`);

    expect(await hooks().lastActionFields).toEqual([
      markdownField("Old", "*x*"),
      markdownField("Requested New", String.raw`\*x\*`),
      markdownField("New", "*x*"),
    ]);
    expect(await hooks().applyAction(facet, actionId)).toBeNull();
    expect(docs.text()).toBe("x");
  });

  it("commits whitespace when replacing a heading", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "Title", namedStyleType: "HEADING_1" }]);
    docs.install();
    let actionId = await hooks().submitReplace("heading-whitespace", "# Title", "   ");

    expect(await hooks().readContent("heading-whitespace")).toBe("   \n");
    await hooks().applyAction("heading-whitespace", actionId);

    expect(docs.text()).toBe("   ");
    expect(await hooks().readContent("heading-whitespace")).toBe("   \n");
  });

  it("resets subtitle style on paragraphs split from a subtitle", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "Subtitle", namedStyleType: "SUBTITLE" }]);
    docs.install();
    let actionId = await hooks().submitReplace(
      "subtitle-expansion", "*Subtitle*", "*first*\n\nsecond",
    );

    expect(await hooks().readContent("subtitle-expansion")).toBe("*first*\n\nsecond\n");
    await hooks().applyAction("subtitle-expansion", actionId);

    expect(await hooks().readContent("subtitle-expansion")).toBe("*first*\n\nsecond\n");
  });

  it("commits the same escaped replacement it simulates", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "x*");
    docs.install();
    let actionId = await hooks().submitReplace("escaped-suffix", "x*", String.raw`y\*`);

    expect(await hooks().readContent("escaped-suffix")).toBe("y*\n");
    await hooks().applyAction("escaped-suffix", actionId);

    expect(docs.text()).toBe("y*");
    expect(await hooks().readContent("escaped-suffix")).toBe("y*\n");
  });

  it("preserves paragraph styles through a same-count rewrite", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [
      { text: "Old", namedStyleType: "HEADING_1" },
      { text: "Body", namedStyleType: "NORMAL_TEXT" },
    ]);
    docs.install();
    let actionId = await hooks().submitReplace(
      "styled-rewrite", "# Old\n\nBody", "# New\n\nChanged",
    );

    expect(await hooks().applyAction("styled-rewrite", actionId)).toBeNull();
    expect(await hooks().readContent("styled-rewrite")).toBe("# New\n\nChanged\n");
  });

  it("preserves a closing bracket in a linked label through a heading rewrite", async () => {
    let docs = new DocsModel();
    docs.setLinkedText(MAIN_TAB, "a]b", "https://e.com");
    docs.install();
    let link = "[a\\]b](https://e.com)";
    let actionId = await hooks().submitReplace("linked-heading", link, `# ${link}`);

    expect(await hooks().readContent("linked-heading")).toBe(`# ${link}\n`);
    await hooks().applyAction("linked-heading", actionId);

    expect(await hooks().readContent("linked-heading")).toBe(`# ${link}\n`);
  });

  it("replays an insertion inside an escaped link label", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "target");
    docs.install();
    let link = "[a\\]b](https://example.com)";
    let editedLink = "[a\\]c](https://example.com)";
    let firstId = await hooks().submitReplace("linked-label-replay", "target", link);
    let secondId = await hooks().submitReplace("linked-label-replay", link, editedLink);

    expect(await hooks().applyAction("linked-label-replay", firstId)).toBeNull();
    expect(await hooks().applyAction("linked-label-replay", secondId)).toBeNull();
    expect(await hooks().readContent("linked-label-replay")).toBe(`${editedLink}\n`);
  });

  it("replays an append containing an escaped link label", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.install();
    let link = "[a\\]b](https://example.com)";
    let editedLink = "[a\\]c](https://example.com)";
    let firstId = await hooks().submitAppend("linked-label-append", link);
    let secondId = await hooks().submitReplace("linked-label-append", link, editedLink);

    expect(await hooks().applyAction("linked-label-append", firstId)).toBeNull();
    expect(await hooks().applyAction("linked-label-append", secondId)).toBeNull();
    expect(await hooks().readContent("linked-label-append")).toBe(`base\n${editedLink}\n`);
  });

  it("simulates an append with canonical formatting nesting", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.install();
    await hooks().submitAppend("formatted-link-append", "**[x](https://e.com)**");
    await hooks().submitReplace(
      "formatted-link-append", "[**x**](https://e.com)", "[**y**](https://e.com)",
    );

    expect(await hooks().readContent("formatted-link-append")).toBe(
      "base\n\n[**y**](https://e.com)\n",
    );
  });

  it("drops an append stored under an earlier Markdown version", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "base");
    docs.install();
    let facet = "legacy-append-rendering";
    await hooks().applyStorage(facet, [{
      kind: "put",
      key: "pending:action:1",
      value: {
        type: "appendText",
        documentId: "doc-1",
        tabId: MAIN_TAB,
        submittedAt: 0,
        markdown: String.raw`\* literal`,
      },
    }]);

    expect(await hooks().readContent(facet)).toBe("base\n");
  });

  it("stores one copy of an append payload", async () => {
    let docs = new DocsModel();
    docs.install();
    let facet = "append-storage";
    let markdown = "abcdef ".repeat(10_000);

    let actionId = await hooks().submitAppend(facet, markdown);
    let storedLength = await hooks().storedValueJsonLength(
      facet, `pending:action:${actionId}`,
    );

    expect(storedLength).toBeLessThan(markdown.length + 512);
    await hooks().rejectAction(facet, actionId);
  });

  it("rejects an oversized UTF-8 append before reading the document", async () => {
    let docs = new DocsModel();
    docs.install();

    await expect(Promise.resolve(
      hooks().submitAppend("oversized-append", "é".repeat(600_000)),
    )).rejects.toThrow(/1048576-byte safe submission limit/);
    expect(docs.documentFetches).toBe(0);
    expect(await hooks().lastActionDescription).toBe("");
  });

  it("rejects an oversized aggregate replacement before reading the document", async () => {
    let docs = new DocsModel();
    docs.install();

    await expect(Promise.resolve(hooks().submitReplace(
      "oversized-replacement", "x".repeat(600_000), "y".repeat(600_000),
    ))).rejects.toThrow(/1048576-byte safe submission limit/);
    expect(docs.documentFetches).toBe(0);
    expect(await hooks().lastActionDescription).toBe("");
  });

  it("rejects complex Markdown before reading the document", async () => {
    let docs = new DocsModel();
    docs.install();

    await expect(Promise.resolve(
      hooks().submitAppend("complex-append", "*x* ".repeat(2_501)),
    )).rejects.toThrow(/5000-formatting-token complexity limit/);
    expect(docs.documentFetches).toBe(0);
    expect(await hooks().lastActionDescription).toBe("");
  });

  it("shows literal Markdown escapes in the append approval", async () => {
    let docs = new DocsModel();
    docs.install();
    await hooks().submitAppend("literal-append-approval", String.raw`\# title`);

    expect(await hooks().lastActionFields).toEqual([
      markdownField("Requested", String.raw`\# title`),
      markdownField("Resulting", "# title"),
    ]);
  });

  it.each([
    ["bold", String.raw`\*\*literal\*\*`, "**literal**"],
    ["heading", String.raw`\# title`, "# title"],
    ["numbered", String.raw`1\. item`, "1. item"],
  ])("appends escaped Markdown as literal text", async (name, markdown, expected) => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "base", namedStyleType: "NORMAL_TEXT" }]);
    docs.install();
    let facet = `escaped-append-${name}`;
    let actionId = await hooks().submitAppend(facet, markdown);

    expect(await hooks().readContent(facet)).toBe(`base\n\n${expected}\n`);
    await hooks().applyAction(facet, actionId);

    expect(docs.text()).toBe(`base\n${expected}`);
    expect(await hooks().readContent(facet)).toBe(`base\n\n${expected}\n`);
  });

  it.each([
    ["spaces", "   ", "base\n\n   \n"],
    ["tab", "\t", "base\n\n\t\n"],
    ["multiple lines", "  \n\t", "base\n\n  \n\n\t\n"],
  ])("preserves a whitespace-only append with %s", async (name, markdown, rendered) => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "base", namedStyleType: "NORMAL_TEXT" }]);
    docs.install();
    let facet = `whitespace-append-${name}`;
    let actionId = await hooks().submitAppend(facet, markdown);

    expect(await hooks().readContent(facet)).toBe(rendered);
    await hooks().applyAction(facet, actionId);

    expect(docs.text()).toBe(`base\n${markdown}`);
    expect(await hooks().readContent(facet)).toBe(rendered);
  });

  it("simulates an append ending in an empty paragraph exactly", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [{ text: "base", namedStyleType: "NORMAL_TEXT" }]);
    docs.install();
    let actionId = await hooks().submitAppend("appended-empty-paragraph", "added\n\n");
    let preview = await hooks().readContent("appended-empty-paragraph");

    expect(preview).toBe("base\n\nadded\n\n\n");
    await hooks().applyAction("appended-empty-paragraph", actionId);
    expect(await hooks().readContent("appended-empty-paragraph")).toBe(preview);
  });

  it("replays a dependent edit after appending to a trailing empty paragraph", async () => {
    let docs = new DocsModel();
    docs.setParagraphs(MAIN_TAB, [
      { text: "base", namedStyleType: "NORMAL_TEXT" },
      { text: "", namedStyleType: "NORMAL_TEXT" },
    ]);
    docs.install();
    let firstId = await hooks().submitAppend("trailing-empty-append", "added");
    let content = await hooks().readContent("trailing-empty-append");
    let secondId = await hooks().submitReplace(
      "trailing-empty-append", content.trimEnd(), "changed",
    );

    expect(await hooks().applyAction("trailing-empty-append", firstId)).toBeNull();
    expect(await hooks().applyAction("trailing-empty-append", secondId)).toBeNull();
    expect(await hooks().readContent("trailing-empty-append")).toBe("changed\n");
  });

  it("reconciles a committed write after its response is lost", async () => {
    let docs = new DocsModel();
    docs.ambiguousContentResponses = 1;
    docs.install();
    let actionId = await hooks().submitAppend("ambiguous", "first");

    expect(await hooks().applyAction("ambiguous", actionId)).toMatch(/content response lost/);
    expect(docs.contentBatches).toBe(1);
    expect(docs.markers.size).toBe(1);

    await hooks().applyAction("ambiguous", actionId);

    expect(docs.contentBatches).toBe(1);
    expect(docs.markers.size).toBe(0);
    expect(await hooks().applyAction("ambiguous", actionId)).toMatch(/Unknown pending/);
  });

  it("cleans a retained receipt after restart before the next write", async () => {
    let docs = new DocsModel();
    docs.cleanupFailures = 1;
    docs.install();
    let firstId = await hooks().submitAppend("restart", "first");
    await hooks().applyAction("restart", firstId);
    expect(docs.markers.size).toBe(1);

    await abortAllDurableObjects();
    let secondId = await hooks().submitAppend("restart", "second");
    await hooks().applyAction("restart", secondId);

    expect(docs.text()).toContain("first");
    expect(docs.text()).toContain("second");
    expect(docs.contentBatches).toBe(2);
    expect(docs.maxMarkerCount).toBe(1);
    expect(docs.markers.size).toBe(0);
  });

  it("keeps the next action pending while receipt cleanup fails", async () => {
    let docs = new DocsModel();
    docs.cleanupFailures = 2;
    docs.install();
    let firstId = await hooks().submitAppend("repeated-cleanup", "first");
    await hooks().applyAction("repeated-cleanup", firstId);
    let secondId = await hooks().submitAppend("repeated-cleanup", "second");

    expect(await hooks().applyAction("repeated-cleanup", secondId)).toMatch(/cleanup failed/);
    expect(docs.contentBatches).toBe(1);
    expect(docs.markers.size).toBe(1);

    await hooks().applyAction("repeated-cleanup", secondId);
    expect(docs.contentBatches).toBe(2);
    expect(docs.markers.size).toBe(0);
  });

  it("fails closed when the current marker name has multiple IDs", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("fixed-write-id");
    let docs = new DocsModel();
    docs.addMarker("gadgets-write-fixed-write-id", "duplicate-1");
    docs.addMarker("gadgets-write-fixed-write-id", "duplicate-2");
    docs.install();
    let actionId = await hooks().submitAppend("duplicates", "first");

    expect(await hooks().applyAction("duplicates", actionId)).toMatch(
      /multiple write markers/,
    );
    expect(docs.contentBatches).toBe(0);

    docs.clearMarkers();
    await hooks().applyAction("duplicates", actionId);
    expect(docs.contentBatches).toBe(1);
  });

  it("rejects an unapplied action without creating a write receipt", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("reject", "first");

    await hooks().rejectAction("reject", actionId);

    expect(docs.contentBatches).toBe(0);
    expect(docs.markers.size).toBe(0);
    expect(await hooks().applyAction("reject", actionId)).toMatch(/Unknown pending/);
  });

  // The overseer marks a record approved only after applyAction() returns, so a second approval of
  // one action can arrive while the first is mid-write. It must not reach the provider at all.
  it("holds a second approval of one action behind the first", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("concurrent", "first");
    let write = docs.hold("content");

    let first = hooks().applyAction("concurrent", actionId);
    await write.reached;
    let second = hooks().applyAction("concurrent", actionId);
    await scheduler.wait(5);
    write.release();

    expect(await first).toBeNull();
    expect(await second).toMatch(/Unknown pending/);
    expect(docs.contentBatches).toBe(1);
    expect(docs.text().match(/first/g)).toHaveLength(1);
    expect(docs.markers.size).toBe(0);
  });

  // Between the handoff and the marker cleanup the edit is committed and its action is gone, so
  // nothing is left to overlay the snapshot the submission cached: it must not be served.
  it("stops serving the pre-write snapshot once the write is committed", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("cleanup-read", "first");
    let cleanup = docs.hold("cleanup");

    let apply = hooks().applyAction("cleanup-read", actionId);
    await cleanup.reached;
    let content = await hooks().readContent("cleanup-read");
    cleanup.release();

    expect(content).toContain("first");
    expect(await apply).toBeNull();
  });

  it("reads a lost-response append once, not once per replay", async () => {
    let docs = new DocsModel();
    docs.ambiguousContentResponses = 1;
    docs.install();
    let actionId = await hooks().submitAppend("lost-response", "first");
    expect(await hooks().applyAction("lost-response", actionId))
      .toMatch(/content response lost/);
    expect(docs.markers.size).toBe(1);

    // Past the snapshot TTL, so the next read refetches the document -- which holds the append
    // the lost response never confirmed, while its action is still pending.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    let content = await hooks().readContent("lost-response");

    expect(content.match(/first/g)).toHaveLength(1);
  });
});

describe("Google Doc metadata", () => {
  it("holds the modification time steady while the document is unchanged", async () => {
    let docs = new DocsModel();
    docs.install();

    let first = await hooks().readMetadata("metadata");
    await scheduler.wait(2);
    let second = await hooks().readMetadata("metadata");

    expect(second).toBe(first);

    docs.externalEdit();
    expect(await hooks().readMetadata("metadata")).toBeGreaterThan(first);
  });

  it("reports a pending edit as the latest modification", async () => {
    let docs = new DocsModel();
    docs.install();
    let baseline = await hooks().readMetadata("metadata-pending");
    await scheduler.wait(2);

    await hooks().submitAppend("metadata-pending", "first");

    expect(await hooks().readMetadata("metadata-pending")).toBeGreaterThan(baseline);
  });

  // Without edit access Google reports no revision, so Drive's own timestamp is the only signal
  // that a collaborator changed anything.
  it("reports Drive's modification time when there is no revision", async () => {
    let docs = new DocsModel();
    docs.editable = false;
    docs.install();

    let first = await hooks().readMetadata("metadata-read-only");
    expect(first).toBe(new Date("2026-01-02T03:04:05Z").valueOf());

    await scheduler.wait(2);
    expect(await hooks().readMetadata("metadata-read-only")).toBe(first);

    docs.driveModifiedTime = "2026-01-02T04:00:00Z";
    expect(await hooks().readMetadata("metadata-read-only"))
      .toBe(new Date("2026-01-02T04:00:00Z").valueOf());
  });

  it("holds the modification time steady when Drive metadata is not granted", async () => {
    let docs = new DocsModel();
    docs.editable = false;
    docs.driveFailure = { status: 403, reason: "insufficientPermissions" };
    docs.install();

    let first = await hooks().readMetadata("metadata-no-drive");
    await scheduler.wait(2);

    expect(await hooks().readMetadata("metadata-no-drive")).toBe(first);
    expect(docs.driveFetches).toBe(2);
  });

  // Dating the document from a transient failure would report it unchanged for as long as Drive
  // stayed unhealthy, and the stored observation would outlive the incident.
  it.each([
    ["an outage", "metadata-drive-outage", { status: 500 }],
    ["a quota refusal", "metadata-drive-quota", { status: 403, reason: "userRateLimitExceeded" }],
    ["a malformed reply", "metadata-drive-malformed", "malformed"],
  ] as const)("fails a metadata read rather than dating a document from %s", async (
    _case, facetName, failure,
  ) => {
    let docs = new DocsModel();
    docs.editable = false;
    docs.driveFailure = failure;
    docs.install();

    await expect(Promise.resolve(hooks().readMetadata(facetName))).rejects.toThrow();

    docs.driveFailure = null;
    expect(await hooks().readMetadata(facetName))
      .toBe(new Date("2026-01-02T03:04:05Z").valueOf());
  });
});

// Google withholds revisionId from a caller without edit access, which is the ordinary case for
// a Doc shared read-only.
describe("Google Doc with no revision ID", () => {
  it("reuses its snapshot inside the TTL and refetches once expired", async () => {
    let docs = new DocsModel();
    docs.editable = false;
    docs.install();

    await hooks().readContent("no-revision");
    await hooks().readContent("no-revision");
    expect(docs.documentFetches).toBe(1);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    docs.externalEdit(MAIN_TAB, "collaborator edit");

    expect(await hooks().readContent("no-revision")).toContain("collaborator edit");
    expect(docs.documentFetches).toBe(2);
    // Nothing to compare, so the probe is not worth a request.
    expect(docs.revisionProbes).toBe(0);
  });
});

/** A nested document whose three tabs all hold the same text, so an edit cannot be mistaken. */
function nestedDocs(): DocsModel {
  let docs = new DocsModel();
  docs.setText(MAIN_TAB, "shared");
  docs.addTab("details", "Details", MAIN_TAB, "shared");
  docs.addTab("metrics", "Metrics", "details", "shared");
  docs.install();
  return docs;
}

describe("Google Doc tab isolation", () => {
  it("lists the tab tree and appends only to the tab it names", async () => {
    let docs = nestedDocs();

    expect(await hooks().listTabs("tabs-append")).toEqual([
      { id: MAIN_TAB, title: "Main", index: 0, nestingLevel: 0 },
      { id: "details", title: "Details", parentTabId: MAIN_TAB, index: 0, nestingLevel: 1 },
      { id: "metrics", title: "Metrics", parentTabId: "details", index: 0, nestingLevel: 2 },
    ]);

    let actionId = await hooks().submitAppend("tabs-append", "added", "metrics");
    expect(await hooks().readContent("tabs-append", "metrics")).toContain("added");
    expect(await hooks().readContent("tabs-append", MAIN_TAB)).not.toContain("added");

    expect(await hooks().applyAction("tabs-append", actionId)).toBeNull();

    // The marker must be anchored in the tab that was edited: a marker left in another tab is
    // invisible to the retry lookup, which would re-apply the write after a lost response.
    expect(docs.markerTabIds).toEqual(["metrics"]);
    expect(docs.text("metrics")).toContain("added");
    expect(docs.text(MAIN_TAB)).toBe("shared");
    expect(docs.text("details")).toBe("shared");
  });

  it("replaces identical text in the selected tab only", async () => {
    let docs = nestedDocs();
    let actionId = await hooks().submitReplace("tabs-replace", "shared", "changed", "metrics");

    expect(await hooks().applyAction("tabs-replace", actionId)).toBeNull();

    expect(docs.markerTabIds).toEqual(["metrics"]);
    expect(docs.text("metrics")).toBe("changed");
    expect(docs.text(MAIN_TAB)).toBe("shared");
    expect(docs.text("details")).toBe("shared");
  });

  it("submits nothing for an omitted or unknown tab", async () => {
    let docs = nestedDocs();

    await expect(Promise.resolve(hooks().submitAppend("tabs-selector", "added")))
      .rejects.toThrow(/tabId is required for documents with multiple tabs/);
    await expect(Promise.resolve(
      hooks().submitReplace("tabs-selector", "shared", "changed", "ghost"),
    )).rejects.toThrow(/no tab with ID "ghost"/);

    expect(docs.contentBatches).toBe(0);
    expect(docs.text("metrics")).toBe("shared");
  });

  // A failed edit still tells the caller whether a tab, or the text in it, exists. Leaving the
  // write paths ungated would let a caller ask through appendText what getContent refuses.
  const GENERIC_READ = "Read the content of one tab of the document.";

  it.each([
    ["an omitted tab", () => hooks().submitAppend("tabs-write-oracle", "added"),
      /tabId is required for documents with multiple tabs/],
    ["an unknown tab", () => hooks().submitAppend("tabs-write-oracle", "added", "ghost"),
      /no tab with ID "ghost"/],
    ["unmatched text",
      () => hooks().submitReplace("tabs-write-oracle", "absent", "changed", "metrics"),
      /was not found in the current simulated tab/],
  ] as const)("authorizes a generic observation when an edit fails on %s", async (
    _case, submit, message,
  ) => {
    let docs = nestedDocs();

    await expect(Promise.resolve(submit())).rejects.toThrow(message);

    expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
    expect(docs.contentBatches).toBe(0);
  });

  it("is not suppressed by a same-named write marker in another tab", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("fixed-write-id");
    let docs = nestedDocs();
    docs.addMarker("gadgets-write-fixed-write-id", "other-1", MAIN_TAB);

    let actionId = await hooks().submitAppend("tabs-foreign-marker", "added", "metrics");
    expect(await hooks().applyAction("tabs-foreign-marker", actionId)).toBeNull();

    expect(docs.contentBatches).toBe(1);
    expect(docs.text("metrics")).toContain("added");
    expect(docs.text(MAIN_TAB)).toBe("shared");
  });

  it("refuses an edit whose tab is deleted before approval", async () => {
    let docs = nestedDocs();
    let actionId = await hooks().submitAppend("tabs-deleted", "added", "metrics");

    docs.removeTab("metrics");
    expect(await hooks().applyAction("tabs-deleted", actionId)).toBe(
      'appendText: no tab with ID "metrics" exists in this document. ' +
      "Call listTabs() to refresh the tab list.");

    // Approving it again must not report success for a write that never happened, and must not
    // decay into "unknown action" either — rejecting is the way out.
    let repeated = "Pending Google Doc edit could not be applied: " +
      'appendText: no tab with ID "metrics" exists in this document. ' +
      "Call listTabs() to refresh the tab list.";
    expect(await hooks().applyAction("tabs-deleted", actionId)).toBe(repeated);
    expect(await hooks().applyAction("tabs-deleted", actionId)).toBe(repeated);

    expect(docs.contentBatches).toBe(0);
    expect(docs.text(MAIN_TAB)).toBe("shared");
    expect(docs.text("details")).toBe("shared");
  });

  // Actions are approved in one global order, but each replays against only its own tab, so
  // neither edit may shift or shadow the other.
  it("replays edits queued on different tabs independently", async () => {
    let docs = nestedDocs();
    let metricsId = await hooks().submitAppend("tabs-interleaved", "alpha", "metrics");
    let mainId = await hooks().submitAppend("tabs-interleaved", "beta", MAIN_TAB);

    let metricsPreview = await hooks().readContent("tabs-interleaved", "metrics");
    let mainPreview = await hooks().readContent("tabs-interleaved", MAIN_TAB);
    expect(metricsPreview).toContain("alpha");
    expect(metricsPreview).not.toContain("beta");
    expect(mainPreview).toContain("beta");
    expect(mainPreview).not.toContain("alpha");

    expect(await hooks().applyAction("tabs-interleaved", metricsId)).toBeNull();
    expect(await hooks().applyAction("tabs-interleaved", mainId)).toBeNull();

    expect(docs.text("metrics")).toBe("shared\nalpha");
    expect(docs.text(MAIN_TAB)).toBe("shared\nbeta");
    expect(docs.text("details")).toBe("shared");
  });

  it("invalidates only the edit whose own tab moved", async () => {
    let docs = nestedDocs();
    await hooks().submitReplace("tabs-invalidate", "shared", "changed", "metrics");
    let mainId = await hooks().submitAppend("tabs-invalidate", "beta", MAIN_TAB);
    // A collaborator rewrites Metrics, so the replace no longer matches. The append targets a
    // different tab whose text never moved, so it must survive and stop waiting behind it.
    docs.externalEdit("metrics", "rewritten");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    let metricsPreview = await hooks().readContent("tabs-invalidate", "metrics");
    expect(metricsPreview).not.toContain("changed");
    expect(metricsPreview).not.toContain("beta");
    expect(await hooks().readContent("tabs-invalidate", MAIN_TAB)).toContain("beta");

    expect(await hooks().applyAction("tabs-invalidate", mainId)).toBeNull();

    expect(docs.text(MAIN_TAB)).toBe("shared\nbeta");
    expect(docs.text("metrics")).toBe("rewritten");
  });

  // Titles are user-authored, need not be unique and may be empty, so the approval a user
  // consents to has to carry the ID the write actually targets.
  it("names the target tab by ID when two tabs share a title", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "shared");
    docs.addTab("notes-a", "Notes", MAIN_TAB, "shared");
    docs.addTab("notes-b", "Notes", MAIN_TAB, "shared");
    docs.install();

    await hooks().submitAppend("tabs-duplicate-title", "added", "notes-b");

    expect(await hooks().lastActionDescription).toContain('tab "Notes" (notes-b)');
  });
});

function tabSnapshot(tabId: string, title: string) {
  return {
    tabId, title, index: 0, nestingLevel: 0,
    markdown: "shared\n", sourceMap: { blocks: [], protectedRanges: [] }, bodyEndIndex: 8,
    committedWriteIds: [],
  };
}

// A stored edit with no tab predates tab support. No current write path produces one, so this is
// the only place the migration refusal can be reached.
describe("Google Doc edits stored before tab support", () => {
  const snapshot = {
    formatVersion: MARKDOWN_RENDERING_VERSION as typeof MARKDOWN_RENDERING_VERSION,
    title: "Test document",
    revisionId: "revision-1",
    tabs: [tabSnapshot(MAIN_TAB, "Main")],
    fetchedAt: 0,
  };

  const storedAppend = {
    type: "appendText" as const,
    documentId: "doc-1",
    submittedAt: 0,
    baseRevisionId: "revision-1",
    markdown: "added",
  };

  // The old code refused to read a multi-tab document, so a stored record was approved against
  // the one tab such a document had.
  it("retargets a record naming no tab when the document still has exactly one", () => {
    expect(googleDocActionTab(snapshot, storedAppend).tabId).toBe(MAIN_TAB);
  });

  it("refuses a record naming no tab once the document has gained tabs", () => {
    let grown = { ...snapshot, tabs: [...snapshot.tabs, tabSnapshot("second", "Second")] };
    expect(() => googleDocActionTab(grown, storedAppend)).toThrow(
      "Pending Google Doc edit predates tab support and the document has gained tabs since, " +
      "so the tab it was approved against is unknown. Reject it and retry on a selected tab.");
  });

  it("refuses a vanished tab rather than retargeting to the first", () => {
    expect(() => googleDocActionTab(snapshot, { ...storedAppend, tabId: "ghost" })).toThrow(
      'appendText: no tab with ID "ghost" exists in this document. ' +
      "Call listTabs() to refresh the tab list.");
  });

  it("resolves a record that names a live tab", () => {
    expect(googleDocActionTab(snapshot, { ...storedAppend, tabId: MAIN_TAB }).title).toBe("Main");
  });
});
