// The hierarchy picker in Chromium, on preact/compat: real pointer and keyboard input and focus.
// Covers what the selection becomes on each of the user's moves (and that nothing else changes it),
// pre-fill, paging, search, and what it does with a misbehaving source.

import { FileIcon, FolderIcon } from "@phosphor-icons/react";
import { act } from "preact/test-utils";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type {
  ConfiguratorUIHierarchyItem,
  ConfiguratorUIHierarchyPage,
  ConfiguratorUIHierarchyRequest,
  HierarchyPickerProps,
} from "../index.ts";
import { HierarchyPicker } from "./HierarchyPicker.tsx";

type Item = ConfiguratorUIHierarchyItem;
type LoadItems = (request: ConfiguratorUIHierarchyRequest) => Promise<ConfiguratorUIHierarchyPage>;

const ROOT = { id: "drive", title: "My Drive", selectable: true };

const reports: Item = { id: "reports", title: "Reports", kind: "container" };
const shared: Item = { id: "shared", title: "Shared with me", kind: "container", selectable: false };
const budget: Item = { id: "budget", title: "Budget.xlsx", kind: "leaf", meta: "Mar 3" };
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

type HarnessProps = Omit<HierarchyPickerProps, "value" | "onChange" | "name" | "root"> & {
  initial?: string | null;
  onChange: HierarchyPickerProps["onChange"];
  root?: HierarchyPickerProps["root"];
};

