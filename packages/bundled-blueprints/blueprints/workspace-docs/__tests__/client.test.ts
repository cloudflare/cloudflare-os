// The editor's handling of HTML it did not write: blocks from the server (a collaborator's or an
// agent's) reach the DOM only through the editor's scrubbing. client.ts is a gadget entry with
// top-level effects, so it is loaded once against a fake `gadget` stub and driven through it.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DocumentEvent, GadgetStub, SubscribeSnapshot, SubscriberCallbacks } from "../files/lib/protocol.ts";

const HOSTILE = '<p id="addEventListener" name="createElement">Hi<img name="getElementById" src="data:image/png;base64,AA" data-reencode="" onerror="alert(1)"><noscript>&lt;img src=x onerror=alert(1)&gt;</noscript><template><b>t</b></template></p>';

let subscriber: SubscriberCallbacks;
const editor = () => document.querySelector<HTMLElement>(".editor")!;

beforeAll(async () => {
  Object.assign(globalThis, {
    matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }),
    RpcTarget: class {},
  });
  const snapshot: SubscribeSnapshot = {
    revision: 1, title: "Doc", lastModified: 0, settings: { font: "sans", wide: false },
    blocks: [{ id: "b1", html: HOSTILE, version: 1 }],
  };
  const gadget: Partial<GadgetStub> = {
    subscribe: vi.fn(async (callbacks: SubscriberCallbacks) => { subscriber = callbacks; return snapshot; }),
    getSettings: vi.fn(async () => snapshot.settings),
    applyOperation: vi.fn(async () => ({ status: "applied" as const, revision: 2, conflicts: [] })),
  };
  Object.assign(globalThis, { gadget });
  // Not a literal specifier, so this Node-typed program does not type-check the entry under Node's
  // timer types; tsconfig.client.json checks it under the DOM's.
  const entry = "../files/client.ts";
  await import(/* @vite-ignore */ entry);
});

function expectScrubbed(block: Element | null) {
  expect(block).not.toBeNull();
  for (const node of [block!, ...block!.querySelectorAll("*")]) {
    expect(node.hasAttribute("id")).toBe(false);
    expect(node.hasAttribute("name")).toBe(false);
    expect(node.hasAttribute("onerror")).toBe(false);
    expect(node.hasAttribute("data-reencode")).toBe(false);
  }
  expect(block!.querySelector("noscript, template")).toBeNull();
}

describe("blocks from the server", () => {
  it("strip naming attributes, handlers, the re-encode mark, <noscript> and <template> from a loaded block", () => {
    const block = editor().querySelector('[data-block-id="b1"]');
    expectScrubbed(block);
    expect(block!.textContent).toBe("Hi");
    expect(block!.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA");
  });

  it("strip the same from a block a live operation brings in", () => {
    const event: DocumentEvent = {
      type: "operation", senderId: "someone", revision: 2, title: "Doc", lastModified: 0,
      upserts: [{ id: "b2", html: HOSTILE.replace("Hi", "Live"), version: 1 }], deletedIds: [], order: ["b1", "b2"],
    };
    subscriber.operation(event);
    const block = editor().querySelector('[data-block-id="b2"]');
    expectScrubbed(block);
    expect(block!.textContent).toBe("Live");
  });
});

describe("saving", () => {
  // A block deleted here while its save was in flight, and changed by someone else meanwhile,
  // comes back from the conflict where the server has it, not at the end of the document.
  it("puts a block a stale conflict brings back in its place", async () => {
    subscriber.operation({
      type: "operation", senderId: "someone", revision: 3, title: "Doc", lastModified: 0,
      upserts: [{ id: "b3", html: "<p>three</p>", version: 1 }], deletedIds: [], order: ["b1", "b2", "b3"],
    });
    const applyOperation = vi.mocked((globalThis as unknown as { gadget: GadgetStub }).gadget.applyOperation);
    applyOperation.mockImplementationOnce(async () => {
      editor().querySelector('[data-block-id="b2"]')!.remove();
      return { status: "conflict", revision: 4, conflicts: [{ id: "b2", html: "<p>theirs</p>", version: 2 }] };
    });
    editor().querySelector('[data-block-id="b2"]')!.textContent = "mine";
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(applyOperation).toHaveBeenCalled());
    await vi.waitFor(() => expect(editor().querySelector('[data-block-id="b2"]')?.textContent).toBe("theirs"));
    expect(Array.from(editor().children, (n) => n.getAttribute("data-block-id"))).toEqual(["b1", "b2", "b3"]);
  });
});

