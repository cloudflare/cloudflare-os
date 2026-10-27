// The runtime in Chromium, on preact/compat: what the host is told about readiness, what it may
// collect, and the controls a module renders, under real pointer and keyboard input.

import { act } from "preact/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type {
  ConfiguratorUIHierarchyItem,
  ConfiguratorUIHierarchyPage,
  ConfiguratorUIOption,
  ConfiguratorUISpec,
  HierarchyPickerProps,
} from "../index.ts";
import { Autocomplete } from "./Autocomplete.tsx";
import { Button } from "./Button.tsx";
import { CheckboxList } from "./CheckboxList.tsx";
import { ConfiguratorRoot } from "./ConfiguratorRoot.tsx";
import { Field } from "./Field.tsx";
import { HierarchyPicker } from "./HierarchyPicker.tsx";
import { Notice } from "./Notice.tsx";
import { RadioCards } from "./RadioCards.tsx";
import { collectResourceUrl, createSession, type ConfiguratorSession } from "./session.ts";
import { createConfiguratorStore } from "./store.ts";

type Spec = ConfiguratorUISpec<null>;

const deferred = <T,>() => Promise.withResolvers<T>();

let root: Root | undefined;
let container: HTMLElement | undefined;

const mount = async (spec: Spec, queries: Record<string, string> = {}) => {
  const setSelectionReady = vi.fn<(ready: boolean) => void>();
  const session: ConfiguratorSession = createSession(
    { spec, ui: null, store: createConfiguratorStore(spec.initial, queries), ensureResources: vi.fn() },
    setSelectionReady);
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(() => root!.render(<ConfiguratorRoot session={session} />));
  return {
    session,
    readiness: () => setSelectionReady.mock.calls.map(([ready]) => ready),
    values: () => session.store.getState().values,
  };
};

const tools = Array.from({ length: 12 }, (_, index) => ({ value: `tool-${index}`, title: `Tool ${index}` }));

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

const Broken = ({ broken }: { broken: boolean }) => {
  if (broken) throw new Error("component failure");
  return <p>Fine</p>;
};

describe("readiness", () => {
  it("reports ready once rendered when the module has no readiness predicate", async () => {
    const { readiness } = await mount({ initial: {}, resourceUrl: () => "https://example.com/", render: () => <p>Hi</p> });
    expect(readiness()).toEqual([true]);
  });

  it("follows the predicate, and is never ready when the first render fails", async () => {
    const { readiness, session } = await mount({
      initial: { name: null },
      isReady: ({ values }) => Boolean(values.name),
      resourceUrl: () => "https://example.com/",
      render: () => <p>Hi</p>,
    });
    expect(readiness()).toEqual([false]);
    await act(() => session.store.setValues({ name: "x" }));
    expect(readiness()).toEqual([false, true]);

    vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => root?.unmount());
    const failing = await mount({
      initial: {},
      resourceUrl: () => "https://example.com/",
      render: () => { throw new Error("first render failure"); },
    });
    expect(failing.readiness()).toEqual([false]);
    // The notice shows the error's whole stack.
    await expect.element(page.getByText("first render failure", { exact: false })).toBeVisible();
  });

  it("keeps the last good form on screen when a later render fails, and recovers with it", async () => {
    const { readiness, session } = await mount({
      initial: { fail: null },
      resourceUrl: () => "https://example.com/",
      render: ({ values, setValues }) => {
        if (values.fail) throw new Error("state-driven failure");
        return <button type="button" onClick={() => setValues({ fail: "yes" })}>Break</button>;
      },
    });
    await userEvent.click(page.getByRole("button", { name: "Break" }));
    expect(readiness()).toEqual([true, false]);
    await expect.element(page.getByRole("button", { name: "Break" })).toBeVisible();
    await expect(collectResourceUrl(session)).rejects.toThrow(/failed to render its current state/i);

    await act(() => session.store.setValues({ fail: null }));
    expect(readiness()).toEqual([true, false, true]);
    await expect(collectResourceUrl(session)).resolves.toBe("https://example.com/");
  });

  it("withdraws readiness while a runtime component throws on what the module gave it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { readiness, session } = await mount({
      initial: { broken: null },
      resourceUrl: () => "https://example.com/",
      render: ({ values }) => <Broken broken={Boolean(values.broken)} />,
    });
    await act(() => session.store.setValues({ broken: "yes" }));
    await expect.element(page.getByText("component failure", { exact: false })).toBeVisible();
    expect(readiness().at(-1)).toBe(false);
    await expect(collectResourceUrl(session)).rejects.toThrow(/failed to render its current state/i);

    await act(() => session.store.setValues({ broken: null }));
    await expect.element(page.getByText("Fine")).toBeVisible();
    expect(readiness().at(-1)).toBe(true);
  });

  // The host reports the viewport on every frame its modal scrolls; none of it reaches the module.
  it("neither re-renders the module nor re-reports readiness for what only the controls read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const render = vi.fn<Spec["render"]>(({ values }) => <Broken broken={Boolean(values.broken)} />);
    const { readiness, session } = await mount({ initial: { broken: "yes" }, resourceUrl: () => "https://example.com/", render });
    await expect.element(page.getByText("component failure", { exact: false })).toBeVisible();
    const posted = readiness();

    for (const iframeTop of [10, 20, 30]) {
      await act(() => session.store.setViewport({ iframeTop, viewportHeight: 800 }));
    }
    await act(() => session.store.requestPopupClose());
    expect(readiness()).toEqual(posted);
    expect(render).toHaveBeenCalledOnce();
  });
});

