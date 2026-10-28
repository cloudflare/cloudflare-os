// The hierarchy picker in Chromium, on preact/compat: real pointer and keyboard input and focus.
// Covers what the user's choices select, that a choice lasts only while it is in view,
// pre-fill, paging, search, tabs, and what it does with a misbehaving source.

import { FileIcon, FolderIcon } from "@phosphor-icons/react";
import { act } from "preact/test-utils";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type {
  ConfiguratorUIHierarchyItem,
  ConfiguratorUIHierarchyPage,
  ConfiguratorUIHierarchyRequest,
  HierarchyPickerProps,
} from "../index.ts";
import { HierarchyPicker } from "./HierarchyPicker.tsx";
import { reportFrontendIssue } from "./reporting.ts";
import { createConfiguratorStore } from "./store.ts";
import { StoreContext } from "./storeContext.ts";

vi.mock("./reporting.ts", () => ({ reportFrontendIssue: vi.fn() }));

type Item = ConfiguratorUIHierarchyItem;
type LoadItems = (request: ConfiguratorUIHierarchyRequest) => Promise<ConfiguratorUIHierarchyPage>;

const ROOT = { id: "drive", title: "My Drive", selectable: true };

const reports: Item = { id: "reports", title: "Reports", kind: "container" };
const shared: Item = { id: "shared", title: "Shared with me", kind: "container", selectable: false };
const budget: Item = { id: "budget", title: "Budget.xlsx", kind: "leaf" };
const locked: Item = { id: "locked", title: "Locked.doc", kind: "leaf", selectable: false };
const archive: Item = { id: "archive", title: "Archive", kind: "container" };
const q1: Item = { id: "q1", title: "Q1.pdf", kind: "leaf" };

const TREE: Record<string, Item[]> = {
  drive: [reports, shared, budget, locked],
  reports: [archive, q1],
  archive: [{ id: "old", title: "Old.pdf", kind: "leaf" }],
  shared: [{ id: "theirs", title: "Theirs.pdf", kind: "leaf" }],
};

/** A source answering from {@link TREE}, and from `results` for a search. */
const source = (results: Record<string, Item[]> = {}) => vi.fn<LoadItems>(async ({ parentId, query }) => ({
  items: query ? results[query] ?? [] : TREE[parentId] ?? [],
}));

/** A click on an element Playwright would refuse to click because it is (aria-)disabled. */
const forceClick = (locator: { element(): Element }) => act(() => (locator.element() as HTMLElement).click());

/** Settles once Preact has run the last render's effects, in a task its next animation frame queues. */
const effectsFlushed = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => setTimeout(resolve));
  return promise;
};

type HarnessProps = Omit<HierarchyPickerProps, "value" | "onChange" | "name" | "root"> & {
  initial?: string | null;
  onChange: HierarchyPickerProps["onChange"];
  root?: HierarchyPickerProps["root"];
  /** Whether the module takes a change the picker reports; by default it takes every one. */
  accepts?(next: string | null): boolean;
};

/** Sets the value from outside the picker, as the module's own code would. */
let setFromModule: (value: string | null) => void;

/** The picker as a configurator holds it: its value follows `onChange`. */
const Harness = ({ initial = null, onChange, root = ROOT, accepts = () => true, ...props }: HarnessProps) => {
  const [value, setValue] = useState<string | null>(initial);
  const [store] = useState(() => createConfiguratorStore({}));
  setFromModule = setValue;
  return (
    <StoreContext.Provider value={store}>
      <HierarchyPicker
        {...props}
        name="target"
        root={root}
        value={value}
        onChange={(next, item) => {
          if (accepts(next)) setValue(next);
          onChange(next, item);
        }}
      />
    </StoreContext.Provider>
  );
};

let root: Root | undefined;
let container: HTMLElement | undefined;

const render = async (props: Partial<HarnessProps> & { loadItems: LoadItems }) => {
  const onChange = vi.fn<HierarchyPickerProps["onChange"]>();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(() => root!.render(<Harness onChange={onChange} {...props} />));
  return onChange;
};

const list = () => page.getByRole("listbox");
// Found by title alone: their accessible names add a row's subtitle or path.
const option = (name: string) => page.getByRole("option", { name, exact: false });
const crumb = (name: string) => page.getByRole("navigation", { name: "Location" }).getByRole("button", { name, exact: false });
const crumbs = () => page.getByRole("navigation", { name: "Location" });
const allOf = (title = "My Drive") => page.getByRole("button", { name: `All of ${title}`, exact: false });
const tab = (name: string) => page.getByRole("tab", { name });
const file = (index: number) => page.getByRole("option", { name: `File ${index}`, exact: true });

const FILES = Array.from({ length: 60 }, (_, index): Item => ({ id: `file-${index}`, title: `File ${index}`, kind: "leaf" }));

/** Gives the list's box the fixed height it has in the frame, whose stylesheet the suite runs without. */
const boxHeight = (height: number) => {
  const box = list().element().parentElement!;
  Object.assign(box.style, { height: `${height}px`, overflowX: "hidden", overflowY: "auto" });
  return box;
};

/** Sixty files over two pages. */
const twoPages: LoadItems = async ({ cursor }) =>
  cursor ? { items: FILES.slice(30) } : { items: FILES.slice(0, 30), nextCursor: "page-2" };

/** The first thirty files on one page. */
const thirtyFiles: LoadItems = async () => ({ items: FILES.slice(0, 30) });

