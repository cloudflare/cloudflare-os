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
  /**
   * The text typed into each CheckboxList's filter, by list name. Kept for the life of the frame, as
   * the old runtime kept it, so a list shown again under a name it had before keeps its filter.
   */
  filters: Readonly<Record<string, string>>;
  /**
   * The holds fields place on collection, each with its reason, by field name: an enabled
   * CheckboxList whose options failed to load, or a HierarchyPicker whose value is not on screen.
   */
  holds: ReadonlyMap<string, string>;
  viewport: ParentViewport;
}>;

/** The external store behind a configurator: one per frame. */
export type ConfiguratorStore = {
  getState(): ConfiguratorState;
  subscribe(listener: () => void): () => void;
  setValues(patch: Partial<ConfiguratorUIValues>): void;
  clearFields(...names: string[]): void;
  setQuery(name: string, query: string): void;
  setFilter(name: string, filter: string): void;
  /** Places a hold on collection for `name`, giving its reason, or with `null` releases it. */
  setHold(name: string, reason: string | null): void;
  setViewport(viewport: ParentViewport): void;
  /** Closes any open popup: the host window resized, or focus left the frame. */
  requestPopupClose(): void;
  onPopupClose(listener: () => void): () => void;
};

export const createConfiguratorStore = (
  initialValues: ConfiguratorUIValues,
  initialQueries: Record<string, string> = {},
): ConfiguratorStore => {
  let state: ConfiguratorState = {
    values: { ...initialValues },
    queries: { ...initialQueries },
    filters: {},
    holds: new Map(),
    viewport: { iframeTop: 0, viewportHeight: 0 },
  };
  const listeners = new Set<() => void>();
  const popupCloseListeners = new Set<() => void>();
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
    setFilter(name, filter) {
      if (state.filters[name] === filter) return;
      update({ filters: { ...state.filters, [name]: filter } });
    },
    setHold(name, reason) {
      if ((state.holds.get(name) ?? null) === reason) return;
      const holds = new Map(state.holds);
      if (reason === null) holds.delete(name);
      else holds.set(name, reason);
      update({ holds });
    },
    setViewport: viewport => update({ viewport }),
    requestPopupClose() {
      for (const listener of popupCloseListeners) listener();
    },
    onPopupClose(listener) {
      popupCloseListeners.add(listener);
      return () => {
        popupCloseListeners.delete(listener);
      };
    },
  };
};