const checkboxSpec = (loadOptions: () => Promise<ConfiguratorUIOption[]>, disabled = false): Spec => ({
  initial: { tools: null },
  resourceUrl: () => "https://example.com/",
  render: ({ values, setValues }) => (
    <Field label="Tools">
      <CheckboxList name="tools" value={values.tools} disabled={disabled} loadOptions={loadOptions}
        onChange={next => setValues({ tools: next })} />
    </Field>
  ),
});

/** A CheckboxList whose options, and so its name, depend on the chosen server. */
const serverToolsSpec = (load: (server: string) => Promise<ConfiguratorUIOption[]>): Spec => ({
  initial: { server: "a", tools: null },
  resourceUrl: () => "https://example.com/",
  render: ({ values, setValues }) => (
    <Field label="Tools">
      <CheckboxList name={`tools:${values.server}`} value={values.tools}
        loadOptions={() => load(values.server!)} onChange={next => setValues({ tools: next })} />
    </Field>
  ),
});

describe("CheckboxList", () => {
  it("selects in the options' order and offers bulk actions on what is shown", async () => {
    const { values } = await mount(checkboxSpec(async () => tools));
    await userEvent.click(page.getByRole("checkbox", { name: "Tool 3", exact: true }));
    await userEvent.click(page.getByRole("checkbox", { name: "Tool 1", exact: true }));
    expect(values().tools).toBe("tool-1,tool-3");
    await expect.element(page.getByText("2 of 12 selected")).toBeVisible();

    await userEvent.fill(page.getByRole("searchbox", { name: "Filter options" }), "Tool 1");
    await userEvent.click(page.getByRole("button", { name: "Select 3 shown" }));
    expect(values().tools).toBe("tool-1,tool-3,tool-10,tool-11");
    await userEvent.click(page.getByRole("button", { name: "Clear 3 shown" }));
    expect(values().tools).toBe("tool-3");
  });

  it("names an option by its title, describes it by the rest, and toggles it from anywhere on its row", async () => {
    const { values } = await mount(checkboxSpec(async () => [
      { value: "search", title: "Search issues", subtitle: "Find issues by text.", meta: "read-only" },
      { value: "create", title: "Create issue", meta: "needs approval" },
    ]));
    await expect.element(page.getByRole("checkbox", { name: "Search issues", exact: true }))
      .toHaveAccessibleDescription("Find issues by text. read-only");
    await userEvent.click(page.getByText("Find issues by text."));
    expect(values().tools).toBe("search");
    await userEvent.click(page.getByText("needs approval"));
    expect(values().tools).toBe("search,create");
  });

  // Partly selected, so an enabled list would offer both Select all and Clear.
  it("offers no way to change the selection while disabled", async () => {
    await mount({ ...checkboxSpec(async () => tools, true), initial: { tools: "tool-1" } });
    await expect.element(page.getByText("1 of 12 selected")).toBeVisible();
    await expect.element(page.getByRole("checkbox", { name: "Tool 1", exact: true })).toBeDisabled();
    expect(page.getByRole("button", { name: "Select all" }).elements()).toEqual([]);
    expect(page.getByRole("button", { name: "Clear" }).elements()).toEqual([]);
  });

  it("blocks readiness and collection while its options failed to load, unless it is disabled", async () => {
    const options = deferred<ConfiguratorUIOption[]>();
    const { readiness, session } = await mount(checkboxSpec(() => options.promise));
    options.reject(new Error("options unavailable"));
    await expect.element(page.getByText("options unavailable")).toBeVisible();
    expect(readiness()).toEqual([true, false]);
    await expect(collectResourceUrl(session)).rejects.toThrow(/options did not load/i);

    act(() => root?.unmount());
    const disabled = await mount(checkboxSpec(() => Promise.reject(new Error("offline")), true));
    await expect.element(page.getByText("offline")).toBeVisible();
    expect(disabled.readiness()).toEqual([true]);
  });

  it("keeps each name's options for the life of the frame, and retries a failed load", async () => {
    let serverBFails = true;
    const load = vi.fn(async (server: string) => {
      if (server === "b" && serverBFails) {
        serverBFails = false;
        throw new Error("b unavailable");
      }
      return tools;
    });
    const { readiness, session } = await mount(serverToolsSpec(load));
    const tool = page.getByRole("checkbox", { name: "Tool 1", exact: true });
    await expect.element(tool).toBeVisible();
    await act(() => session.store.setValues({ server: "b" }));
    await expect.element(page.getByText("b unavailable")).toBeVisible();

    await act(() => session.store.setValues({ server: "a" }));
    expect(page.getByText("Loading...").elements()).toEqual([]);
    await expect.element(tool).toBeVisible();
    const before = readiness().length;
    await act(() => session.store.setValues({ server: "b" }));
    await expect.element(tool).toBeVisible();
    expect(load.mock.calls).toEqual([["a"], ["b"], ["b"]]);
    // The retry starts clean: the old failure never comes back to withdraw readiness.
    expect(readiness().slice(before)).not.toContain(false);
  });

  it("shares a load still in flight when its name comes back", async () => {
    const pending = deferred<ConfiguratorUIOption[]>();
    const load = vi.fn((server: string) => server === "a" ? pending.promise : Promise.resolve(tools));
    const { session } = await mount(serverToolsSpec(load));
    await act(() => session.store.setValues({ server: "b" }));
    await act(() => session.store.setValues({ server: "a" }));
    pending.resolve(tools);
    await expect.element(page.getByRole("checkbox", { name: "Tool 1", exact: true })).toBeVisible();
    expect(load.mock.calls).toEqual([["a"], ["b"]]);
  });

  // Preact runs effects a frame after it renders, and a load can settle in between.
  it("shows a load in flight that settles between its name's render and effect", async () => {
    const pending = deferred<ConfiguratorUIOption[]>();
    const load = vi.fn((server: string) => server === "a" ? pending.promise : Promise.resolve(tools));
    const { session } = await mount(serverToolsSpec(load));
    await act(() => session.store.setValues({ server: "b" }));
    await expect.element(page.getByRole("checkbox", { name: "Tool 1", exact: true })).toBeVisible();

    // Outside act, which would run the effect before the load could settle.
    session.store.setValues({ server: "a" });
    await Promise.resolve();
    expect(page.getByText("Loading...").elements()).toHaveLength(1);
    pending.resolve(tools);
    await expect.element(page.getByRole("checkbox", { name: "Tool 1", exact: true })).toBeVisible();
  });

  it("starts a list with a new name unfiltered, and gives a name it had before its filter back", async () => {
    const { session } = await mount(serverToolsSpec(async server => tools.map(tool => ({ ...tool, title: `${server} ${tool.title}` }))));
    const filter = page.getByRole("searchbox", { name: "Filter options" });
    await userEvent.fill(filter, "a Tool 1");
    await act(() => session.store.setValues({ server: "b" }));
    await expect.element(filter).toHaveValue("");
    await expect.element(page.getByRole("checkbox", { name: "b Tool 11", exact: true })).toBeVisible();

    await act(() => session.store.setValues({ server: "a" }));
    await expect.element(filter).toHaveValue("a Tool 1");
    await expect.element(page.getByRole("button", { name: "Select 3 shown" })).toBeVisible();
  });
});