describe("editing", () => {
  let revision = 10;
  const show = (id: string, html: string) => {
    const order = [...Array.from(editor().children, (n) => n.getAttribute("data-block-id")!), id];
    subscriber.operation({ type: "operation", senderId: "someone", revision: ++revision, title: "Doc", lastModified: 0, upserts: [{ id, html, version: 1 }], deletedIds: [], order });
    return editor().querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
  };
  // The editor acts on the selection only while it has focus.
  const select = (node: Node, start: number, end = start) => {
    if (editor().tabIndex < 0) editor().tabIndex = 0;
    editor().focus();
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  };
  const press = (init: KeyboardEventInit) => editor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, metaKey: true, ctrlKey: true, ...init }));

  it("clears formatting from the selected words only", () => {
    const block = show("f1", '<p><span class="tc-red">one two three</span></p>');
    select(block.querySelector("span")!.firstChild!, 4, 7);
    press({ key: "\\", code: "Backslash" });
    expect(block.innerHTML).toBe('<span class="tc-red">one </span>two<span class="tc-red"> three</span>');
    expect(getSelection()!.toString()).toBe("two");
  });

  it("undoes ticking a to-do item", () => {
    const block = show("t1", '<ul class="checklist"><li>Task</li></ul>');
    const li = block.querySelector("li")!;
    select(li.firstChild!, 2);
    press({ key: "Enter" });
    expect(li.getAttribute("data-checked")).toBe("true");
    press({ key: "z" });
    expect(li.hasAttribute("data-checked")).toBe(false);
    press({ key: "z", shiftKey: true });
    expect(li.getAttribute("data-checked")).toBe("true");
  });

  it("takes inline code off the selected words only", () => {
    const block = show("c1", "<p><code>one two three</code></p>");
    select(block.querySelector("code")!.firstChild!, 4, 7);
    press({ key: "e" });
    expect(block.innerHTML).toBe("<code>one </code>two<code> three</code>");
    expect(getSelection()!.toString()).toBe("two");
  });
});

describe("a save in flight", () => {
  // The agent's version can already include this page's save while the reply is still on its
  // way: it must not be merged against the version before the save, or the saved words repeat.
  it("applies a newer remote version against the save it includes", async () => {
    subscriber.operation({ type: "operation", senderId: "someone", revision: 20, title: "Doc", lastModified: 0, upserts: [{ id: "r1", html: "<p>foo</p>", version: 1 }], deletedIds: [], order: [...Array.from(editor().children, (n) => n.getAttribute("data-block-id")!), "r1"] });
    const block = editor().querySelector('[data-block-id="r1"]')!;
    const applyOperation = vi.mocked((globalThis as unknown as { gadget: GadgetStub }).gadget.applyOperation);
    let reply!: () => void;
    applyOperation.mockImplementationOnce(() => new Promise((resolve) => {
      reply = () => resolve({ status: "applied", revision: 21, conflicts: [], upserts: [{ id: "r1", html: "<p>foo A</p>", version: 2 }] });
    }));
    block.textContent = "foo A";
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(reply).toBeDefined());
    subscriber.operation({ type: "operation", senderId: "agent", revision: 22, title: "Doc", lastModified: 0, upserts: [{ id: "r1", html: "<p>bar A</p>", version: 3 }], deletedIds: [], order: Array.from(editor().children, (n) => n.getAttribute("data-block-id")!) });
    reply();
    await vi.waitFor(() => expect(editor().querySelector('[data-block-id="r1"]')?.textContent).toBe("bar A"));
  });
});

