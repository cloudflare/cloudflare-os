// The hierarchy picker in Chromium, on preact/compat: real pointer and keyboard input and focus.
// Covers what the user's choices select, that a choice lasts only while it is in view,
// pre-fill, paging, search, and what it does with a misbehaving source.

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

  it("clears the search with Escape and says when nothing matched", async () => {
    await render({ loadItems: source(), searchPlaceholder: "Search Drive" });
    const search = page.getByRole("searchbox", { name: "Search Drive" });

    await userEvent.fill(search, "nothing");
    await expect.element(page.getByText('No results for "nothing".')).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    await expect.element(option("Reports")).toBeVisible();
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