describe("RadioCards", () => {
  it("names the group after its field and each card after its own title", async () => {
    await mount({
      initial: { mode: "all" },
      resourceUrl: () => "https://example.com/",
      render: ({ values, setValues }) => (
        <Field label="Tools">
          <RadioCards value={values.mode} onChange={mode => setValues({ mode })} options={[
            { value: "all", title: "All tools", description: "Every tool." },
            { value: "choose", title: "Choose tools", description: "Only the ones ticked." },
          ]} />
        </Field>
      ),
    });
    await expect.element(page.getByRole("radiogroup", { name: "Tools" })).toBeVisible();
    await expect.element(page.getByRole("radio", { name: /^All tools/ })).toBeChecked();
    await userEvent.click(page.getByText("Choose tools"));
    await expect.element(page.getByRole("radio", { name: /^Choose tools/ })).toBeChecked();
  });
});

const autocompleteSpec = (loadOptions: (query: string) => Promise<ConfiguratorUIOption[]>, onClear?: () => void): Spec => ({
  initial: { folderId: null },
  resourceUrl: () => "https://example.com/",
  render: ({ values, setValues }) => (
    <Field label="Folder">
      <Autocomplete name="folderId" value={values.folderId} placeholder="Search folders..."
        loadOptions={loadOptions} onClear={onClear} onChange={next => setValues({ folderId: next })} />
    </Field>
  ),
});
/**
 * Picks as the Google configurators do: withdraws the old value, then sets the new one once the
 * pick's (here simulated) inspection settles, so one pick renders the field twice.
 */