describe("menus", () => {
  it("are driven from the keyboard", () => {
    const align = document.querySelector<HTMLButtonElement>(".tb.align")!;
    align.focus();
    align.click();
    const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.pop [role="menuitemradio"]'));
    expect(rows()).toHaveLength(4);
    const key = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    key("ArrowDown");
    expect(document.activeElement).toBe(rows()[0]);
    key("ArrowUp");
    expect(document.activeElement).toBe(rows()[3]);
    const picked = vi.fn();
    rows()[3].addEventListener("click", picked);
    key("Enter");
    expect(picked).toHaveBeenCalled();
  });
});

describe("block order", () => {
  // A save's reply confirms the order as of its revision; a live event from a later revision that
  // arrived first must keep its order, or a later move of the new block is never saved.
  it("keeps a newer event's order over an older save reply", async () => {
    const ids = () => Array.from(editor().children, (n) => n.getAttribute("data-block-id")!);
    const applyOperation = vi.mocked((globalThis as unknown as { gadget: GadgetStub }).gadget.applyOperation);
    let reply!: () => void;
    applyOperation.mockImplementationOnce((op) => new Promise((resolve) => {
      const upserts = (op.upserts ?? []).map((b) => ({ id: b.id, html: b.html, version: b.baseVersion + 1 }));
      reply = () => resolve({ status: "applied", revision: 30, conflicts: [], upserts, order: op.order });
    }));
    editor().firstElementChild!.append(" edited");
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(reply).toBeDefined());
    subscriber.operation({ type: "operation", senderId: "someone", revision: 31, title: "Doc", lastModified: 0, upserts: [{ id: "o1", html: "<p>new</p>", version: 1 }], deletedIds: [], order: [...ids(), "o1"] });
    reply();
    await vi.waitFor(() => expect(applyOperation.mock.results.at(-1)?.type).toBe("return"));
    await Promise.resolve();
    const moved = editor().querySelector('[data-block-id="o1"]')!;
    editor().prepend(moved);
    applyOperation.mockClear();
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(applyOperation).toHaveBeenCalled());
    expect(applyOperation.mock.calls[0]![0].order?.[0]).toBe("o1");
  });
});

