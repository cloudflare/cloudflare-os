import { describe, expect, it, vi } from "vitest";
import type { ConfiguratorUISpec } from "../index.ts";
import { collectResourceUrl, createSession } from "./session.ts";
import { createConfiguratorStore } from "./store.ts";

const deferred = <T,>() => Promise.withResolvers<T>();

const session = (resourceUrl: ConfiguratorUISpec<null>["resourceUrl"]) => createSession({
  spec: { initial: {}, resourceUrl, render: () => null },
  ui: null,
  store: createConfiguratorStore({ folderId: "F1" }, { folderId: "Reports" }),
}, vi.fn());

describe("collectResourceUrl", () => {
  it("returns what the module builds from the values on screen", async () => {
    const running = session(({ values }) => `https://example.com/${values.folderId}`);
    await expect(collectResourceUrl(running)).resolves.toBe("https://example.com/F1");
  });

  it("refuses while the screen cannot be trusted to show what would be collected", async () => {
    const running = session(() => "https://example.com/");
    running.renderFailed = true;
    await expect(collectResourceUrl(running)).rejects.toThrow(/failed to render its current state/i);
    running.renderFailed = false;
    running.treeFailed = true;
    await expect(collectResourceUrl(running)).rejects.toThrow(/failed to render its current state/i);
    running.treeFailed = false;
    running.store.setListFailed("tools", true);
    await expect(collectResourceUrl(running)).rejects.toThrow(/options did not load/i);
  });

  it("refuses when the values change or rendering fails while the URL is being built", async () => {
    const url = deferred<string>();
    const changed = session(() => url.promise);
    const collecting = collectResourceUrl(changed);
    changed.store.setValues({ folderId: "F2" });
    url.resolve("https://example.com/F1");
    await expect(collecting).rejects.toThrow(/changed while its resource URL was being collected/i);

    const failing = session(() => url.promise);
    const collectingFailed = collectResourceUrl(failing);
    failing.renderFailed = true;
    await expect(collectingFailed).rejects.toThrow(/failed to render its current state/i);
  });

  it("refuses an empty URL", async () => {
    await expect(collectResourceUrl(session(() => ""))).rejects.toThrow(/did not provide a resource URL/i);
  });
});

describe("store", () => {
  // Configurators rely on this: a dependent Autocomplete must also be nulled through `setValues`.
  it("clears a field's typed text but not its value", () => {
    const store = createConfiguratorStore({ folderId: "F1" }, { folderId: "Reports" });
    store.clearFields("folderId");
    expect(store.getState().values).toEqual({ folderId: "F1" });
    expect(store.getState().queries).toEqual({});
  });

  // A configurator calls `setValues({})` to re-render after state it keeps itself has changed.
  it("notifies on an empty update", () => {
    const store = createConfiguratorStore({});
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getState().values;
    store.setValues({});
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getState().values).not.toBe(before);
  });
});

describe("readiness", () => {
  it("combines every input, whichever changes last, and reaches the host once per change", () => {
    const setSelectionReady = vi.fn();
    const running = createSession({
      spec: { initial: {}, resourceUrl: () => "", render: () => null },
      ui: null,
      store: createConfiguratorStore({}),
    }, setSelectionReady);
    running.moduleReady = true;
    running.postReadiness();
    running.postReadiness();
    running.treeFailed = true;
    running.postReadiness();
    running.treeFailed = false;
    running.store.setListFailed("tools", true);
    running.postReadiness();
    running.store.setListFailed("tools", false);
    running.postReadiness();
    expect(setSelectionReady.mock.calls).toEqual([[true], [false], [true]]);
  });
});