/** The picker as a configurator holds it: its value follows `onChange`. */
const Harness = ({ initial = null, onChange, root = ROOT, ...props }: HarnessProps) => {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <HierarchyPicker
      {...props}
      name="target"
      root={root}
      value={value}
      onChange={(next, item) => {
        setValue(next);
        onChange(next, item);
      }}
    />
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
const option = (name: string) => page.getByRole("option", { name });
const crumb = (name: string) => page.getByRole("navigation", { name: "Location" }).getByRole("button", { name });
const crumbs = () => page.getByRole("navigation", { name: "Location" });

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe("selection", () => {
  it("selects an opened container when it is selectable, and clears it when it is not", async () => {
    const onChange = await render({ loadItems: source() });

    await userEvent.click(option("Reports"));
    expect(onChange).toHaveBeenLastCalledWith("reports", expect.objectContaining({ id: "reports", title: "Reports" }));
    await expect.element(list()).toHaveAccessibleName("Reports");
    await expect.element(option("Q1.pdf")).toBeVisible();
    await expect.element(crumb("Reports")).toHaveAttribute("aria-current", "location");

    await userEvent.click(crumb("My Drive"));
    expect(onChange).toHaveBeenLastCalledWith("drive",
      { id: "drive", title: "My Drive", kind: "container", selectable: true });
    await userEvent.click(option("Shared with me"));
    expect(onChange).toHaveBeenLastCalledWith(null, null);
    await expect.element(list()).toHaveAccessibleName("Shared with me");
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("narrows to a leaf, and choosing it again returns to what opening the location selected", async () => {
    const onChange = await render({ loadItems: source() });

    await userEvent.click(option("Budget.xlsx"));
    expect(onChange).toHaveBeenLastCalledWith("budget", expect.objectContaining({ id: "budget", kind: "leaf" }));
    await expect.element(option("Budget.xlsx")).toHaveAttribute("aria-selected", "true");
    // The root is selectable but was never selected, so unchoosing clears rather than widening to it.
    await userEvent.click(option("Budget.xlsx"));
    expect(onChange).toHaveBeenLastCalledWith(null, null);
    await expect.element(option("Budget.xlsx")).toHaveAttribute("aria-selected", "false");

    // An unselectable leaf does nothing.
    await expect.element(option("Locked.doc")).toHaveAttribute("aria-disabled", "true");
    await forceClick(option("Locked.doc"));
    expect(onChange).toHaveBeenCalledTimes(2);

    await userEvent.click(option("Reports"));
    await userEvent.click(option("Q1.pdf"));
    expect(onChange).toHaveBeenLastCalledWith("q1", expect.objectContaining({ id: "q1" }));
    await userEvent.click(option("Q1.pdf"));
    expect(onChange).toHaveBeenLastCalledWith("reports",
      { id: "reports", title: "Reports", kind: "container", selectable: true });
    await expect.element(crumb("Reports")).toHaveAccessibleName("Reports, selected");
  });

  it("navigates and selects through the breadcrumb", async () => {
    const loadItems = source();
    const onChange = await render({ loadItems });

    await userEvent.click(option("Reports"));
    await userEvent.click(option("Archive"));
    await expect.element(option("Old.pdf")).toBeVisible();
    await expect.element(crumb("Archive")).toHaveAttribute("aria-current", "location");
    await expect.element(crumb("Reports")).not.toHaveAttribute("aria-current");

    await userEvent.click(crumb("Reports"));
    expect(onChange).toHaveBeenLastCalledWith("reports",
      { id: "reports", title: "Reports", kind: "container", selectable: true });
    await expect.element(list()).toHaveAccessibleName("Reports");
    await expect.element(option("Q1.pdf")).toBeVisible();
    expect(crumb("Archive").elements()).toHaveLength(0);
    expect(loadItems).toHaveBeenLastCalledWith({ parentId: "reports", query: "", cursor: null });
  });

  it("never changes the selection while disabled", async () => {
    const onChange = await render({ loadItems: source(), disabled: true, searchPlaceholder: "Search Drive" });

    await expect.element(option("Budget.xlsx")).toBeVisible();
    await forceClick(option("Budget.xlsx"));
    await forceClick(option("Reports"));
    await forceClick(crumb("My Drive"));
    await act(() => {
      option("Reports").element().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await expect.element(crumb("My Drive")).toBeDisabled();
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
    expect(page.getByText(/^Selected:/).elements()).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stays at the root, naming the value, when the lookup fails", async () => {
    const loadItem = vi.fn(async (): Promise<Item | null> => {
      throw new Error("Drive is down.");
    });
    const onChange = await render({ loadItems: source(), loadItem, initial: "q1" });

    await expect.element(page.getByText("Selected: q1")).toBeVisible();
    await expect.element(list()).toHaveAccessibleName("My Drive");
    await expect.element(option("Reports")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("returns to a pre-filled root when the leaf chosen after it is chosen again", async () => {
    const onChange = await render({ loadItems: source(), initial: "drive" });

    await expect.element(crumb("My Drive")).toHaveAccessibleName("My Drive, selected");
    await userEvent.click(option("Budget.xlsx"));
    await userEvent.click(option("Budget.xlsx"));
    expect(onChange).toHaveBeenLastCalledWith("drive",
      { id: "drive", title: "My Drive", kind: "container", selectable: true });
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
    await expect.element(option("2024")).toHaveTextContent("Reports / Archive");
    expect(loadItems).toHaveBeenLastCalledWith({ parentId: "drive", query: "20", cursor: null });
    // The query searched the open location; a listing or a search never selects.
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.click(option("2024"));
    expect(onChange).toHaveBeenLastCalledWith("2024", expect.objectContaining({ id: "2024" }));
    await expect.element(search).toHaveValue("");
    await expect.element(crumbs()).toHaveTextContent(/^My DriveReportsArchive2024/);
    await expect.element(crumb("2024")).toHaveAttribute("aria-current", "location");
    // The breadcrumb renders before the effect that lists the new location runs.
    await expect.poll(() => loadItems.mock.lastCall?.[0])
      .toEqual({ parentId: "2024", query: "", cursor: null });

    // Up a level from a search hit goes to its real parent.
    await userEvent.click(crumb("Archive"));
    await expect.element(option("Old.pdf")).toBeVisible();
  });

  it("does not pretend a container found without a path is a child of the root", async () => {
    const loose: Item = { id: "loose", title: "Loose", kind: "container", subtitle: "Owned by Kim" };
    const onChange = await render({ loadItems: source({ loose: [loose] }), searchPlaceholder: "Search Drive" });
    const search = page.getByRole("searchbox", { name: "Search Drive" });

    await userEvent.fill(search, "loose");
    await expect.element(option("Loose")).toHaveTextContent("Owned by Kim");
    await userEvent.click(option("Loose"));
    expect(onChange).toHaveBeenLastCalledWith("loose", expect.objectContaining({ id: "loose" }));
    await expect.element(crumbs()).toHaveTextContent("My Drive…Loose");
    await expect.element(list()).toHaveAccessibleName("Loose");
  });

  // Choosing a hit selects without opening anything, so unchoosing it returns to what the location had.
  it("clears a leaf found by search when it is chosen again, rather than widening to the location", async () => {
    const hit: Item = { ...q1, path: [{ id: "reports", title: "Reports" }] };
    const onChange = await render({ loadItems: source({ q1: [hit] }), searchPlaceholder: "Search Drive" });

    await userEvent.fill(page.getByRole("searchbox", { name: "Search Drive" }), "q1");
    await userEvent.click(option("Q1.pdf"));
    expect(onChange).toHaveBeenLastCalledWith("q1", expect.objectContaining({ id: "q1" }));
    await userEvent.click(option("Q1.pdf"));
    expect(onChange).toHaveBeenLastCalledWith(null, null);
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
  it("moves with the arrows, opens with Enter and goes up with ArrowLeft, selecting as it goes", async () => {
    const onChange = await render({ loadItems: source() });
    await expect.element(option("Reports")).toBeVisible();

    await userEvent.tab();
    await expect.element(crumb("My Drive")).toHaveFocus();
    await userEvent.tab();
    await expect.element(option("Reports")).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    await expect.element(option("Shared with me")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("reports", expect.objectContaining({ id: "reports" }));
    // Focus follows into the opened container.
    await expect.element(option("Archive")).toHaveFocus();

    await userEvent.keyboard("{End}");
    await expect.element(option("Q1.pdf")).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith("q1", expect.objectContaining({ id: "q1" }));

    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("drive",
      { id: "drive", title: "My Drive", kind: "container", selectable: true });
    await expect.element(list()).toHaveAccessibleName("My Drive");
    await expect.element(option("Reports")).toHaveFocus();
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
