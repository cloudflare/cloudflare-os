import type { ConfiguratorUIHostContext, ConfiguratorUISpec } from "../index.ts";
import type { ConfiguratorStore } from "./store.ts";

/**
 * One running configurator: the gatekeeper's module, its `ui` capability, its state, and whether
 * what it currently shows can be trusted to describe what would be collected.
 */
export type ConfiguratorSession<TUI = unknown> = ConfiguratorUIHostContext & {
  spec: ConfiguratorUISpec<TUI>;
  ui: TUI;
  store: ConfiguratorStore;
  /** The render context's `ensureResources`: the host's, for the account the frame was opened on. */
  ensureResources(resourceUrlPatterns: string[]): Promise<boolean>;
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

/**
 * Why the host may not collect now, or null when it may: readiness is this being null. The render
 * fields describe the last commit, which follows a change to the values within a microtask, so a
 * message from the host, which can ask to collect, always finds them current.
 */
const refusal = (session: ConfiguratorSession): string | null => {
  if (session.renderFailed || session.treeFailed) return "Configurator failed to render its current state.";
  const [hold] = session.store.getState().holds.values();
  if (hold !== undefined) return hold;
  return session.moduleReady ? null : "Configurator is not ready.";
};

/** Creates a session whose readiness reports reach the host once per change. */
export const createSession = <TUI,>(
  init: Pick<ConfiguratorSession<TUI>, "spec" | "ui" | "store" | "ensureResources" | "acceptedResourceUrlPatterns">,
  setSelectionReady: (ready: boolean) => void,
): ConfiguratorSession<TUI> => {
  let lastPosted: boolean | undefined;
  const session: ConfiguratorSession<TUI> = {
    ...init,
    renderFailed: false,
    treeFailed: false,
    moduleReady: false,
    postReadiness() {
      const ready = refusal(session) === null;
      if (ready === lastPosted) return;
      lastPosted = ready;
      setSelectionReady(ready);
    },
  };
  return session;
};

const assertCollectable = (session: ConfiguratorSession): void => {
  const reason = refusal(session);
  if (reason !== null) throw new Error(reason);
};

/**
 * The resource URL for the values on screen. Refuses whatever readiness withholds (the render
 * failed, a field holds collection, or the module does not call the values ready), and values that
 * changed while the module's `resourceUrl` was computing it.
 */
export const collectResourceUrl = async (session: ConfiguratorSession): Promise<string> => {
  assertCollectable(session);
  const renderedValues = session.store.getState().values;
  const { spec, ui, acceptedResourceUrlPatterns } = session;
  const resourceUrl = await spec.resourceUrl({ values: renderedValues, ui, acceptedResourceUrlPatterns });
  assertCollectable(session);
  if (session.store.getState().values !== renderedValues) {
    throw new Error("Configurator changed while its resource URL was being collected. Please try again.");
  }
  if (typeof resourceUrl !== "string" || resourceUrl.length === 0) {
    throw new Error("Configurator did not provide a resource URL.");
  }
  return resourceUrl;
};
