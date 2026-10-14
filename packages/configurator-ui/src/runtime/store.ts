import type { ConfiguratorUIValues } from "../index.ts";

/** Where the frame sits in the host's viewport, as the host last reported it. */
export type ParentViewport = { iframeTop: number; viewportHeight: number };

/** Everything the runtime renders from. Replaced, never mutated, on every change. */
export type ConfiguratorState = Readonly<{
  values: ConfiguratorUIValues;
  /**
   * The text each Autocomplete shows, by field name. Kept apart from `values` so that typing does not
   * become a value, and so `clearFields` can drop it without touching the value.
   */
  queries: Readonly<Record<string, string>>;
  /** Enabled CheckboxLists whose options failed to load; any one blocks collection. */
  failedLists: ReadonlySet<string>;
  viewport: ParentViewport;
  /** Bumped when the host window resizes or focus leaves the frame, closing any open popup. */
  popupCloseRequests: number;
}>;

/** The external store behind a configurator: one per frame. */
export type ConfiguratorStore = {
  getState(): ConfiguratorState;
  subscribe(listener: () => void): () => void;
  setValues(patch: Partial<ConfiguratorUIValues>): void;
  clearFields(...names: string[]): void;
  setQuery(name: string, query: string): void;
  setListFailed(name: string, failed: boolean): void;
  setViewport(viewport: ParentViewport): void;
  requestPopupClose(): void;
};

export const createConfiguratorStore = (
  initialValues: ConfiguratorUIValues,
  initialQueries: Record<string, string> = {},
): ConfiguratorStore => {
  let state: ConfiguratorState = {
    values: { ...initialValues },
    queries: { ...initialQueries },
    failedLists: new Set(),
    viewport: { iframeTop: 0, viewportHeight: 0 },
    popupCloseRequests: 0,
  };
  const listeners = new Set<() => void>();
  const update = (next: Partial<ConfiguratorState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Always a fresh object, even for an empty patch: a configurator calls `setValues({})` to
    // re-render after module-level state it keeps itself has changed.
    setValues: patch => update({ values: { ...state.values, ...patch } }),
    clearFields(...names) {
      const queries = { ...state.queries };
      for (const name of names.flat()) delete queries[name];
      update({ queries });
    },
    setQuery(name, query) {
      if (state.queries[name] === query) return;
      update({ queries: { ...state.queries, [name]: query } });
    },
    setListFailed(name, failed) {
      if (state.failedLists.has(name) === failed) return;
      const failedLists = new Set(state.failedLists);
      if (failed) failedLists.add(name);
      else failedLists.delete(name);
      update({ failedLists });
    },
    setViewport: viewport => update({ viewport }),
    requestPopupClose: () => update({ popupCloseRequests: state.popupCloseRequests + 1 }),
  };
};
