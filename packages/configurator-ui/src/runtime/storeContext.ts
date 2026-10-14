import { createContext, useContext, useSyncExternalStore } from "react";
import type { ConfiguratorState, ConfiguratorStore } from "./store.ts";

export const StoreContext = createContext<ConfiguratorStore | null>(null);

export const useConfiguratorStore = (): ConfiguratorStore => {
  const store = useContext(StoreContext);
  if (!store) throw new Error("Configurator components render only inside a configurator.");
  return store;
};

/**
 * One slice of the configurator's state. The selector must return a primitive or a value already in
 * the state, never a new object, or every render would look like a change.
 */
export const useConfiguratorState = <T,>(select: (state: ConfiguratorState) => T): T => {
  const store = useConfiguratorStore();
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
};