const inspectingSpec = (loadOptions: (query: string) => Promise<ConfiguratorUIOption[]>): Spec => ({
  initial: { folderId: null, inspected: null },
  resourceUrl: () => "https://example.com/",
  render: ({ values, setValues }) => (
    <div>
      <Field label="Folder">
        <Autocomplete name="folderId" value={values.folderId} placeholder="Search folders..."
          loadOptions={loadOptions}
          onChange={folderId => {
            setValues({ folderId: null, inspected: null });
            if (folderId) void Promise.resolve().then(() => setValues({ folderId, inspected: folderId }));
          }} />
      </Field>
      {values.inspected ? <p>{`Inspected ${values.inspected}`}</p> : null}
    </div>
  ),
});
const folders = async (query: string) => ["Projects", "Proposals", "Personal"]
  .filter(title => title.toLowerCase().includes(query.toLowerCase()))
  .map(title => ({ value: title.toLowerCase(), title, subtitle: "My Drive" }));
const input = () => page.getByRole("combobox", { name: "Folder" });

describe("Autocomplete", () => {
  it("searches as the user types and selects with the keyboard", async () => {
    const loadOptions = vi.fn(folders);
    const { values } = await mount(autocompleteSpec(loadOptions));
    await userEvent.click(input());
    await userEvent.keyboard("pro");
    await expect.element(page.getByRole("option", { name: /Proposals/ })).toBeVisible();
    expect(loadOptions).toHaveBeenLastCalledWith("pro");
    await expect.element(page.getByRole("option", { name: /Personal/ })).not.toBeInTheDocument();

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(values().folderId).toBe("proposals");
    await expect.element(input()).toHaveValue("Proposals");
  });

  it("searches for what was typed into a closed field", async () => {
    const loadOptions = vi.fn(folders);
    await mount(autocompleteSpec(loadOptions));
    await userEvent.tab();
    await userEvent.keyboard("x");
    // Filtered by text, since the form's notice announcer is a status too.
    await expect.element(page.getByRole("status").filter({ hasText: "No matches." })).toBeVisible();
    expect(loadOptions).toHaveBeenLastCalledWith("x");
  });

  // The debounce delays the next request, not the withdrawal of the last one's answer: otherwise a
  // quick Enter picks a stale option, and a late reply to an earlier query reappears.
  it("withdraws earlier results as soon as the user types, even if they arrive later", async () => {
    const requests = new Map<string, PromiseWithResolvers<ConfiguratorUIOption[]>>();
    const loadOptions = vi.fn((query: string) => {
      const request = deferred<ConfiguratorUIOption[]>();
      requests.set(query, request);
      return request.promise;
    });
    await mount(autocompleteSpec(loadOptions));
    await userEvent.click(input());
    await expect.poll(() => requests.has("")).toBe(true);

    await userEvent.keyboard("pro");
    await act(async () => requests.get("")!.resolve(await folders("")));
    expect(requests.has("pro")).toBe(false);
    expect(page.getByRole("option").elements()).toEqual([]);
    await expect.element(page.getByRole("status").filter({ hasText: "Loading..." })).toBeVisible();

    await expect.poll(() => requests.has("pro")).toBe(true);
    await act(async () => requests.get("pro")!.resolve(await folders("pro")));
    await expect.element(page.getByRole("option", { name: /Proposals/ })).toBeVisible();
    await expect.element(page.getByRole("option", { name: /Personal/ })).not.toBeInTheDocument();
  });

  it("abandons a choice when the user types over it, and clears through onClear", async () => {
    const onClear = vi.fn();
    const { values, session } = await mount(autocompleteSpec(folders, onClear));
    await userEvent.click(input());
    await userEvent.click(page.getByRole("option", { name: /Projects/ }));
    expect(values().folderId).toBe("projects");

    await userEvent.type(input(), "x");
    expect(values().folderId).toBeNull();

    await act(() => session.store.setValues({ folderId: "projects" }));
    await userEvent.click(page.getByRole("button", { name: "Clear selection" }));
    expect(onClear).toHaveBeenCalledOnce();
    await expect.element(input()).toHaveValue("");
  });

  // Base UI keeps the popup open when its clear button empties the input.
  it("lists everything again when a choice is cleared with the popup open", async () => {
    const loadOptions = vi.fn(folders);
    await mount(autocompleteSpec(loadOptions));
    await userEvent.click(input());
    await userEvent.click(page.getByRole("option", { name: /Projects/ }));
    await userEvent.click(input());
    await expect.element(page.getByRole("option", { name: /Proposals/ })).not.toBeInTheDocument();

    // Not by role: while the popup is open, Base UI hides everything outside it from the a11y tree.
    await userEvent.click(page.elementLocator(document.querySelector('[aria-label="Clear selection"]')!));
    await expect.element(page.getByRole("option", { name: /Proposals/ })).toBeVisible();
    expect(loadOptions).toHaveBeenLastCalledWith("");
  });

  it("shows a pre-filled value as typed text until it has a title", async () => {
    const spec = autocompleteSpec(folders);
    spec.initial = { folderId: "F1" };
    await mount(spec, { folderId: "F1" });
    await expect.element(input()).toHaveValue("F1");
  });

  it("keeps focus and stays closed when a pick renders the field twice", async () => {
    const loadOptions = vi.fn(folders);
    await mount(inspectingSpec(loadOptions));
    await userEvent.click(input());
    await userEvent.click(page.getByRole("option", { name: /Projects/ }));
    await expect.element(page.getByText("Inspected projects")).toBeVisible();
    await expect.element(input()).toHaveFocus();
    await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
    expect(loadOptions).toHaveBeenCalledOnce();
  });

  it("lists suggestions for what is typed over a pick that renders the field twice", async () => {
    const loadOptions = vi.fn(folders);
    await mount(inspectingSpec(loadOptions));
    await userEvent.click(input());
    await userEvent.click(page.getByRole("option", { name: /Projects/ }));
    await expect.element(page.getByText("Inspected projects")).toBeVisible();

    await userEvent.fill(input(), "Pro");
    await expect.element(page.getByText("Inspected projects")).not.toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: /Proposals/ })).toBeVisible();
    expect(loadOptions).toHaveBeenLastCalledWith("Pro");
  });

  // Preact runs effects a frame after it renders, and a click can land in between.
  it("keeps the focus it was given before its first effects ran", async () => {
    const spec = autocompleteSpec(folders);
    const session = createSession(
      { spec, ui: null, store: createConfiguratorStore(spec.initial), ensureResources: vi.fn() }, () => {});
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    // Outside act, which would run the effects at once.
    root.render(<ConfiguratorRoot session={session} />);
    const field = input().element() as HTMLInputElement;
    field.focus();
    // Preact flushes effects in a task its next animation frame queues; this one is queued after it.
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));
    expect(document.activeElement).toBe(field);
  });
});

