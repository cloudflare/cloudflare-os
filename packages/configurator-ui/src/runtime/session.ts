import type { ConfiguratorUISpec } from "../index.ts";
import type { ConfiguratorStore } from "./store.ts";

/**
 * One running configurator: the gatekeeper's module, its `ui` capability, its state, and whether
 * what it currently shows can be trusted to describe what would be collected.
 */
export type ConfiguratorSession<TUI = unknown> = {
  spec: ConfiguratorUISpec<TUI>;
  ui: TUI;
  store: ConfiguratorStore;
  /** The module's `render` or `isReady` threw for the current state. */
  renderFailed: boolean;
  /** A runtime component threw while rendering the module's tree. */
  treeFailed: boolean;
  /** What the module's `isReady` said of the current state; true when it has none. */
  moduleReady: boolean;
  /**
   * Tells the host whether `Add connection` may be enabled, from the fields above and the store.
   * Called by whatever changes one of them, in any order: each call reads them all.
   */
  postReadiness(): void;
};

/** Creates a session whose readiness reports reach the host once per change. */
export const createSession = <TUI,>(
  init: Pick<ConfiguratorSession<TUI>, "spec" | "ui" | "store">,
  setSelectionReady: (ready: boolean) => void,
): ConfiguratorSession<TUI> => {
  let lastPosted: boolean | undefined;
  const session: ConfiguratorSession<TUI> = {
    ...init,
    renderFailed: false,
    treeFailed: false,
    moduleReady: false,
    postReadiness() {
      const ready = session.moduleReady && !session.renderFailed && !session.treeFailed
        && session.store.getState().failedLists.size === 0;
      if (ready === lastPosted) return;
      lastPosted = ready;
      setSelectionReady(ready);
    },
  };
  return session;
};

const assertCollectable = (session: ConfiguratorSession): void => {
  if (session.renderFailed || session.treeFailed) {
    throw new Error("Configurator failed to render its current state.");
  }
  if (session.store.getState().failedLists.size > 0) {
    throw new Error("Configurator options did not load.");
  }
};

/**
 * The resource URL for the values on screen. Refuses when the screen cannot be trusted to show what
 * the URL names: the render failed, options failed to load, or the values changed while the
 * module's `resourceUrl` was computing it.
 */
export const collectResourceUrl = async (session: ConfiguratorSession): Promise<string> => {
  assertCollectable(session);
  const renderedValues = session.store.getState().values;
  const resourceUrl = await session.spec.resourceUrl({ values: renderedValues, ui: session.ui });
  assertCollectable(session);
  if (session.store.getState().values !== renderedValues) {
    throw new Error("Configurator changed while its resource URL was being collected. Please try again.");
  }
  if (typeof resourceUrl !== "string" || resourceUrl.length === 0) {
    throw new Error("Configurator did not provide a resource URL.");
  }
  return resourceUrl;
};