describe("more edits", () => {
  // The table flashes the cells a paste filled.
  beforeAll(() => {
    Element.prototype.animate ??= () => ({ finished: Promise.resolve(), cancel() {} }) as unknown as Animation;
    Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  });
  let revision = 40;
  const ids = () => Array.from(editor().children, (n) => n.getAttribute("data-block-id")!);
  const send = (upserts: { id: string; html: string; version: number }[], deletedIds: string[] = []) =>
    subscriber.operation({ type: "operation", senderId: "someone", revision: ++revision, title: "Doc", lastModified: 0, upserts, deletedIds, order: [...ids().filter((id) => !deletedIds.includes(id)), ...upserts.map((b) => b.id).filter((id) => !ids().includes(id))] });
  const caretIn = (node: Node, offset: number) => {
    if (editor().tabIndex < 0) editor().tabIndex = 0;
    editor().focus();
    const range = document.createRange();
    range.setStart(node, offset);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  };
  const applyOperation = () => vi.mocked((globalThis as unknown as { gadget: GadgetStub }).gadget.applyOperation);

  // Pasting a Markdown table into a cell fills the cells from there.
  it("pastes a Markdown table into a table's cells", () => {
    send([{ id: "g1", html: "<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>", version: 1 }]);
    const block = editor().querySelector('[data-block-id="g1"]')!;
    caretIn(block.querySelector("td")!.firstChild!, 0);
    const text = "| A | B |\n| --- | --- |\n| X | Y |";
    const event = Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
      clipboardData: { items: [], files: [], getData: (type: string) => (type === "text/plain" ? text : "") },
    });
    editor().dispatchEvent(event);
    const table = editor().querySelector('[data-block-id="g1"]')!;
    expect(Array.from(table.querySelectorAll("tr"), (tr) => Array.from(tr.cells, (c) => c.textContent))).toEqual([["A", "B"], ["X", "Y"]]);
  });

  // A grid dropped on a table cell fills the cells from there, as pasting it does.
  it("fills a table's cells with a grid dropped on one", () => {
    send([{ id: "g2", html: "<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table>", version: 1 }]);
    const at = document.createRange();
    at.setStart(editor().querySelector('[data-block-id="g2"] td')!.firstChild!, 0);
    Object.assign(document, { caretRangeFromPoint: () => at });
    const event = Object.assign(new Event("drop", { bubbles: true, cancelable: true }), {
      clientX: 0, clientY: 0,
      dataTransfer: { items: [], files: [], getData: (type: string) => (type === "text/plain" ? "X\tY\nZ\tW" : "") },
    });
    try { editor().dispatchEvent(event); } finally { delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint; }
    const table = editor().querySelector('[data-block-id="g2"]')!;
    expect(table.querySelectorAll("table table")).toHaveLength(0);
    expect(Array.from(table.querySelectorAll("tr"), (tr) => Array.from(tr.cells, (c) => c.textContent))).toEqual([["X", "Y"], ["Z", "W"]]);
  });

  // A block deleted remotely while it was typed in, then re-created by this page's save: the next
  // remote change merges against that save, not the text from before the deletion.
  it("merges against a re-created block's save, not the deleted version", async () => {
    send([{ id: "d1", html: "<p>foo</p>", version: 1 }]);
    const block = editor().querySelector('[data-block-id="d1"]')!;
    caretIn(block.firstChild!, 3);
    send([], ["d1"]);
    expect(editor().querySelector('[data-block-id="d1"]')).toBe(block);
    (block.firstChild as Text).appendData(" A");
    applyOperation().mockImplementationOnce(async (op) => ({
      status: "applied", revision: ++revision, conflicts: [], order: op.order,
      upserts: (op.upserts ?? []).map((b) => ({ id: b.id, html: b.html, version: b.baseVersion + 1 })),
    }));
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(applyOperation()).toHaveBeenCalled());
    await vi.waitFor(() => expect(applyOperation().mock.results.at(-1)?.type).toBe("return"));
    await Promise.resolve();
    getSelection()!.removeAllRanges();
    editor().blur();
    send([{ id: "d1", html: "<p>bar A</p>", version: 2 }]);
    await vi.waitFor(() => expect(editor().querySelector('[data-block-id="d1"]')?.textContent).toBe("bar A"));
  });

  // Another editor re-creates a block (at version 1) while this page's deletion of it is in
  // flight: once the deletion's reply comes, the re-created block shows.
  it("shows a block re-created while this page's deletion of it was saving", async () => {
    send([{ id: "r1", html: "<p>one</p>", version: 1 }, { id: "r2", html: "<p>keep</p>", version: 1 }]);
    send([{ id: "r1", html: "<p>one more</p>", version: 3 }]);
    let reply!: () => void;
    applyOperation().mockImplementationOnce((op) => new Promise((resolve) => {
      reply = () => resolve({ status: "applied", revision: ++revision, conflicts: [], order: op.order, deletedIds: (op.deletes ?? []).map((d) => d.id) });
    }));
    editor().querySelector('[data-block-id="r1"]')!.remove();
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(reply).toBeDefined());
    send([{ id: "r1", html: "<p>again</p>", version: 1 }]);
    reply();
    await vi.waitFor(() => expect(applyOperation().mock.results.at(-1)?.type).toBe("return"));
    await vi.waitFor(() => expect(editor().querySelector('[data-block-id="r1"]')?.textContent).toBe("again"));
  });

  // A deletion that arrives while a save is in flight is newer than that save's conflict reply:
  // the stale version the reply carries must not bring the block back.
  it("keeps a block deleted after the version a conflict reply brings", async () => {
    send([{ id: "k1", html: "<p>foo</p>", version: 1 }]);
    editor().querySelector('[data-block-id="k1"]')!.textContent = "foo x";
    let reply!: () => void;
    applyOperation().mockImplementationOnce((op) => new Promise((resolve) => {
      reply = () => resolve({ status: "applied", revision: ++revision, conflicts: [{ id: "k1", html: "<p>bar foo</p>", version: 2 }], order: op.order });
    }));
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(reply).toBeDefined());
    editor().querySelector('[data-block-id="k1"]')!.remove();
    send([], ["k1"]);
    reply();
    await vi.waitFor(() => expect(applyOperation().mock.results.at(-1)?.type).toBe("return"));
    await new Promise((r) => setTimeout(r, 20));
    expect(editor().querySelector('[data-block-id="k1"]')).toBeNull();
  });
});