describe("Button", () => {
  const buttonSpec: Spec = {
    initial: { clicks: "0", started: null, finished: null },
    resourceUrl: () => "https://example.com/",
    render: ({ values, setValues }) => (
      <div>
        <Button onClick={() => setValues({ clicks: String(Number(values.clicks) + 1) })}>Count</Button>
        <Button variant="secondary" disabled onClick={() => setValues({ clicks: "disabled" })}>Use the copy</Button>
        <Button disabled={Boolean(values.started)} onClick={() => setValues({ started: "yes" })}>Start</Button>
        {values.finished ? null : <Button variant="secondary" onClick={() => setValues({ finished: "yes" })}>Finish</Button>}
        <p>{`Clicks: ${values.clicks}`}</p>
      </div>
    ),
  };
  const button = (name: string) => page.getByRole("button", { name, exact: true });

  it("ignores activation while disabled, and stays focusable", async () => {
    await mount(buttonSpec);
    await userEvent.click(button("Count"));
    await userEvent.tab();
    await expect.element(button("Use the copy")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("Clicks: 1")).toBeVisible();
  });

  it("keeps focus on a Button that disables itself", async () => {
    await mount(buttonSpec);
    await userEvent.click(button("Start"));
    await expect.element(button("Start")).toHaveAttribute("aria-disabled", "true");
    await expect.element(button("Start")).toHaveFocus();
  });

  it("hands focus to the first control left when the focused Button leaves the form", async () => {
    await mount(buttonSpec);
    await userEvent.click(button("Finish"));
    await expect.element(button("Finish")).not.toBeInTheDocument();
    await expect.element(button("Count")).toHaveFocus();
  });

  it("hands focus on from a Button that leaves the form when clicked before the first effects ran", async () => {
    const session = createSession(
      { spec: buttonSpec, ui: null, store: createConfiguratorStore(buttonSpec.initial), ensureResources: vi.fn() },
      () => {});
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    // Outside act, which would run the effects at once.
    root.render(<ConfiguratorRoot session={session} />);
    const finish = button("Finish").element() as HTMLElement;
    finish.focus();
    finish.click();
    await expect.element(button("Count")).toHaveFocus();
  });
});

