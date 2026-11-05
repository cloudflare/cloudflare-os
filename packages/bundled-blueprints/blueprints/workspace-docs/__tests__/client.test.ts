// The editor's handling of HTML it did not write: blocks from the server (a collaborator's or an
// agent's) reach the DOM only through the editor's scrubbing. client.ts is a gadget entry with
// top-level effects, so it is loaded once against a fake `gadget` stub and driven through it.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ApplyOperationResult, BlockUpsert, DocSettings, DocumentEvent, GadgetStub, Operation, StoredBlock, SubscribeSnapshot, SubscriberCallbacks } from "../files/lib/protocol.ts";

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

  it("takes inline code off the selected words only, undoably", () => {
    const block = show("c1", "<p><code>one two three</code></p>");
    select(block.querySelector("code")!.firstChild!, 4, 7);
    press({ key: "e" });
    expect(block.innerHTML).toBe("<code>one </code>two<code> three</code>");
    expect(getSelection()!.toString()).toBe("two");
    press({ key: "z" });
    expect(block.innerHTML).toBe("<code>one two three</code>");
    press({ key: "z", shiftKey: true });
    expect(block.innerHTML).toBe("<code>one </code>two<code> three</code>");
  });

  // Next to other code too: the browser's undo of an insertHTML the editor rewrote left the words twice.
  it("makes the selected words inline code, undoably", () => {
    const block = show("c2", "<p>x <code>one</code> two</p>");
    select(block.lastChild!, 1, 4);
    press({ key: "e" });
    expect(block.innerHTML).toBe("x <code>one</code> <code>two</code>");
    expect(getSelection()!.toString()).toBe("two");
    press({ key: "z" });
    expect(block.innerHTML).toBe("x <code>one</code> two");
    press({ key: "z", shiftKey: true });
    expect(block.innerHTML).toBe("x <code>one</code> <code>two</code>");
  });

  // A cell or list item holds the code, never the table or list: a selection across two is left alone.
  // So is one across a soft line break, whose lines the code would join, or a picture, which it would drop.
  it("makes no inline code of a selection across cells, list items, lines or pictures", () => {
    for (const [id, html] of [
      ["c3", "<table><tbody><tr><td>one</td><td>two</td></tr></tbody></table>"], ["c4", "<ul><li>one</li><li>two</li></ul>"], ["c5", "<p>one<br>two</p>"],
      ["c6", '<p>one<img class="doc-image" src="data:image/png;base64,AA" alt="shot">two</p>'],
    ]) {
      const block = show(id!, html!);
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const first = walker.nextNode()!;
      let last = first;
      while (walker.nextNode()) last = walker.currentNode;
      select(first, 1);
      getSelection()!.getRangeAt(0).setEnd(last, 2);
      const before = block.innerHTML;
      press({ key: "e" });
      expect(block.innerHTML).toBe(before);
    }
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

  // The server applied the save but its reply was lost with the connection, and an agent edited
  // the block: after the failure, or while the save was in flight (its event then held for the
  // reply). On reconnect the snapshot names the save as this page's last: the saved words are not
  // merged in a second time.
  it.each([[false, 23], [true, 26]])("takes a save whose reply was lost as applied, once the reconnect's snapshot says so (agent's edit seen first: %s)", async (heldFirst, rev) => {
    const { gadget } = globalThis as unknown as { gadget: GadgetStub };
    const id = `lr${rev}`, ids = () => Array.from(editor().children, (n) => n.getAttribute("data-block-id")!);
    const agentEdit = { id, html: "<p>bar A</p>", version: 3 };
    subscriber.operation({ type: "operation", senderId: "someone", revision: rev, title: "Doc", lastModified: 0, upserts: [{ id, html: "<p>foo</p>", version: 1 }], deletedIds: [], order: [...ids(), id] });
    const block = editor().querySelector(`[data-block-id="${id}"]`)!;
    let seq: number | undefined;
    vi.mocked(gadget.applyOperation).mockImplementationOnce(async (operation) => {
      seq = operation.seq;
      if (heldFirst) subscriber.operation({ type: "operation", senderId: "agent", revision: rev + 1, title: "Doc", lastModified: 0, upserts: [agentEdit], deletedIds: [], order: ids() });
      (subscriber as SubscriberCallbacks & Disposable)[Symbol.dispose]();
      throw new Error("connection lost");
    });
    vi.mocked(gadget.subscribe).mockImplementationOnce(async (callbacks) => {
      subscriber = callbacks;
      // The other blocks as the page has them; the saved one as the agent left it.
      const blocks = ids().map((b) => b === id ? agentEdit : { id: b, html: editor().querySelector(`[data-block-id="${b}"]`)!.outerHTML, version: 50 });
      return { revision: rev + 2, title: "Doc", lastModified: 0, settings: { font: "sans", wide: false }, lastSave: { seq: seq!, versions: [[id, 2]] }, blocks };
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      block.textContent = "foo A";
      window.dispatchEvent(new Event("pagehide"));
      await vi.waitFor(() => expect(vi.mocked(gadget.subscribe).mock.results.at(-1)?.type).toBe("return"));
      await vi.waitFor(() => expect(editor().querySelector(`[data-block-id="${id}"]`)?.textContent).toBe("bar A"));
    } finally { error.mockRestore(); }
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

  it("sizes and inserts a table from the keyboard", () => {
    send([{ id: "k9", html: "<p>Here</p>", version: 1 }]);
    caretIn(editor().querySelector('[data-block-id="k9"]')!.firstChild!, 4);
    const before = editor().querySelectorAll("table").length;
    document.querySelector<HTMLButtonElement>('button[aria-label="Table"]')!.click();
    const grid = document.activeElement as HTMLElement;
    expect(grid.getAttribute("aria-label")).toMatch(/table size/i);
    for (const key of ["ArrowRight", "ArrowDown", "ArrowDown", "Enter"]) grid.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    const tables = editor().querySelectorAll("table");
    expect(tables).toHaveLength(before + 1);
    // Inserted after the paragraph, the last block.
    const table = tables[tables.length - 1]!;
    expect([table.rows.length, table.rows[0]!.cells.length]).toEqual([5, 4]);
  });

  // A collaborator's change replaced the paragraph while the link card was open: the address is
  // not inserted where the selection collapsed to.
  it("links nothing when the selected text was replaced while the link card was open", () => {
    send([{ id: "lk", html: "<p>First two old</p>", version: 1 }]);
    const text = editor().querySelector('[data-block-id="lk"]')!.firstChild!;
    caretIn(text, 6);
    getSelection()!.getRangeAt(0).setEnd(text, 9);
    document.querySelector<HTMLButtonElement>('button[aria-label="Link"]')!.click();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!;
    send([{ id: "lk", html: "<p>First two NEW</p>", version: 2 }]);
    input.value = "https://example.com/";
    const execCommand = vi.fn(() => true);
    Object.assign(document, { execCommand });
    try { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); } finally { delete (document as { execCommand?: unknown }).execCommand; }
    expect(execCommand).not.toHaveBeenCalled();
    expect(editor().querySelector('[data-block-id="lk"]')!.innerHTML).toBe("First two NEW");
  });

  // A change that fails to save drops out of what the page shows, whatever else is pending:
  // otherwise this page alone would show it, until its next reconnect. Of the saved settings,
  // the newest wins, whether a reply or a collaborator's broadcast arrives first.
  it("shows the newest saved settings with only the pending changes on top", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // The mock gadget beforeAll installed.
    const { gadget } = globalThis as unknown as { gadget: GadgetStub };
    const replies: PromiseWithResolvers<DocSettings>[] = [];
    Object.assign(gadget, { setSettings: vi.fn(() => { const reply = Promise.withResolvers<DocSettings>(); replies.push(reply); return reply.promise; }) });
    const menu = document.querySelector<HTMLButtonElement>('button[aria-label="Typeface & width"]')!;
    const page = document.querySelector<HTMLElement>(".page")!;
    const pick = (label: string) => document.querySelector<HTMLElement>(`[role="menuitemradio"][aria-label="${label}"]`)!.click();
    const shown = () => [page.dataset.font, page.classList.contains("wide")];
    try {
      menu.click();
      pick("Serif");
      pick("Mono");
      expect(shown()).toEqual(["mono", false]);
      replies[0]!.reject(new Error("offline"));
      replies[1]!.reject(new Error("offline"));
      await vi.waitFor(() => expect(shown()).toEqual(["sans", false]));
      // A failed typeface, then a width change that saves.
      pick("Serif");
      document.querySelector<HTMLElement>('[role="menuitemcheckbox"]')!.click();
      expect(shown()).toEqual(["serif", true]);
      replies[2]!.reject(new Error("offline"));
      replies[3]!.resolve({ font: "sans", wide: true });
      await vi.waitFor(() => expect(shown()).toEqual(["sans", true]));
      // A collaborator's newer change arrives before the reply to this page's older one.
      pick("Serif");
      subscriber.operation({ type: "settings", senderId: "someone", settings: { font: "mono", wide: true, revision: 11 } });
      replies[4]!.resolve({ font: "serif", wide: true, revision: 10 });
      await new Promise((resolve) => setTimeout(resolve));
      expect(shown()).toEqual(["mono", true]);
    } finally {
      menu.click();
      error.mockRestore();
      // Back to the settings the other tests start from.
      subscriber.operation({ type: "settings", senderId: "someone", settings: { font: "sans", wide: false, revision: 12 } });
    }
  });

  // A code block's lines are <br>s; copied as plain text, they stay lines.
  it("copies a code block's lines as plain text", () => {
    send([{ id: "cb", html: "<pre>const a = 1;<br>const b = 2;</pre>", version: 1 }]);
    caretIn(editor().querySelector('[data-block-id="cb"]')!.firstChild!, 0);
    editor().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const data = new Map<string, string>();
    const copy = Object.assign(new Event("copy", { bubbles: true, cancelable: true }), { clipboardData: { setData: (type: string, value: string) => data.set(type, value) } });
    (document.activeElement ?? document).dispatchEvent(copy);
    expect(data.get("text/plain")).toBe("```\nconst a = 1;\nconst b = 2;\n```");
  });

  it("copies a table as a Markdown table, escaping pipes and the backslashes before them", () => {
    send([{ id: "tp", html: String.raw`<table><tbody><tr><td>a|b</td><td>c\|d</td><td>e\\|f</td><td>C:\dir\</td></tr></tbody></table>`, version: 1 }]);
    caretIn(editor().querySelector('[data-block-id="tp"] td')!.firstChild!, 0);
    editor().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const data = new Map<string, string>();
    const copy = Object.assign(new Event("copy", { bubbles: true, cancelable: true }), { clipboardData: { setData: (type: string, value: string) => data.set(type, value) } });
    (document.activeElement ?? document).dispatchEvent(copy);
    expect(data.get("text/plain")!.split("\n")[0]).toBe(String.raw`| a\|b | c\\\|d | e\\\\\|f | C:\dir\ |`);
  });

  // Only the selected text goes: the start of the first cell and the end of the last stay.
  it("deletes a selection across cells without the text around it", () => {
    send([{ id: "x2", html: "<table><tbody><tr><td>First cell</td><td>Middle</td><td>Second cell</td></tr></tbody></table>", version: 1 }]);
    const cells = editor().querySelectorAll('[data-block-id="x2"] td');
    caretIn(cells[0]!.firstChild!, 6);
    getSelection()!.getRangeAt(0).setEnd(cells[2]!.firstChild!, 6);
    editor().dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    expect(Array.from(editor().querySelectorAll('[data-block-id="x2"] td'), (c) => c.innerHTML)).toEqual(["First ", "<br>", " cell"]);
  });

  // Text dropped in a code block is code, not Markdown: "# comment" stays a comment.
  it("drops text into a code block as it is", () => {
    send([{ id: "c7", html: "<pre>x = 1</pre>", version: 1 }]);
    const at = document.createRange();
    at.setStart(editor().querySelector('[data-block-id="c7"]')!.firstChild!, 5);
    const execCommand = vi.fn(() => true);
    Object.assign(document, { caretRangeFromPoint: () => at, execCommand });
    const event = Object.assign(new Event("drop", { bubbles: true, cancelable: true }), {
      clientX: 0, clientY: 0,
      dataTransfer: { items: [], files: [], getData: (type: string) => (type === "text/plain" ? "\n# comment\nprint(1)" : "") },
    });
    try { editor().dispatchEvent(event); } finally { delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint; delete (document as { execCommand?: unknown }).execCommand; }
    expect(execCommand).toHaveBeenCalledWith("insertHTML", false, "\n# comment\nprint(1)");
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

  // Another editor re-creates a block while this page's deletion of it is in flight: once the
  // deletion's reply comes, the re-created block shows.
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

describe("sync through deletions and moves", () => {
  let revision = 100;
  const ids = () => Array.from(editor().children, (n) => n.getAttribute("data-block-id")!);
  const block = (id: string) => editor().querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
  const send = (upserts: StoredBlock[], order = [...ids(), ...upserts.map((b) => b.id).filter((id) => !ids().includes(id))]) =>
    subscriber.operation({ type: "operation", senderId: "someone", revision: ++revision, title: "Doc", lastModified: 0, upserts, deletedIds: [], order });
  // The server: what `scene` answers, and everything else applied as sent.
  const serve = (scene: (op: Operation) => Promise<ApplyOperationResult | undefined>) =>
    vi.mocked((globalThis as unknown as { gadget: GadgetStub }).gadget.applyOperation).mockImplementation(async (op) => (await scene(op)) ?? {
      status: "applied", revision: ++revision, conflicts: [], order: op.order,
      upserts: (op.upserts ?? []).map((b) => ({ id: b.id, html: b.html, version: b.baseVersion + 1 })),
      deletedIds: (op.deletes ?? []).map((d) => d.id),
    });

  // Someone deletes a block while this page's edit of it is saving, and another page re-creates it
  // with its own edit before this page's re-creation lands: the two edits are merged.
  it("merges a block deleted under its save with a concurrent re-creation", async () => {
    getSelection()!.removeAllRanges();
    editor().blur();
    send([{ id: "m1", html: "<p>alpha beta</p>", version: 1 }]);
    const tries: BlockUpsert[] = [];
    serve(async (op) => {
      const mine = op.upserts?.find((b) => b.id === "m1");
      if (!mine) return;
      tries.push(mine);
      if (tries.length === 1) return { status: "conflict", revision, conflicts: [{ id: "m1", html: null, version: 0, missing: true }] };
      if (tries.length === 2) return { status: "conflict", revision: ++revision, conflicts: [{ id: "m1", html: "<p>Their alpha beta</p>", version: revision }] };
    });
    block("m1").textContent = "alpha beta mine";
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(tries).toHaveLength(3));
    expect(tries[1]!.baseVersion).toBe(0);
    expect(tries[2]!.html).toContain("Their alpha beta mine");
    expect(block("m1").textContent).toBe("Their alpha beta mine");
  });

  // A collaborator's edit the server took just before this page's move arrives while the move is
  // saving, with the order from before the move: the move stays, here and in what is saved next.
  it("keeps a move when an older event arrives during its save", async () => {
    send(["o1", "o2", "o3"].map((id) => ({ id, html: `<p>${id}</p>`, version: 1 })));
    const before = ids();
    const reply = Promise.withResolvers<void>();
    let moved: string[] | undefined;
    const later: string[][] = [];
    serve(async (op) => {
      const order = op.order ?? [];
      if (moved) { later.push(order); return; }
      if (order.indexOf("o3") > order.indexOf("o1")) return;
      moved = order;
      await reply.promise;
      return { status: "applied", revision: ++revision, conflicts: [], upserts: [], deletedIds: [], order };
    });
    block("o1").before(block("o3"));
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(moved).toBeDefined());
    send([{ id: "o1", html: "<p>o1 typed</p>", version: 2 }], before);
    reply.resolve();
    await new Promise((r) => setTimeout(r, 20));
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((r) => setTimeout(r, 20));
    expect(block("o1").textContent).toBe("o1 typed");
    expect(ids().indexOf("o3")).toBeLessThan(ids().indexOf("o1"));
    for (const order of later) expect(order.indexOf("o3")).toBeLessThan(order.indexOf("o1"));
  });

  // A collaborator's edit arrives before this page's move is saved (during the save debounce),
  // with the order from before the move: the move stays, and is what is saved next.
  it("keeps a move not yet saved when an event arrives with the older order", async () => {
    send(["u1", "u2", "u3"].map((id) => ({ id, html: `<p>${id}</p>`, version: 1 })));
    const before = ids();
    const saved: string[][] = [];
    serve(async (op) => { saved.push(op.order ?? []); return undefined; });
    block("u1").before(block("u3"));
    send([{ id: "u1", html: "<p>u1 typed</p>", version: 2 }], before);
    expect(block("u1").textContent).toBe("u1 typed");
    expect(ids().indexOf("u3")).toBeLessThan(ids().indexOf("u1"));
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.indexOf("u3")).toBeLessThan(saved[0]!.indexOf("u1"));
  });

  // A collaborator inserts a block while this page's move is saving, and the page moves again
  // before the reply: the new block stays where the collaborator put it in what is saved next.
  it("keeps a block inserted during a move's save in place through a second move", async () => {
    send(["q1", "q2", "q3", "q4"].map((id) => ({ id, html: `<p>${id}</p>`, version: 1 })));
    const withNew = (order: string[]) => order.flatMap((id) => (id === "q1" ? ["q1", "qn"] : [id]));
    const before = ids();
    const reply = Promise.withResolvers<void>();
    let moved: string[] | undefined;
    const later: string[][] = [];
    serve(async (op) => {
      const order = op.order ?? [];
      if (moved) { later.push(order); return; }
      moved = order;
      await reply.promise;
      return { status: "applied", revision: ++revision, conflicts: [], upserts: [], deletedIds: [], order: withNew(order) };
    });
    block("q3").before(block("q4"));
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(moved).toBeDefined());
    send([{ id: "qn", html: "<p>new</p>", version: 1 }], withNew(before));
    block("q1").before(block("q2"));
    reply.resolve();
    await vi.waitFor(() => expect(later).toHaveLength(1));
    const saved = later[0]!;
    expect(saved.indexOf("qn")).toBe(saved.indexOf("q1") + 1);
    expect(saved.indexOf("q2")).toBeLessThan(saved.indexOf("q1"));
    expect(saved.indexOf("q4")).toBeLessThan(saved.indexOf("q3"));
  });
});

describe("editor keys, menus and undo", () => {
  beforeAll(() => {
    Element.prototype.animate ??= () => ({ finished: Promise.resolve(), cancel() {} }) as unknown as Animation;
    Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  });
  let revision = 200;
  const ids = () => Array.from(editor().children, (n) => n.getAttribute("data-block-id")!);
  const show = (id: string, html: string) => {
    subscriber.operation({ type: "operation", senderId: "someone", revision: ++revision, title: "Doc", lastModified: 0, upserts: [{ id, html, version: 1 }], deletedIds: [], order: [...ids().filter((x) => x !== id), id] });
    return editor().querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
  };
  const caretIn = (node: Node, start: number, endNode = node, end = start) => {
    if (editor().tabIndex < 0) editor().tabIndex = 0;
    editor().focus();
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(endNode, end);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  };
  const key = (init: KeyboardEventInit, target: EventTarget = editor()) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  const undo = () => key({ key: "z", ctrlKey: true, metaKey: true });
  const redo = () => key({ key: "z", ctrlKey: true, metaKey: true, shiftKey: true });
  // The document as saved: without the placeholder hint on the empty line.
  const doc = () => editor().innerHTML.replace(/ data-ph="[^"]*"/g, "");
  // Runs `fn` with the browser's editing commands stubbed out; returns the stub.
  const withExec = (fn: () => void) => {
    const execCommand = vi.fn(() => true);
    Object.assign(document, { execCommand });
    try { fn(); } finally { delete (document as { execCommand?: unknown }).execCommand; }
    return execCommand;
  };
  // A row of the open menu (a closing one may still be fading out).
  const menuRow = (label: string) => Array.from(document.querySelectorAll<HTMLElement>(".pop:not(.closing) .mi")).find((r) => r.textContent!.startsWith(label))!;

  // Ctrl+Alt is AltGr off a Mac: AltGr+0 that types "@" is typing, not "Paragraph". Ctrl+Alt+2 is
  // the shortcut, also where the key types "é" unshifted (French).
  it("types AltGr characters on the digit keys, and keeps Ctrl+Alt+digit as the heading shortcut", () => {
    const block = show("ag", "<p>Mail</p>");
    caretIn(block.firstChild!, 4);
    let typed = false;
    expect(withExec(() => { typed = key({ key: "@", code: "Digit0", ctrlKey: true, altKey: true, modifierAltGraph: true }); })).not.toHaveBeenCalled();
    expect(typed).toBe(true);
    expect(withExec(() => key({ key: "2", code: "Digit2", ctrlKey: true, altKey: true }))).toHaveBeenCalledWith("formatBlock", false, "<h2>");
    expect(withExec(() => key({ key: "é", code: "Digit2", ctrlKey: true, altKey: true }))).toHaveBeenCalledWith("formatBlock", false, "<h2>");
  });

  it("undoes and redoes deleting a selected image", () => {
    const block = show("im", '<p>a<img class="doc-image" src="data:image/png;base64,AA" alt="x">b</p>');
    caretIn(block.firstChild!, 1);
    const before = doc();
    block.querySelector("img")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    key({ key: "Backspace" });
    const after = doc();
    expect(editor().querySelector('[data-block-id="im"] img')).toBeNull();
    undo();
    expect(doc()).toBe(before);
    redo();
    expect(doc()).toBe(after);
  });

  // The move's undo step holds the image's block too: undoing past the deletion must not delete it again.
  it("undoes a move after undoing an image deletion made after it", () => {
    show("mv", "<p>Top</p>");
    const block = show("mi", '<p>a<img class="doc-image" src="data:image/png;base64,AA" alt="x">b</p>');
    caretIn(block.firstChild!, 1);
    const before = doc();
    key({ key: "ArrowUp", altKey: true, shiftKey: true });
    const moved = doc();
    expect(moved).not.toBe(before);
    block.querySelector("img")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    key({ key: "Backspace" });
    undo();
    expect(doc()).toBe(moved);
    undo();
    expect(doc()).toBe(before);
  });

  it("undoes and redoes changing a link's address", () => {
    const block = show("la", '<p>See <a href="https://old.example/">the site</a> now</p>');
    caretIn(block.querySelector("a")!.firstChild!, 2);
    const before = doc();
    document.querySelector<HTMLButtonElement>('button[aria-label="Link"]')!.click();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!;
    input.value = "https://new.example/";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const after = doc();
    expect(block.querySelector("a")!.getAttribute("href")).toBe("https://new.example/");
    undo();
    expect(doc()).toBe(before);
    redo();
    expect(doc()).toBe(after);
  });

  it("undoes and redoes inserting a divider", () => {
    const block = show("dv", "<p>Above</p>");
    caretIn(block.firstChild!, 5);
    const before = doc();
    document.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click();
    menuRow("Divider").click();
    const after = doc();
    expect(block.nextElementSibling?.tagName).toBe("HR");
    undo();
    expect(doc()).toBe(before);
    redo();
    expect(doc()).toBe(after);
  });

  it("undoes and redoes making a to-do list", () => {
    const block = show("td", "<p>One</p>");
    caretIn(block.firstChild!, 3);
    const before = doc();
    key({ key: "(", code: "Digit9", ctrlKey: true, metaKey: true, shiftKey: true });
    const after = doc();
    expect(editor().querySelector('[data-block-id="td"]')!.matches("ul.checklist")).toBe(true);
    undo();
    expect(doc()).toBe(before);
    redo();
    expect(doc()).toBe(after);
  });

  it("undoes and redoes taking an item out of its list", () => {
    show("lp", "<p>Before</p>");
    const list = show("ll", "<ul><li>One</li><li>Two</li><li>Three</li></ul>");
    caretIn(list.children[1]!.firstChild!, 0);
    const before = doc();
    key({ key: "Backspace" });
    const after = doc();
    expect(Array.from(editor().children).slice(-3).map((n) => n.tagName)).toEqual(["UL", "P", "UL"]);
    undo();
    expect(doc()).toBe(before);
    redo();
    expect(doc()).toBe(after);
  });

  // Indenting wraps the line in a quote: in a table that would put a quote in the cells.
  it("doesn't indent inside a table", () => {
    const table = show("ti", "<table><tbody><tr><td>A1</td><td>B1</td></tr></tbody></table>");
    const cells = table.querySelectorAll("td");
    const execCommand = withExec(() => {
      caretIn(cells[0]!.firstChild!, 1, cells[1]!.firstChild!, 1);
      key({ key: "Tab" });
      caretIn(cells[0]!.firstChild!, 1);
      document.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click();
      menuRow("Indent").click();
    });
    expect(execCommand).not.toHaveBeenCalledWith("indent", false, null);
    expect(editor().querySelector('[data-block-id="ti"] blockquote')).toBeNull();
  });

  const paste = (html: string, files: File[]) => editor().dispatchEvent(Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
    clipboardData: { items: [], files, getData: (type: string) => (type === "text/html" ? html : "") },
  }));
  const png = () => new File([new Uint8Array([137, 80, 78, 71])], "cells.png", { type: "image/png" });

  // Excel and Word put a picture of the copied cells beside their HTML: the cells are pasted.
  it("pastes copied cells, not the picture of them beside", () => {
    caretIn(show("px", "<p>Here</p>").firstChild!, 4);
    expect(withExec(() => paste("<table><tr><td>1</td><td>2</td></tr></table>", [png()])))
      .toHaveBeenCalledWith("insertHTML", false, expect.stringContaining("<table>"));
  });

  // A copied web image comes as its file beside HTML of just the <img>: the file is pasted.
  it("pastes a copied image's file over HTML holding only the image", () => {
    caretIn(show("pi", "<p>Here</p>").firstChild!, 4);
    expect(withExec(() => paste('<meta charset="utf-8"><img src="https://example.com/cat.png">', [png()])))
      .not.toHaveBeenCalledWith("insertHTML", false, expect.anything());
    expect(document.querySelector(".status")!.textContent).toContain("Adding image");
  });

  // The document's own Markdown, pasted back as text, keeps its pictures: through the same
  // rebuild as a pasted <img>, never as their data URL in the text.
  it("pastes an embedded image in Markdown text as the image", () => {
    caretIn(show("mdi", "<p>Here</p>").firstChild!, 4);
    const src = "data:image/png;base64,iVBORw0KGgo=";
    const execCommand = withExec(() => editor().dispatchEvent(Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
      clipboardData: { items: [], files: [], getData: (type: string) => (type === "text/plain" ? `# Notes\n\n![Shot](${src})` : "") },
    })));
    expect(execCommand).toHaveBeenCalledWith("insertHTML", false, `<h1>Notes</h1><p><img class="doc-image" draggable="true" src="${src}" alt="Shot" style="height: auto;"></p>`);
  });

  it("picks a colour from the keyboard", () => {
    caretIn(show("co", "<p>Paint</p>").firstChild!, 0, undefined, 5);
    const owner = document.querySelector<HTMLButtonElement>(".tb.color")!;
    owner.focus();
    owner.click();
    key({ key: "ArrowDown" }, owner);
    key({ key: "ArrowRight" }, document.activeElement!);
    const swatch = document.activeElement!;
    expect(swatch.getAttribute("aria-label")).toMatch(/^Text /);
    expect(swatch.previousElementSibling?.getAttribute("role")).toBe("menuitemradio");
    expect(withExec(() => key({ key: "Enter" }, swatch))).toHaveBeenCalledWith("foreColor", false, expect.anything());
  });

  it("turns full width on from the keyboard, keeping the focus on the switch", () => {
    Object.assign((globalThis as unknown as { gadget: GadgetStub }).gadget, { setSettings: vi.fn(async () => ({})) });
    const owner = document.querySelector<HTMLButtonElement>(".tb.aa")!;
    owner.focus();
    owner.click();
    key({ key: "ArrowDown" }, owner);
    key({ key: "End" }, document.activeElement!);
    const toggle = document.activeElement!;
    expect([toggle.getAttribute("role"), toggle.getAttribute("aria-checked")]).toEqual(["menuitemcheckbox", "false"]);
    key({ key: "Enter" }, toggle);
    expect(document.querySelector(".page")!.classList.contains("wide")).toBe(true);
    expect([document.activeElement!.getAttribute("role"), document.activeElement!.getAttribute("aria-checked")]).toEqual(["menuitemcheckbox", "true"]);
    key({ key: "Enter" }, document.activeElement!);
    key({ key: "Escape" }, document.activeElement!);
  });

  // A release outside the frame never reaches it: a margin sweep can't stay live and select on.
  it("ends a margin sweep released outside the frame", () => {
    const canvas = document.querySelector<HTMLElement>("main.canvas")!;
    const press = () => canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: -1, clientY: 0 }));
    const move = (buttons: number) => window.dispatchEvent(new MouseEvent("mousemove", { clientX: -1, clientY: 40, buttons }));
    press();
    window.dispatchEvent(new Event("blur"));
    move(1);
    expect(document.body.classList.contains("blk-sweeping")).toBe(false);
    press();
    move(0);
    move(1);
    expect(document.body.classList.contains("blk-sweeping")).toBe(false);
  });
});