/** A keydown on the focused element with what userEvent cannot press: AltGr, or an input method's. */
const keydown = (key: string, init: KeyboardEventInit) => document.activeElement!.dispatchEvent(
  new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe("selection", () => {
  it("takes an open container from its own row, and lets go of it when the user moves away", async () => {
    const onChange = await render({ loadItems: source() });

    await userEvent.click(option("Reports"));
    await expect.element(list()).toHaveAccessibleName("Reports");
    await expect.element(option("Q1.pdf")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.click(option("Everything in Reports"));
    expect(onChange).toHaveBeenLastCalledWith("reports",
      { id: "reports", title: "Reports", kind: "container", selectable: true });
    await expect.element(option("Everything in Reports")).toHaveAttribute("aria-selected", "true");
    await userEvent.click(option("Archive"));
    expect(onChange).toHaveBeenLastCalledWith(null, null);

    // An unselectable container opens without a row of its own; with nothing chosen, nothing is let go.
    await userEvent.click(crumb("My Drive"));
    await userEvent.click(option("Shared with me"));
    await expect.element(option("Theirs.pdf")).toBeVisible();
    expect(option("Everything in").elements()).toHaveLength(0);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("offers an open container under its own choice, or else as everything in it, with its icon", async () => {
    const icons = { space: <svg data-testid="space-icon" /> };
    const choice = { title: "The whole Engineering space", subtitle: "Including pages added later" };
    const engineering: Item = { id: "eng", title: "Engineering", kind: "container", icon: "space", choice };
    const specs: Item = { id: "specs", title: "Specs", kind: "container", path: [{ ...engineering }] };
    const loadItems = vi.fn<LoadItems>(async ({ parentId, query }) =>
      ({ items: query ? [specs] : parentId === "drive" ? [engineering, reports] : [] }));
    await render({ loadItems, icons, searchPlaceholder: "Search Drive" });
    const drawsSpace = () => option(choice.title).element().querySelector("[data-testid='space-icon']");

    await userEvent.click(option("Engineering"));
    await expect.element(option(choice.title)).toMatchTextContent(`${choice.title}${choice.subtitle}`);
    expect(drawsSpace()).not.toBeNull();

    await userEvent.click(crumb("My Drive"));
    await userEvent.click(option("Reports"));
    await expect.element(option("Everything in Reports")).toBeVisible();
    expect(option("Everything in Reports").element().textContent).toBe("Everything in Reports");

    // Reached through a search result's path, the container is offered the same way.
    await userEvent.fill(page.getByRole("searchbox", { name: "Search Drive" }), "specs");
    await userEvent.click(option("Specs"));
    await userEvent.click(crumb("Engineering"));
    await expect.element(option(choice.title)).toMatchTextContent(`${choice.title}${choice.subtitle}`);
    expect(drawsSpace()).not.toBeNull();
  });

  it("takes a leaf from its row, keeps it when chosen again, and ignores one it cannot connect", async () => {
    const onChange = await render({ loadItems: source() });

    await userEvent.click(option("Budget.xlsx"));
    expect(onChange).toHaveBeenLastCalledWith("budget", expect.objectContaining({ id: "budget", kind: "leaf" }));
    await userEvent.click(option("Budget.xlsx"));
    await expect.element(option("Budget.xlsx")).toHaveAttribute("aria-selected", "true");

    await expect.element(option("Locked.doc")).toHaveAttribute("aria-disabled", "true");
    await forceClick(option("Locked.doc"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("says why a node cannot be chosen, in place of a leaf's subtitle and of an open container's own row", async () => {
    const pages: Item = {
      id: "pages", title: "Site Pages", kind: "container", subtitle: "Open to choose a page",
      selectable: false, unselectableReason: "Choose one page, or the whole site.",
    };
    const draft: Item = {
      id: "draft", title: "Draft.docx", kind: "leaf", subtitle: "Owned by Kim",
      selectable: false, unselectableReason: "Only its owner can share it.\u202E",
    };
    await render({ loadItems: async ({ parentId }) => ({ items: parentId === "pages" ? [q1] : [pages, draft] }) });

    await expect.element(option("Draft.docx")).toMatchTextContent("Only its owner can share it.");
    expect(option("Draft.docx").element().textContent).not.toContain("Owned by Kim");
    expect(container!.textContent).not.toContain("\u202E");
    // A container's row opens it, so it says what is inside; why it cannot be chosen waits until then.
    await expect.element(option("Site Pages")).toMatchTextContent("Open to choose a page");

    await userEvent.click(option("Site Pages"));
    await expect.element(page.getByText("Choose one page, or the whole site.", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("status")).toHaveTextContent("1 item. Choose one page, or the whole site.");
    expect(option("Everything in Site Pages").elements()).toHaveLength(0);
  });

  it("shows one selected row when a listing names the open container among its own nodes", async () => {
    const loadItems = vi.fn<LoadItems>(async ({ parentId }) =>
      ({ items: parentId === "reports" ? [{ ...reports, title: "Reports again" }, q1] : TREE[parentId] ?? [] }));
    await render({ loadItems });

    await userEvent.click(option("Reports"));
    await userEvent.click(option("Everything in Reports"));
    await expect.element(option("Everything in Reports")).toHaveAttribute("aria-selected", "true");
    expect(page.getByRole("option", { selected: true }).elements()).toHaveLength(1);
    expect(option("Reports again").elements()).toHaveLength(0);
  });

  it("offers the whole hierarchy above the list, kept wherever the user goes, only when the root can be connected", async () => {
    const loadItems = source();
    const onChange = await render({ loadItems });

    await userEvent.click(option("Reports"));
    await userEvent.click(allOf());
    expect(onChange).toHaveBeenLastCalledWith("drive", { id: "drive", title: "My Drive", kind: "container", selectable: true });
    await userEvent.click(option("Archive"));
    await expect.element(allOf()).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(option("Old.pdf"));
    await expect.element(allOf()).toHaveAttribute("aria-pressed", "false");
    expect(onChange).toHaveBeenCalledTimes(2);

    await act(() => root!.render(
      <Harness onChange={onChange} loadItems={loadItems} root={{ id: "team", title: "Team Drive" }} />));
    await expect.element(list()).toHaveAccessibleName("Team Drive");
    expect(allOf("Team Drive").elements()).toHaveLength(0);
  });

  it("navigates through the breadcrumb without choosing", async () => {
    const loadItems = source();
    const onChange = await render({ loadItems });

    await userEvent.click(option("Reports"));
    await userEvent.click(option("Archive"));
    await expect.element(option("Old.pdf")).toBeVisible();
    await expect.element(crumb("Archive")).toHaveAttribute("aria-current", "location");
    await expect.element(crumb("Reports")).not.toHaveAttribute("aria-current");

    await userEvent.click(crumb("Reports"));
    await expect.element(list()).toHaveAccessibleName("Reports");
    await expect.element(option("Q1.pdf")).toBeVisible();
    expect(crumb("Archive").elements()).toHaveLength(0);
    expect(loadItems).toHaveBeenLastCalledWith({ parentId: "reports", query: "", cursor: null });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("folds the middle of a deep breadcrumb behind a button that shows it, until the user moves", async () => {
    const path = ["Alpha", "Beta", "Gamma", "Delta"].map(title => ({ id: title.toLowerCase(), title }));
    const loadItem = async (): Promise<Item | null> => ({ id: "epsilon", title: "Epsilon", kind: "container", path });
    await render({ loadItems: source(), loadItem, initial: "epsilon" });

    await expect.element(crumbs()).toMatchTextContent(/^My Drive\s*Delta\s*Epsilon$/);
    await userEvent.click(page.getByRole("button", { name: "Show 3 more levels" }));
    await expect.element(crumb("Alpha")).toHaveFocus();
    await expect.element(crumbs()).toMatchTextContent(/^My Drive\s*Alpha\s*Beta\s*Gamma\s*Delta\s*Epsilon$/);

    await userEvent.click(crumb("Delta"));
    await expect.element(crumbs()).toMatchTextContent(/^My Drive\s*Gamma\s*Delta$/);
    await expect.element(page.getByRole("button", { name: "Show 2 more levels" })).toBeVisible();
  });

  it("goes up one level from its back button, which keeps focus up to the top and leads nowhere there", async () => {
    const onChange = await render({ loadItems: source() });
    const up = page.getByRole("button", { name: "Up one level" });
    await expect.element(up).toHaveAttribute("aria-disabled", "true");

    await userEvent.click(option("Reports"));
    await userEvent.click(option("Archive"));
    await userEvent.click(up);
    await expect.element(list()).toHaveAccessibleName("Reports");
    await userEvent.click(up);
    await expect.element(list()).toHaveAccessibleName("My Drive");
    await expect.element(up).toHaveFocus();
    await expect.element(up).toHaveAttribute("aria-disabled", "true");

    await forceClick(up);
    await expect.element(option("Reports")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("counts what the open location lists beside the breadcrumb, apart from its own row", async () => {
    await render({ loadItems: source() });
    const bar = crumbs().element().parentElement!;

    await expect.poll(() => bar.textContent).toBe("My Drive4 items");
    await userEvent.click(option("Reports"));
    await expect.poll(() => bar.textContent).toBe("My DriveReports2 items");
  });

  it("keeps a choice when the user opens the location it is already in", async () => {
    const onChange = await render({ loadItems: source() });

    await userEvent.click(option("Reports"));
    await userEvent.click(option("Q1.pdf"));
    await userEvent.click(crumb("Reports"));
    await expect.element(option("Q1.pdf")).toHaveAttribute("aria-selected", "true");
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("never changes the selection while disabled", async () => {
    const onChange = await render({ loadItems: source(), disabled: true, searchPlaceholder: "Search Drive" });

    await expect.element(option("Budget.xlsx")).toBeVisible();
    await forceClick(option("Budget.xlsx"));
    await forceClick(option("Reports"));
    await forceClick(crumb("My Drive"));
    await forceClick(allOf());
    await act(() => {
      option("Reports").element().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await expect.element(crumb("My Drive")).toBeDisabled();
    await expect.element(allOf()).toBeDisabled();
    await expect.element(page.getByRole("searchbox", { name: "Search Drive" })).toBeDisabled();
    await expect.element(list()).toHaveAccessibleName("My Drive");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("pre-fill", () => {
  it("opens a pre-filled leaf's parent and shows it selected, without changing the selection", async () => {
    const loadItems = source();
    const loadItem = vi.fn(async (id: string): Promise<Item | null> =>
      ({ ...q1, id, path: [{ id: "reports", title: "Reports" }] }));
    const onChange = await render({ loadItems, loadItem, initial: "q1" });

    await expect.element(option("Q1.pdf")).toHaveAttribute("aria-selected", "true");
    await expect.element(list()).toHaveAccessibleName("Reports");
    expect(loadItem).toHaveBeenCalledExactlyOnceWith("q1");
    expect(loadItems.mock.calls.map(([request]) => request.parentId)).toEqual(["reports"]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ["the lookup fails", { loadItem: async (): Promise<Item | null> => { throw new Error("Drive is down."); } }],
    ["the lookup finds nothing", { loadItem: async (): Promise<Item | null> => null }],
    ["it cannot be connected", { loadItem: async (): Promise<Item | null> => locked }],
    ["the lookup finds another node", {
      loadItem: async (): Promise<Item | null> => ({ ...q1, id: "q1-copy", path: [{ id: "reports", title: "Reports" }] }),
    }],
    ["there is no lookup", {}],
  ])("lets go of a pre-filled value it cannot show because %s, and stays at the root", async (_, props) => {
    const onChange = await render({ loadItems: source(), initial: "q1", ...props });

    await expect.poll(() => onChange.mock.calls).toEqual([[null, null]]);
    await expect.element(list()).toHaveAccessibleName("My Drive");
    await expect.element(option("Reports")).toBeVisible();
  });

  it("shows a pre-filled root on its own choice", async () => {
    await render({ loadItems: source(), initial: "drive" });

    await expect.element(allOf()).toHaveAttribute("aria-pressed", "true");
    await expect.element(option("Reports")).toBeVisible();
  });

  it("lets go of a pre-filled root that cannot be connected, without looking it up", async () => {
    const loadItem = vi.fn(async (): Promise<Item | null> => null);
    const onChange = await render({
      loadItems: source(), loadItem, initial: "drive", root: { id: "drive", title: "My Drive" },
    });

    await expect.poll(() => onChange.mock.calls).toEqual([[null, null]]);
    await expect.element(option("Reports")).toBeVisible();
    expect(loadItem).not.toHaveBeenCalled();
  });

  it("opens a pre-filled container on its own row", async () => {
    const loadItem = vi.fn(async (): Promise<Item | null> => ({ ...reports, path: [] }));
    const onChange = await render({ loadItems: source(), loadItem, initial: "reports" });

    await expect.element(option("Everything in Reports")).toHaveAttribute("aria-selected", "true");
    await expect.element(crumbs()).toMatchTextContent(/^My DriveReports$/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ["on a later page of its folder", { path: [{ id: "reports", title: "Reports" }] }, "Reports"],
    ["looked up without a path", {}, "My Drive"],
  ])("keeps a pre-filled leaf its listing does not show in view, %s", async (_, where, location) => {
    const loadItems = vi.fn<LoadItems>(async ({ cursor }) =>
      cursor ? { items: [q1] } : { items: [archive], nextCursor: "page-2" });
    const onChange = await render({ loadItems, loadItem: async () => ({ ...q1, ...where }), initial: "q1" });

    await expect.element(option("Q1.pdf")).toHaveAttribute("aria-selected", "true");
    await expect.element(list()).toHaveAccessibleName(location);
    // Once the listing reaches it, it is listed once, where the listing puts it.
    await userEvent.click(page.getByRole("button", { name: "Load more" }));
    await expect.element(page.getByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(option("Q1.pdf").elements()).toHaveLength(1);
    await expect.element(option("Q1.pdf")).toHaveAttribute("aria-selected", "true");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a pinned pre-filled leaf listed after the user chooses another row", async () => {
    const loadItems = vi.fn<LoadItems>(async () => ({ items: [budget], nextCursor: "page-2" }));
    const onChange = await render({
      loadItems, loadItem: async () => ({ ...q1, path: [{ id: "reports", title: "Reports" }] }), initial: "q1",
    });

    await userEvent.click(option("Budget.xlsx"));
    expect(onChange).toHaveBeenLastCalledWith("budget", expect.objectContaining({ id: "budget" }));
    await expect.element(option("Q1.pdf")).toHaveAttribute("aria-selected", "false");
  });

  it("abandons a pre-fill still being looked up when the user chooses the whole hierarchy", async () => {
    const lookup = Promise.withResolvers<Item | null>();
    const onChange = await render({ loadItems: source(), loadItem: () => lookup.promise, initial: "q1" });

    await userEvent.click(allOf());
    expect(onChange).toHaveBeenLastCalledWith("drive", expect.objectContaining({ id: "drive" }));
    await expect.element(option("Reports")).toBeVisible();
    await act(() => lookup.resolve({ ...q1, path: [{ id: "reports", title: "Reports" }] }));

    await expect.element(list()).toHaveAccessibleName("My Drive");
    await expect.element(allOf()).toHaveAttribute("aria-pressed", "true");
  });

  it("abandons a pre-fill still being looked up when the user searches", async () => {
    const lookup = Promise.withResolvers<Item | null>();
    const loadItems = source({ budget: [budget] });
    const onChange = await render({
      loadItems, loadItem: () => lookup.promise, initial: "q1", searchPlaceholder: "Search Drive",
    });

    await userEvent.fill(page.getByRole("searchbox", { name: "Search Drive" }), "budget");
    await expect.element(option("Budget.xlsx")).toBeVisible();
    expect(onChange.mock.calls).toEqual([[null, null]]);
    await act(() => lookup.resolve({ ...q1, path: [{ id: "reports", title: "Reports" }] }));

    await userEvent.keyboard("{Escape}");
    await expect.element(option("Reports")).toBeVisible();
    await expect.element(list()).toHaveAccessibleName("My Drive");
    expect(loadItems.mock.calls.map(([request]) => request.parentId)).not.toContain("reports");
  });
});

describe("a value the module sets", () => {
  it("is pre-filled afresh, wherever the user had browsed", async () => {
    const loadItem = vi.fn(async (id: string): Promise<Item | null> =>
      ({ ...q1, id, path: [{ id: "reports", title: "Reports" }] }));
    const onChange = await render({ loadItems: source(), loadItem });

    await userEvent.click(option("Shared with me"));
    await act(() => setFromModule("q1"));
    await expect.element(option("Q1.pdf")).toHaveAttribute("aria-selected", "true");
    await expect.element(list()).toHaveAccessibleName("Reports");
    expect(loadItem).toHaveBeenCalledExactlyOnceWith("q1");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("starts again at a new root", async () => {
    const loadItems = source();
    const onChange = await render({ loadItems });
    await userEvent.click(option("Shared with me"));
    await expect.element(list()).toHaveAccessibleName("Shared with me");

    await act(() => root!.render(
      <Harness onChange={onChange} loadItems={loadItems} root={{ id: "team", title: "Team Drive" }} />));
    await expect.element(list()).toHaveAccessibleName("Team Drive");
    expect(loadItems).toHaveBeenLastCalledWith({ parentId: "team", query: "", cursor: null });
  });

  it.each([
    ["declining every choice", null, () => false, 0],
    ["declining to let go", "budget", (next: string | null) => next !== null, 1],
  ])("stays where the user took it when the module declines a change, %s", async (_, initial, accepts, lookups) => {
    const loadItem = vi.fn(async (): Promise<Item | null> => ({ ...budget, path: [] }));
    await render({ loadItems: source(), loadItem, initial, accepts });

    await userEvent.click(option("Reports"));
    await userEvent.click(option("Q1.pdf"));
    await expect.element(list()).toHaveAccessibleName("Reports");
    expect(loadItem).toHaveBeenCalledTimes(lookups);
  });

  it("shows a choice the module takes only after the user browsed on", async () => {
    const loadItem = vi.fn(async (id: string): Promise<Item | null> =>
      ({ ...q1, id, path: [{ id: "reports", title: "Reports" }] }));
    await render({ loadItems: source(), loadItem, accepts: () => false });

    await userEvent.click(option("Reports"));
    await userEvent.click(option("Q1.pdf"));
    await userEvent.click(option("Archive"));
    await expect.element(list()).toHaveAccessibleName("Archive");
    await act(() => setFromModule("q1"));
    await expect.element(list()).toHaveAccessibleName("Reports");
    await expect.element(option("Q1.pdf")).toHaveAttribute("aria-selected", "true");
  });

  // A module may take a pick only after awaiting something, such as `ensureResources`.
  it("leaves the user's search alone when the module takes a pick a moment later", async () => {
    const loadItem = vi.fn(async (): Promise<Item | null> => ({ ...q1, path: [{ id: "reports", title: "Reports" }] }));
    const onChange = await render({
      loadItems: source({ q1: [q1] }), loadItem, searchPlaceholder: "Search Drive", accepts: () => false,
    });
    const search = page.getByRole("searchbox", { name: "Search Drive" });

    await userEvent.fill(search, "q1");
    await userEvent.click(option("Q1.pdf"));
    await act(() => setFromModule("q1"));

    await expect.element(option("Q1.pdf")).toHaveAttribute("aria-selected", "true");
    await expect.element(search).toHaveValue("q1");
    expect(loadItem).not.toHaveBeenCalled();
    expect(onChange.mock.calls.map(([next]) => next)).toEqual(["q1"]);
  });

  it("leaves the user where they are when the module lets go of the choice", async () => {
    await render({ loadItems: source() });
    await userEvent.click(option("Reports"));
    await userEvent.click(option("Q1.pdf"));

    await act(() => setFromModule(null));

    await expect.element(option("Q1.pdf")).toHaveAttribute("aria-selected", "false");
    await expect.element(list()).toHaveAccessibleName("Reports");
  });

  // A container is chosen from the row it opens to, not from its row in its parent's listing.
  it("opens a container the module sets, even one the open listing shows", async () => {
    const loadItem = vi.fn(async (): Promise<Item | null> => ({ ...reports, path: [] }));
    await render({ loadItems: source(), loadItem });
    await expect.element(option("Reports")).toBeVisible();

    await act(() => setFromModule("reports"));

    await expect.element(option("Everything in Reports")).toHaveAttribute("aria-selected", "true");
    expect(loadItem).toHaveBeenCalledExactlyOnceWith("reports");
  });

  it("lets go of a locked leaf the module sets, though the listing shows it", async () => {
    const loadItem = vi.fn(async (): Promise<Item | null> => ({ ...locked, path: [] }));
    const onChange = await render({ loadItems: source(), loadItem });
    await expect.element(option("Locked.doc")).toBeVisible();

    await act(() => setFromModule("locked"));

    await expect.poll(() => onChange.mock.lastCall).toEqual([null, null]);
    await expect.element(option("Locked.doc")).toHaveAttribute("aria-selected", "false");
  });

  it("goes back to a pick the module takes while the next search is being typed", async () => {
    const loadItem = vi.fn(async (): Promise<Item | null> => ({ ...q1, path: [{ id: "reports", title: "Reports" }] }));
    await render({
      loadItems: source({ q1: [q1] }), loadItem, searchPlaceholder: "Search Drive", accepts: () => false,
    });
    const search = page.getByRole("searchbox", { name: "Search Drive" });
    await userEvent.fill(search, "q1");
    await userEvent.click(option("Q1.pdf"));

    // Typed, then the pick taken, before the debounced search starts: the rows showing it are about
    // to give way.
    const input = search.element() as HTMLInputElement;
    await act(() => {
      input.value = "q2";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      setFromModule("q1");
    });

    await expect.element(list()).toHaveAccessibleName("Reports");
    await expect.element(option("Q1.pdf")).toHaveAttribute("aria-selected", "true");
    expect(loadItem).toHaveBeenCalledExactlyOnceWith("q1");
  });
});

describe("loading", () => {
  it("ignores a listing that arrives after the user has moved on", async () => {
    const pending: Record<string, PromiseWithResolvers<ConfiguratorUIHierarchyPage>> = {};
    let rootLoads = 0;
    const loadItems = vi.fn<LoadItems>(({ parentId }) => {
      if (parentId === "drive" && rootLoads++ === 0) return Promise.resolve({ items: TREE.drive });
      pending[parentId] = Promise.withResolvers();
      return pending[parentId].promise;
    });
    await render({ loadItems });

    await userEvent.click(option("Reports"));
    await expect.poll(() => pending.reports).toBeDefined();
    const lateReports = pending.reports!;
    await userEvent.click(crumb("My Drive"));
    await expect.poll(() => pending.drive).toBeDefined();
    await act(() => pending.drive!.resolve({ items: TREE.drive! }));
    await act(() => lateReports.resolve({ items: [{ id: "stale", title: "Stale.pdf", kind: "leaf" }] }));

    await expect.element(option("Budget.xlsx")).toBeVisible();
    await expect.element(list()).toHaveAccessibleName("My Drive");
    expect(option("Stale.pdf").elements()).toHaveLength(0);

    // Nor does it stand in for Reports' listing when the user goes back there.
    await userEvent.click(option("Reports"));
    await expect.poll(() => pending.reports).not.toBe(lateReports);
    await expect.element(list()).toHaveAttribute("aria-busy", "true");
    expect(option("Stale.pdf").elements()).toHaveLength(0);
    await act(() => pending.reports!.resolve({ items: [q1] }));
    await expect.element(option("Q1.pdf")).toBeVisible();
    expect(option("Stale.pdf").elements()).toHaveLength(0);
  });

  it("appends the next page in the order the source gives", async () => {
    const zeta: Item = { id: "zeta", title: "Zeta", kind: "leaf" };
    const alpha: Item = { id: "alpha", title: "Alpha", kind: "leaf" };
    const mu: Item = { id: "mu", title: "Mu", kind: "leaf" };
    const loadItems = vi.fn<LoadItems>(async ({ cursor }) =>
      cursor === "page-2" ? { items: [mu] } : { items: [zeta, alpha], nextCursor: "page-2" });
    await render({ loadItems });

    await userEvent.click(page.getByRole("button", { name: "Load more" }));
    await expect.element(option("Mu")).toBeVisible();
    expect(loadItems).toHaveBeenLastCalledWith({ parentId: "drive", query: "", cursor: "page-2" });
    expect(page.getByRole("option").elements().map(row => row.textContent)).toEqual(["Zeta", "Alpha", "Mu"]);
    expect(page.getByRole("button", { name: "Load more" }).elements()).toHaveLength(0);
  });

  it("refuses a page of more than 200 items rather than showing part of it, and retries", async () => {
    const many = Array.from({ length: 201 }, (_, index): Item =>
      ({ id: `file-${index}`, title: `File ${index}`, kind: "leaf" }));
    const loadItems = vi.fn<LoadItems>(async () => ({ items: many }));
    await render({ loadItems });

    await expect.element(page.getByText("The list returned more than 200 items in one page.")).toBeVisible();
    expect(page.getByRole("option").elements()).toHaveLength(0);

    loadItems.mockResolvedValueOnce({ items: [budget] });
    await userEvent.click(page.getByRole("button", { name: "Retry" }));
    await expect.element(option("Budget.xlsx")).toBeVisible();
  });

  it("says why a location is unavailable, with Retry, without reporting it as a failure", async () => {
    vi.mocked(reportFrontendIssue).mockClear();
    const loadItems = vi.fn<LoadItems>(async () => ({ items: [budget] }))
      .mockRejectedValueOnce(new Error("Drive is down."))
      .mockResolvedValueOnce({ items: [], unavailable: "Allow access below, then select Retry." });
    await render({ loadItems });
    const retry = page.getByRole("button", { name: "Retry" });

    await expect.element(page.getByText("Drive is down.")).toBeVisible();
    await userEvent.click(retry);
    await expect.element(page.getByText("Allow access below, then select Retry.")).toBeVisible();
    expect(reportFrontendIssue).toHaveBeenCalledExactlyOnceWith(
      "configurator.hierarchy-load", new Error("Drive is down."));

    await userEvent.click(retry);
    await expect.element(option("Budget.xlsx")).toBeVisible();
  });

  it("shows a page's notice above its rows, or in place of saying the listing is empty, and says it", async () => {
    const partial = "Search is down, so only recent files are listed.";
    const loadItems = vi.fn<LoadItems>(async ({ parentId }) => parentId === "reports"
      ? { items: [], notice: "Nothing has been shared here yet." }
      : { items: [reports, budget], notice: `${partial}\u202E` });
    await render({ loadItems });
    const status = page.getByRole("status");

    await expect.element(page.getByText(partial, { exact: true })).toBeVisible();
    await expect.element(status).toHaveTextContent(`2 items. ${partial}`);
    expect(container!.textContent).not.toContain("\u202E");

    await userEvent.click(option("Reports"));
    await expect.element(status).toHaveTextContent("Nothing has been shared here yet.");
    await expect.element(page.getByText("Nothing has been shared here yet.").first()).toBeVisible();
    expect(status.element().textContent).not.toContain("Nothing here.");
  });

  it("keeps a page's notice while later pages that have none load", async () => {
    const partial = "Search is down, so only recent files are listed.";
    await render({ loadItems: async ({ cursor }) => cursor
      ? { items: [q1] }
      : { items: [budget], nextCursor: "page-2", notice: partial } });

    await userEvent.click(page.getByRole("button", { name: "Load more" }));
    await expect.element(option("Q1.pdf")).toBeVisible();
    await expect.element(page.getByText(partial, { exact: true })).toBeVisible();
    await expect.element(page.getByRole("status")).toHaveTextContent(`2 items. ${partial}`);
  });

  it("loads the next page once the user scrolls near the end, but never on its own", async () => {
    const loadItems = vi.fn(twoPages);
    await render({ loadItems });
    await expect.element(file(0)).toBeVisible();
    const box = boxHeight(320);
    await effectsFlushed();
    expect(loadItems).toHaveBeenCalledTimes(1);

    box.scrollTop = box.scrollHeight;
    await expect.element(file(59)).toBeInTheDocument();
    expect(loadItems).toHaveBeenLastCalledWith({ parentId: "drive", query: "", cursor: "page-2" });
  });

  it("lets Tab pass Load more, though focusing it scrolls the list to its end", async () => {
    const loadItems = vi.fn(twoPages);
    await render({ loadItems });
    await expect.element(file(0)).toBeVisible();
    boxHeight(320);
    await userEvent.click(file(0));

    await userEvent.tab();
    const loadMore = page.getByRole("button", { name: "Load more" });
    await expect.element(loadMore).toHaveFocus();
    await effectsFlushed();
    await effectsFlushed();
    expect(loadItems).toHaveBeenCalledTimes(1);
    await expect.element(loadMore).toHaveFocus();
  });

  it("moves focus from Retry or Load more to the first row it brings", async () => {
    const loadItems = vi.fn<LoadItems>(async ({ cursor }) => {
      if (cursor === "page-2") return { items: [q1], nextCursor: "page-3" };
      if (cursor === "page-3") return { items: [{ id: "old", title: "Old.pdf", kind: "leaf" }] };
      return { items: [budget], nextCursor: "page-2" };
    }).mockRejectedValueOnce(new Error("Drive is down."));
    await render({ loadItems });
    const loadMore = page.getByRole("button", { name: "Load more" });

    await userEvent.click(page.getByRole("button", { name: "Retry" }));
    await expect.element(option("Budget.xlsx")).toHaveFocus();
    await userEvent.tab();
    await expect.element(loadMore).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(option("Q1.pdf")).toHaveFocus();

    // The last page takes the button with it.
    await userEvent.tab();
    await expect.element(loadMore).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(option("Old.pdf")).toHaveFocus();
    expect(loadMore.elements()).toHaveLength(0);
  });

  it.each([
    ["brings nothing", []],
    ["brings only rows already listed", [budget]],
    ["names only the location it lists", [{ id: ROOT.id, title: ROOT.title, kind: "container" } satisfies Item]],
  ])("moves focus from Load more to the row it followed when the last page %s", async (_, last) => {
    const loadItems = vi.fn<LoadItems>(async ({ cursor }) =>
      cursor ? { items: last, nextCursor: null } : { items: [budget, q1], nextCursor: "page-2" });
    await render({ loadItems });
    const loadMore = page.getByRole("button", { name: "Load more" });

    await userEvent.click(loadMore);
    await expect.element(loadMore).not.toBeInTheDocument();
    await expect.element(option("Q1.pdf")).toHaveFocus();
  });

  it("drops malformed items and strips formatting characters from titles", async () => {
    const loadItems = vi.fn<LoadItems>(async () => ({
      items: [
        { id: "invoice", title: "Invoice\u202Etxt.exe", kind: "leaf" },
        { id: "bogus", title: "Bogus", kind: "folder" as never },
        { id: "", title: "No id", kind: "leaf" },
        { id: "untitled", title: "\u200e", kind: "leaf" },
      ],
    }));
    await render({ loadItems });

    await expect.element(page.getByRole("option", { name: "Invoicetxt.exe", exact: true })).toBeVisible();
    expect(page.getByRole("option").elements()).toHaveLength(1);
    expect(list().element().textContent).not.toContain("\u202E");
  });

  it("shows a node's badge after its title and its meta after its subtitle, stripped of formatting characters", async () => {
    const loadItems = vi.fn<LoadItems>(async () => ({
      items: [{ ...budget, badge: "Confidential", meta: "2 days ago\u202E" }],
    }));
    await render({ loadItems });

    await expect.element(option("Budget.xlsx")).toHaveAccessibleName(/^Budget\.xlsx\s*Confidential\s*2 days ago$/);
  });
});

describe("search", () => {
  it("opens a container found by search where its path says it lives", async () => {
    const deep: Item = {
      id: "2024", title: "2024", kind: "container",
      path: [{ id: "reports", title: "Reports" }, { id: "archive", title: "Archive" }],
    };
    const loadItems = source({ "20": [deep] });
    const onChange = await render({ loadItems, searchPlaceholder: "Search Drive" });
    const search = page.getByRole("searchbox", { name: "Search Drive" });

    await userEvent.fill(search, "20");
    await expect.element(option("2024")).toMatchTextContent("Reports / Archive");
    expect(loadItems).toHaveBeenLastCalledWith({ parentId: "drive", query: "20", cursor: null });

    await userEvent.click(option("2024"));
    await expect.element(search).toHaveValue("");
    await expect.element(crumbs()).toMatchTextContent(/^My DriveReportsArchive2024/);
    await expect.element(crumb("2024")).toHaveAttribute("aria-current", "location");
    await expect.element(option("Everything in 2024")).toBeVisible();
    // The breadcrumb renders before the effect that lists the new location runs.
    await expect.poll(() => loadItems.mock.lastCall?.[0])
      .toEqual({ parentId: "2024", query: "", cursor: null });
    // Neither the search nor opening its hit chose anything.
    expect(onChange).not.toHaveBeenCalled();

    // Up a level from a search hit goes to its real parent.
    await userEvent.click(crumb("Archive"));
    await expect.element(option("Old.pdf")).toBeVisible();
  });

  it("does not pretend a container found without a path is a child of the root", async () => {
    const loose: Item = { id: "loose", title: "Loose", kind: "container", subtitle: "Owned by Kim" };
    await render({ loadItems: source({ loose: [loose] }), searchPlaceholder: "Search Drive" });
    const search = page.getByRole("searchbox", { name: "Search Drive" });

    await userEvent.fill(search, "loose");
    await expect.element(option("Loose")).toMatchTextContent("Owned by Kim");
    await userEvent.click(option("Loose"));
    await expect.element(crumbs()).toMatchTextContent("My Drive…Loose");
    await expect.element(list()).toHaveAccessibleName("Loose");
  });

  it("tells same-named results apart by where they live and what they say of themselves", async () => {
    const copies: Item[] = [
      { ...q1, subtitle: "Owned by Kim", path: [{ id: "reports", title: "Reports" }] },
      { ...q1, id: "q1-old", subtitle: "Owned by Kim", path: [{ id: "reports", title: "Reports" }, { id: "archive", title: "Archive" }] },
    ];
    await render({ loadItems: source({ q1: copies }), searchPlaceholder: "Search Drive" });

    await userEvent.fill(page.getByRole("searchbox", { name: "Search Drive" }), "q1");
    await expect.element(option("Reports · Owned by Kim")).toBeVisible();
    expect(page.getByRole("option").elements().map(row => row.textContent))
      .toEqual(["Q1.pdfReports · Owned by Kim", "Q1.pdfReports / Archive · Owned by Kim"]);
  });

  it("chooses a leaf found by search, and lets go of it when the search changes", async () => {
    const hit: Item = { ...q1, path: [{ id: "reports", title: "Reports" }] };
    const onChange = await render({ loadItems: source({ q1: [hit] }), searchPlaceholder: "Search Drive" });
    const search = page.getByRole("searchbox", { name: "Search Drive" });

    await userEvent.fill(search, "q1");
    await userEvent.click(option("Q1.pdf"));
    expect(onChange).toHaveBeenLastCalledWith("q1", expect.objectContaining({ id: "q1" }));
    await expect.element(search).toHaveValue("q1");

    await userEvent.fill(search, "");
    expect(onChange).toHaveBeenLastCalledWith(null, null);
    await expect.element(option("Reports")).toBeVisible();
  });

  it("chooses nothing from results the search being typed is about to replace", async () => {
    const onChange = await render({ loadItems: source({ q1: [q1] }), searchPlaceholder: "Search Drive" });
    const search = page.getByRole("searchbox", { name: "Search Drive" });
    await userEvent.fill(search, "q1");
    await expect.element(option("Q1.pdf")).toBeVisible();

    // Typed, then the row clicked, before the debounced search starts.
    const input = search.element() as HTMLInputElement;
    await act(() => {
      input.value = "q1 2024";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await forceClick(option("Q1.pdf"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("sits compact beside the breadcrumb, and takes its place while in use", async () => {
    await render({ loadItems: source(), searchPlaceholder: "Search Drive" });
    const search = page.getByRole("searchbox", { name: "Search Drive" });
    await expect.element(search).toHaveAttribute("placeholder", "Search");
    await expect.element(crumbs()).toBeVisible();

    await userEvent.click(search);
    expect(crumbs().elements()).toHaveLength(0);
    await expect.element(search).toHaveAttribute("placeholder", "Search Drive");
    await userEvent.fill(search, "nothing");
    await expect.element(list()).toHaveAccessibleName("Search results");

    // Emptied but still in use, it keeps the breadcrumb's place until the user leaves it.
    await userEvent.keyboard("{Escape}");
    expect(crumbs().elements()).toHaveLength(0);
    await userEvent.tab();
    await expect.element(crumbs()).toBeVisible();
    await expect.element(list()).toHaveAccessibleName("My Drive");
  });

  it("returns Shift+Tab from the empty search box to the breadcrumb it covered", async () => {
    await render({ loadItems: source(), searchPlaceholder: "Search Drive" });

    await userEvent.click(option("Reports"));
    await userEvent.click(page.getByRole("searchbox", { name: "Search Drive" }));
    await userEvent.tab({ shift: true });
    await expect.element(crumb("Reports")).toHaveFocus();
  });

  it("clears the search with Escape, unless an input method takes it, and says when nothing matched", async () => {
    await render({ loadItems: source(), searchPlaceholder: "Search Drive" });
    const search = page.getByRole("searchbox", { name: "Search Drive" });

    await userEvent.fill(search, "nothing");
    await expect.element(page.getByText('No results for "nothing".')).toBeVisible();
    keydown("Escape", { isComposing: true });
    await expect.element(search).toHaveValue("nothing");
    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    await expect.element(option("Reports")).toBeVisible();
  });

  it("jumps to the search box with / from anywhere in the picker, selecting what it holds, but types / in it", async () => {
    await render({ loadItems: source({ q: [q1] }), searchPlaceholder: "Search Drive" });
    const search = page.getByRole("searchbox", { name: "Search Drive" });
    await userEvent.fill(search, "q");
    await expect.element(option("Q1.pdf")).toBeVisible();

    await userEvent.click(option("Q1.pdf"));
    await userEvent.keyboard("/");
    await expect.element(search).toHaveFocus();
    await userEvent.keyboard("a/b");
    await expect.element(search).toHaveValue("a/b");

    await userEvent.click(allOf());
    await userEvent.keyboard("/");
    await expect.element(search).toHaveFocus();
    await expect.element(search).toHaveValue("a/b");
    const input = search.element() as HTMLInputElement;
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
  });
});

describe("keyboard", () => {
  it("moves with the arrows, opens with Enter or ArrowRight, chooses with Enter or Space, and goes up with ArrowLeft", async () => {
    const onChange = await render({ loadItems: source() });
    await expect.element(option("Reports")).toBeVisible();

    await userEvent.tab();
    await expect.element(allOf()).toHaveFocus();
    await userEvent.tab();
    await expect.element(crumb("My Drive")).toHaveFocus();
    await userEvent.tab();
    await expect.element(option("Reports")).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    await expect.element(option("Shared with me")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard("{Enter}");
    // Focus follows into the opened container, onto its own row; opening it chose nothing.
    await expect.element(option("Everything in Reports")).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.keyboard("{ArrowDown}");
    await expect.element(option("Archive")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(option("Everything in Archive")).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(option("Everything in Reports")).toHaveFocus();

    await userEvent.keyboard("{End}");
    await expect.element(option("Q1.pdf")).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith("q1", expect.objectContaining({ id: "q1" }));
    await userEvent.keyboard("{Home}");
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("reports",
      { id: "reports", title: "Reports", kind: "container", selectable: true });

    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith(null, null);
    await expect.element(list()).toHaveAccessibleName("My Drive");
    await expect.element(option("Reports")).toHaveFocus();
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["b", "Beta.pdf"],
    ["bbb", "Bravo"],
    ["bbbb", "Beta.pdf"],
    ["bu", "Budget.xlsx"],
    ["x", "Alpha"],
  ])("moves from the first row with %s to %s by type-ahead", async (keys, target) => {
    const titles = ["Alpha", "Beta.pdf", "Budget.xlsx", "Bravo"];
    const onChange = await render({
      loadItems: async () => ({ items: titles.map(title => ({ id: title, title, kind: "leaf" as const })) }),
    });
    await userEvent.click(option("Alpha"));
    onChange.mockClear();

    await userEvent.keyboard(keys);
    await expect.element(page.getByRole("option", { name: target })).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("types ahead with a letter typed with AltGr, but not with a shortcut", async () => {
    const titles = ["Alpha", "Łódź.pdf", "Zeta"];
    await render({ loadItems: async () => ({ items: titles.map(title => ({ id: title, title, kind: "leaf" as const })) }) });
    await userEvent.click(option("Alpha"));

    keydown("z", { ctrlKey: true, altKey: true });
    await expect.element(option("Alpha")).toHaveFocus();
    keydown("ł", { ctrlKey: true, altKey: true, modifierAltGraph: true });
    await expect.element(option("Łódź.pdf")).toHaveFocus();
  });

  it("pages to the last row in view, then a box's height on, and stops at the ends", async () => {
    await render({ loadItems: async () => ({ items: FILES.slice(0, 12) }) });
    await expect.element(file(0)).toBeVisible();
    boxHeight((file(0).element() as HTMLElement).offsetHeight * 5);
    await userEvent.click(file(0));

    await userEvent.keyboard("{PageDown}");
    await expect.element(file(4)).toHaveFocus();
    await userEvent.keyboard("{PageDown}{PageDown}");
    await expect.element(file(11)).toHaveFocus();
    await userEvent.keyboard("{PageUp}");
    await expect.element(file(7)).toHaveFocus();
    await userEvent.keyboard("{PageUp}{PageUp}");
    await expect.element(file(0)).toHaveFocus();
  });

  it("pages from the rows in view once the focused row is scrolled away, leaving the list where it is", async () => {
    await render({ loadItems: async () => ({ items: FILES.slice(0, 30) }) });
    await expect.element(file(0)).toBeVisible();
    const rowHeight = (file(0).element() as HTMLElement).offsetHeight;
    const box = boxHeight(rowHeight * 5);
    await userEvent.click(file(0));
    box.scrollTop = rowHeight * 20;

    await userEvent.keyboard("{PageDown}");
    await expect.element(file(24)).toHaveFocus();
    expect(box.scrollTop).toBe(rowHeight * 20);
    await userEvent.keyboard("{PageUp}");
    await expect.element(file(20)).toHaveFocus();
    expect(box.scrollTop).toBe(rowHeight * 20);
  });

  it("pages on from a focused row cut off at the edge it pages past, as a click leaves one", async () => {
    await render({ loadItems: async () => ({ items: FILES.slice(0, 30) }) });
    await expect.element(file(0)).toBeVisible();
    const rowHeight = (file(0).element() as HTMLElement).offsetHeight;
    const box = boxHeight(rowHeight * 5);
    // Rows 1 to 4 in full view; 0 cut off at the top and 5 at the bottom.
    box.scrollTop = rowHeight / 2;
    (file(5).element() as HTMLElement).focus({ preventScroll: true });

    await userEvent.keyboard("{PageDown}");
    await expect.element(file(9)).toHaveFocus();
    expect(box.scrollTop).toBe(rowHeight * 5);

    box.scrollTop = rowHeight * 4.5;
    (file(4).element() as HTMLElement).focus({ preventScroll: true });
    await userEvent.keyboard("{PageUp}");
    await expect.element(file(0)).toHaveFocus();
    expect(box.scrollTop).toBe(0);
  });

  it("scrolls the list a page from the search box, unless an input method takes the key, and from the page, where / goes to the search box", async () => {
    await render({ loadItems: async () => ({ items: FILES.slice(0, 30) }), searchPlaceholder: "Search Drive" });
    await expect.element(file(0)).toBeVisible();
    const rowHeight = (file(0).element() as HTMLElement).offsetHeight;
    const box = boxHeight(rowHeight * 5);
    const search = page.getByRole("searchbox", { name: "Search Drive" });

    await userEvent.click(search);
    keydown("PageDown", { isComposing: true });
    expect(box.scrollTop).toBe(0);
    await userEvent.keyboard("{PageDown}");
    await expect.element(search).toHaveFocus();
    expect(box.scrollTop).toBe(rowHeight * 4);
    await userEvent.keyboard("{PageUp}");
    expect(box.scrollTop).toBe(0);

    // Where a click on a label or on the blank part of the list leaves focus.
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard("{PageDown}");
    expect(box.scrollTop).toBe(rowHeight * 4);
    await userEvent.keyboard("/");
    await expect.element(search).toHaveFocus();
  });

  it("gives keys pressed with nothing focused to the first picker that is not disabled", async () => {
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(() => root!.render(<>
      <Harness onChange={vi.fn()} loadItems={thirtyFiles} searchPlaceholder="Search first" disabled />
      <Harness onChange={vi.fn()} loadItems={thirtyFiles} searchPlaceholder="Search second" />
    </>));
    const [first, second] = [list().nth(0), list().nth(1)];
    const row = second.getByRole("option", { name: "File 0", exact: true });
    await expect.element(row).toBeVisible();
    const rowHeight = (row.element() as HTMLElement).offsetHeight;
    const [firstBox, secondBox] = [first, second].map(listbox => {
      const box = listbox.element().parentElement!;
      Object.assign(box.style, { height: `${rowHeight * 5}px`, overflowX: "hidden", overflowY: "auto" });
      return box;
    });

    await userEvent.keyboard("{PageDown}");
    expect(secondBox.scrollTop).toBe(rowHeight * 4);
    expect(firstBox.scrollTop).toBe(0);
    await userEvent.keyboard("/");
    await expect.element(page.getByRole("searchbox", { name: "Search second" })).toHaveFocus();
  });

  it("moves focus into a container opened by a click or a quick run of keys", async () => {
    await render({ loadItems: source() });

    await userEvent.click(option("Reports"));
    await expect.element(option("Everything in Reports")).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(option("Reports")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    await expect.element(option("Everything in Reports")).toHaveFocus();
  });

  it.each(["the search box", "a field outside the picker"])(
    "leaves focus on %s when the user moves it there while an opened container loads", async target => {
      const listing = Promise.withResolvers<ConfiguratorUIHierarchyPage>();
      const loadItems = vi.fn<LoadItems>(async ({ parentId }) =>
        parentId === "reports" ? listing.promise : { items: TREE[parentId] ?? [] });
      await render({ loadItems, searchPlaceholder: "Search Drive" });
      const field = document.body.appendChild(document.createElement("input"));
      onTestFinished(() => field.remove());
      const elsewhere = target === "the search box"
        ? page.getByRole("searchbox", { name: "Search Drive" }).element()
        : field;

      await userEvent.click(option("Reports"));
      await expect.element(list()).toHaveFocus();
      await userEvent.click(elsewhere);
      await act(() => listing.resolve({ items: [q1] }));
      await expect.element(option("Q1.pdf")).toBeVisible();
      await effectsFlushed();
      expect(document.activeElement).toBe(elsewhere);
    });

  it("leaves focus in another frame the user moves it to while an opened container loads", async () => {
    const listing = Promise.withResolvers<ConfiguratorUIHierarchyPage>();
    const loadItems = vi.fn<LoadItems>(async ({ parentId }) =>
      parentId === "reports" ? listing.promise : { items: TREE[parentId] ?? [] });
    await render({ loadItems });
    // Vitest's page around this test's frame stands in for the Workshop around a configurator's.
    const host = window.parent.document;
    const field = host.body.appendChild(host.createElement("input"));
    onTestFinished(() => field.remove());

    await userEvent.click(option("Reports"));
    await expect.element(list()).toHaveFocus();
    field.focus();
    expect(document.hasFocus()).toBe(false);
    await act(() => listing.resolve({ items: [q1] }));
    await expect.element(option("Q1.pdf")).toBeVisible();
    await effectsFlushed();
    expect(host.activeElement).toBe(field);
  });
});

/** `icon` as React renders it on its own, to compare with what the picker drew. */
const drawn = (icon: React.ReactNode) => {
  const host = document.createElement("div");
  act(() => createRoot(host).render(icon));
  return host.innerHTML;
};

describe("icons", () => {
  it("draws a node's named icon, and the default for its kind when the name is missing or unknown", async () => {
    const icons = { sheet: <svg data-testid="sheet-icon" /> };
    const loadItems = vi.fn<LoadItems>(async () => ({
      items: [
        { id: "budget", title: "Budget", kind: "leaf", icon: "sheet" },
        { id: "notes", title: "Notes", kind: "leaf", icon: "constructor" },
        { id: "folder", title: "Folder", kind: "container", icon: "nope" },
      ],
    }));
    await render({ loadItems, icons });

    const slot = (name: string) => option(name).element().querySelector<HTMLElement>("[aria-hidden='true']")!;
    await expect.element(option("Budget")).toBeVisible();
    expect(slot("Budget").querySelector("[data-testid='sheet-icon']")).not.toBeNull();
    expect(slot("Budget").getAttribute("aria-hidden")).toBe("true");

    expect(slot("Notes").innerHTML).toBe(drawn(<FileIcon size={20} />));
    expect(slot("Folder").innerHTML).toBe(drawn(<FolderIcon size={20} />));
  });
});

describe("tabs", () => {
  const TABS = [{ id: "sites", title: "Sites" }, { id: "files", title: "Files" }];
  const marketing: Item = { id: "marketing", title: "Marketing", kind: "container" };
  const plan: Item = { id: "plan", title: "Plan.docx", kind: "leaf" };
  const notes: Item = { id: "notes", title: "Notes.txt", kind: "leaf" };
  const TABBED: Record<string, Item[]> = { sites: [marketing], marketing: [plan], files: [notes] };

  /** A source answering from {@link TABBED}, and from `results` for a search. */
  const tabbed = (results: Record<string, Item[]> = {}) => vi.fn<LoadItems>(async ({ parentId, query }) => ({
    items: query ? results[query] ?? [] : TABBED[parentId] ?? [],
  }));

  it("lists the first tab below the root's choice, its breadcrumb starting at the tab, and another when chosen", async () => {
    const loadItems = tabbed();
    const onChange = await render({ loadItems, tabs: TABS });

    await expect.element(option("Marketing")).toBeVisible();
    await expect.element(tab("Sites")).toHaveAttribute("aria-selected", "true");
    await expect.element(list()).toHaveAccessibleName("Sites");
    await expect.element(crumbs()).toMatchTextContent(/^Sites$/);
    await expect.element(allOf()).toBeVisible();
    // A tab is offered as a choice only when it says so.
    expect(option("Everything in").elements()).toHaveLength(0);

    await userEvent.click(option("Marketing"));
    await expect.element(crumbs()).toMatchTextContent(/^SitesMarketing$/);
    await userEvent.click(option("Plan.docx"));
    expect(onChange).toHaveBeenLastCalledWith("plan", expect.objectContaining({ id: "plan" }));

    await userEvent.click(tab("Files"));
    await expect.element(option("Notes.txt")).toBeVisible();
    await expect.element(list()).toHaveAccessibleName("Files");
    await expect.element(crumbs()).toMatchTextContent(/^Files$/);
    expect(onChange).toHaveBeenLastCalledWith(null, null);
    // The root is never listed: only its tabs are.
    expect(loadItems.mock.calls.map(([request]) => request.parentId)).toEqual(["sites", "marketing", "files"]);
  });

  it("offers a tab that says it can be chosen, and keeps the whole hierarchy's choice across tabs", async () => {
    const choice = { title: "Every site" };
    const onChange = await render({ loadItems: tabbed(), tabs: [{ ...TABS[0]!, selectable: true, choice }, TABS[1]!] });

    await userEvent.click(option("Every site"));
    expect(onChange).toHaveBeenLastCalledWith("sites",
      { id: "sites", title: "Sites", kind: "container", selectable: true, choice });
    await userEvent.click(allOf());
    await userEvent.click(tab("Files"));
    await expect.element(option("Notes.txt")).toBeVisible();
    await expect.element(allOf()).toHaveAttribute("aria-pressed", "true");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("strips formatting characters from what a tab shows, and drops a tab it cannot show", async () => {
    const choice = { title: "Every site\u202E", subtitle: "Across the tenant\u202E" };
    await render({ loadItems: tabbed(), tabs: [
      { ...TABS[0]!, title: "Sites\u202E", selectable: true, choice },
      { ...TABS[1]!, unselectableReason: "Choose a file inside.\u202E" },
      null as never,
    ] });

    expect(page.getByRole("tab").elements()).toHaveLength(2);

    await expect.element(option("Every site")).toBeVisible();
    expect(container!.textContent).not.toContain("\u202E");
    await userEvent.click(tab("Files"));
    await expect.element(page.getByText("Choose a file inside.")).toBeVisible();
    expect(container!.textContent).not.toContain("\u202E");
  });

  it("opens a pre-filled node in the tab its path starts with", async () => {
    const loadItem = vi.fn(async (): Promise<Item | null> => ({ ...notes, path: [{ id: "files", title: "Files" }] }));
    const onChange = await render({ loadItems: tabbed(), loadItem, tabs: TABS, initial: "notes" });

    await expect.element(option("Notes.txt")).toHaveAttribute("aria-selected", "true");
    await expect.element(tab("Files")).toHaveAttribute("aria-selected", "true");
    await expect.element(crumbs()).toMatchTextContent(/^Files$/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens a pre-filled node whose path names no tab in the open tab, apart from its top", async () => {
    const loadItem = vi.fn(async (): Promise<Item | null> =>
      ({ ...plan, path: [{ id: "marketing", title: "Marketing" }] }));
    await render({ loadItems: tabbed(), loadItem, tabs: TABS, initial: "plan" });

    await expect.element(option("Plan.docx")).toHaveAttribute("aria-selected", "true");
    await expect.element(crumbs()).toMatchTextContent(/^Sites…Marketing$/);
  });

  it("pins a pre-filled leaf without a path atop the open tab, whose folders open with no gap", async () => {
    const loadItem = vi.fn(async (): Promise<Item | null> => notes);
    await render({ loadItems: tabbed(), loadItem, tabs: TABS, initial: "notes" });

    await expect.element(option("Notes.txt")).toHaveAttribute("aria-selected", "true");
    await expect.element(list()).toHaveAccessibleName("Sites");
    await expect.element(crumbs()).toMatchTextContent(/^Sites$/);
    // What the tab lists is its own, so a folder opened from it is known to sit right under it.
    await userEvent.click(option("Marketing"));
    await expect.element(list()).toHaveAccessibleName("Marketing");
    await expect.element(crumbs()).toMatchTextContent(/^SitesMarketing$/);
  });

  it("shows a pre-filled tab on its own row without looking it up", async () => {
    const loadItem = vi.fn(async (): Promise<Item | null> => null);
    const onChange = await render({
      loadItems: tabbed(), loadItem, tabs: [TABS[0]!, { ...TABS[1]!, selectable: true }], initial: "files",
    });

    await expect.element(option("Everything in Files")).toHaveAttribute("aria-selected", "true");
    await expect.element(tab("Files")).toHaveAttribute("aria-selected", "true");
    expect(loadItem).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("lets go of a pre-filled tab not offered as a choice, without looking it up", async () => {
    const loadItem = vi.fn(async (): Promise<Item | null> => null);
    const onChange = await render({ loadItems: tabbed(), loadItem, tabs: TABS, initial: "files" });

    await expect.poll(() => onChange.mock.calls).toEqual([[null, null]]);
    await expect.element(tab("Sites")).toHaveAttribute("aria-selected", "true");
    expect(loadItem).not.toHaveBeenCalled();
  });

  it("opens a search result in the tab its path names, and drops the search when the user switches tabs", async () => {
    const old: Item = { id: "old", title: "Old", kind: "container", path: [{ id: "files", title: "Files" }] };
    const loadItems = tabbed({ old: [old], notes: [notes] });
    await render({ loadItems, tabs: TABS, searchPlaceholder: "Search everything" });
    const search = page.getByRole("searchbox", { name: "Search everything" });
    await expect.element(search).toHaveAttribute("placeholder", "Search everything");

    await userEvent.fill(search, "old");
    await expect.element(option("Old")).toBeVisible();
    expect(crumbs().elements()).toHaveLength(0);
    expect(loadItems).toHaveBeenLastCalledWith({ parentId: "sites", query: "old", cursor: null });
    await userEvent.click(option("Old"));
    await expect.element(tab("Files")).toHaveAttribute("aria-selected", "true");
    await expect.element(crumbs()).toMatchTextContent(/^FilesOld$/);
    await expect.element(search).toHaveValue("");

    await userEvent.fill(search, "notes");
    await expect.element(option("Notes.txt")).toBeVisible();
    await userEvent.click(tab("Sites"));
    await expect.element(search).toHaveValue("");
    await expect.element(option("Marketing")).toBeVisible();
  });

  it("never switches tabs while disabled", async () => {
    await render({ loadItems: tabbed(), tabs: TABS, disabled: true });

    await expect.element(option("Marketing")).toBeVisible();
    await forceClick(tab("Files"));
    await expect.element(tab("Sites")).toHaveAttribute("aria-selected", "true");
    await expect.element(list()).toHaveAccessibleName("Sites");
  });
});