describe("HierarchyPicker", () => {
  it("leaves the focus a navigation lost to the picker, which takes it into the next listing", async () => {
    const tree: Record<string, ConfiguratorUIHierarchyItem[]> = {
      drive: [{ id: "reports", title: "Reports", kind: "container" }],
      reports: [{ id: "q1", title: "Q1.pdf", kind: "leaf" }],
    };
    const { values } = await mount({
      initial: { target: null },
      resourceUrl: () => "https://example.com/",
      render: ({ values: { target = null }, setValues }) => (
        <HierarchyPicker
          name="target"
          value={target}
          root={{ id: "drive", title: "My Drive", selectable: true }}
          loadItems={async ({ parentId }) => ({ items: tree[parentId] ?? [] })}
          onChange={next => setValues({ target: next })}
        />
      ),
    });
    const option = (name: string) => page.getByRole("option", { name, exact: false });

    await userEvent.click(option("Reports"));
    await userEvent.click(option("Q1.pdf"));
    // Going up lets go of the choice, which renders the whole form without the focused row.
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(option("Reports")).toHaveFocus();
    expect(values().target).toBeNull();
  });

  const q1: ConfiguratorUIHierarchyItem = {
    id: "q1", title: "Q1.pdf", kind: "leaf", path: [{ id: "reports", title: "Reports" }],
  };

  /** A module whose picker opens on `q1`, pre-filled, and that is ready whenever it holds a value. */
  const prefilledPicker = (source: Pick<HierarchyPickerProps, "loadItem" | "loadItems">): Spec => ({
    initial: { target: "q1" },
    isReady: ({ values }) => Boolean(values.target),
    resourceUrl: ({ values }) => `https://example.com/${values.target}`,
    render: ({ values: { target = null }, setValues }) => (
      <HierarchyPicker
        {...source}
        name="target"
        value={target}
        root={{ id: "drive", title: "My Drive" }}
        onChange={next => setValues({ target: next })}
      />
    ),
  });

  it("withholds readiness and collection until a pre-filled value is shown", async () => {
    const lookup = deferred<ConfiguratorUIHierarchyItem | null>();
    const listing = deferred<ConfiguratorUIHierarchyPage>();
    const { session, readiness } = await mount(prefilledPicker({
      loadItem: () => lookup.promise,
      loadItems: () => listing.promise,
    }));

    expect(readiness()).toEqual([false]);
    await expect(collectResourceUrl(session)).rejects.toThrow(/not showing its choice/i);
    // Found, but not yet in view: its folder is still listing.
    await act(() => lookup.resolve(q1));
    await expect.element(page.getByRole("listbox", { name: "Reports" })).toBeInTheDocument();
    await expect(collectResourceUrl(session)).rejects.toThrow(/not showing its choice/i);
    await act(() => listing.resolve({ items: [q1] }));
    await expect.poll(readiness).toEqual([false, true]);
    await expect(collectResourceUrl(session)).resolves.toBe("https://example.com/q1");
  });

  it("keeps withholding a pre-filled value whose folder fails to list", async () => {
    const { session, readiness } = await mount(prefilledPicker({
      loadItem: async () => q1,
      loadItems: async () => { throw new Error("Drive is down."); },
    }));

    await expect.element(page.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(readiness()).toEqual([false]);
    await expect(collectResourceUrl(session)).rejects.toThrow(/not showing its choice/i);
  });
});

describe("Notice", () => {
  it("announces the last info notice through one live region, once per change", async () => {
    const { session } = await mount({
      initial: { step: null, unrelated: null, failure: null },
      resourceUrl: () => "https://example.com/",
      render: ({ values }) => (
        <div>
          <Notice>Connecting makes a copy.</Notice>
          {values.step === "converting" ? <Notice>Making the copy…</Notice> : null}
          {values.failure ? <Notice tone="error">{values.failure}</Notice> : null}
        </div>
      ),
    });
    const status = page.getByRole("status");
    await expect.element(status).toHaveAttribute("aria-live", "polite");
    await expect.element(status).toHaveTextContent("Connecting makes a copy.");
    const region = status.element();
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    try {
      await act(() => session.store.setValues({ unrelated: "changed" }));
      expect(mutations).toEqual([]);

      await act(() => session.store.setValues({ step: "converting" }));
      await expect.element(status).toHaveTextContent("Making the copy…");
      expect(status.element()).toBe(region);
      expect(mutations).not.toEqual([]);

      await act(() => session.store.setValues({ step: null, failure: "The user closed the pop-up." }));
      await expect.element(status).toHaveTextContent("Connecting makes a copy.");
      await expect.element(page.getByRole("alert")).toHaveTextContent("The user closed the pop-up.");
    } finally {
      observer.disconnect();
    }
  });

  it("carries one action, which disabled keeps focus and ignores clicks, and announces only the message", async () => {
    const onClick = vi.fn();
    const { session } = await mount({
      initial: { busy: null, failure: null },
      resourceUrl: () => "https://example.com/",
      render: ({ values }) => (
        <div>
          <Notice action={{ label: "Allow access", onClick, disabled: values.busy === "yes" }}>
            Listing needs one more permission.
          </Notice>
          {values.failure ? <Notice tone="error" action={{ label: "Try again", onClick }}>{values.failure}</Notice> : null}
        </div>
      ),
    });
    const allow = page.getByRole("button", { name: "Allow access" });

    await userEvent.click(allow);
    expect(onClick).toHaveBeenCalledOnce();
    await act(() => session.store.setValues({ busy: "yes" }));
    await expect.element(allow).toHaveAttribute("aria-disabled", "true");
    await expect.element(allow).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("status")).toHaveTextContent("Listing needs one more permission.");
    expect(page.getByRole("status").element().textContent).not.toContain("Allow access");

    await act(() => session.store.setValues({ failure: "The pop-up was blocked." }));
    await expect.element(page.getByRole("alert")).toHaveTextContent("The pop-up was blocked.");
    expect(page.getByRole("alert").element().textContent).not.toContain("Try again");
    await userEvent.click(page.getByRole("button", { name: "Try again" }));
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});
