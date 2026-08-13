/** Values owned by a sandboxed configurator UI. */
export type ConfiguratorUIValues = Record<string, string | null | undefined>;

/** Option shown by configurator controls such as Autocomplete. */
export type ConfiguratorUIOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

/** Data and helper callbacks passed to a configurator UI render function. */
export type ConfiguratorUIRenderContext<
  TUI,
  TValues extends ConfiguratorUIValues = ConfiguratorUIValues,
> = {
  values: TValues;
  setValues(values: Partial<TValues>): void;
  clearFields(...names: (keyof TValues & string)[]): void;
  /**
   * The gatekeeper-defined `ui` capability. Its method surface is entirely up to the gatekeeper;
   * this helper makes no assumptions about it beyond passing it through to the render function.
   */
  ui: TUI;
}


/** Values and Gatekeeper helpers used to produce the selected resource URL. */
export type ConfiguratorUIResourceContext<
  TUI,
  TValues extends ConfiguratorUIValues = ConfiguratorUIValues,
> = {
  values: TValues;
  ui: TUI;
}

/** Module contract implemented by each sandboxed configurator UI. */
export type ConfiguratorUISpec<
  TUI,
  TValues extends ConfiguratorUIValues = ConfiguratorUIValues,
> = {
  /** Initial form values shown before the user makes any changes. */
  initial: TValues;

  /**
   * Optional: derive initial form values from a concrete resource URL, so the form opens
   * pre-filled and editable. This is used when something (e.g. an AI agent's connection request)
   * already knows the exact resource — the configurator opens populated rather than blank.
   *
   * `resourceUrl` is the concrete URL; `resourceUrlPattern` is this resource's URLPattern; `ui` is
   * the gatekeeper capability (in case resolving display values requires an RPC). Return the form
   * values that represent the URL (partial is fine).
   *
   * If omitted, the runtime falls back to extracting URLPattern named groups from
   * `resourceUrlPattern` and seeding any values whose keys match a group name. So a configurator
   * whose value keys already match its pattern groups (e.g. `:areaId` -> `areaId`) needs nothing
   * here; implement this only when the mapping differs (e.g. GitHub's `:owner/:repo` ->
   * `repoFullName`).
   */
  initialValuesFromResourceUrl?(context: {
    resourceUrl: string;
    resourceUrlPattern: string;
    ui: TUI;
  }): Partial<TValues> | Promise<Partial<TValues>>;

  /** Return if the current iframe-owned state is ready to submit. */
  isReady?(context: { values: TValues }): boolean;

  /** Return the resource URL chosen by current UI state. */
  resourceUrl(context: ConfiguratorUIResourceContext<TUI, TValues>): Promise<string> | string;

  /** Render the configuration UI for the current state. */
  render(context: ConfiguratorUIRenderContext<TUI, TValues>): unknown;
}

/** Groups related configurator fields. Provided by the sandbox runtime. */
export function Section(_props: { title?: string | null; children?: unknown }): unknown {
  throw new Error("Section is provided by the configurator UI sandbox runtime.");
}

/** Labels and describes one configurator input. Provided by the sandbox runtime. */
export function Field(_props: {
  label: string;
  description?: string;
  optional?: boolean;
  children?: unknown;
}): unknown {
  throw new Error("Field is provided by the configurator UI sandbox runtime.");
}

/** Text input component provided by the sandbox runtime. */
export function TextInput(_props: {
  name: string;
  value?: string | null;
  placeholder: string;
  onChange(value: string | null): void;
  optional?: boolean;
  disabled?: boolean;
}): unknown {
  throw new Error("TextInput is provided by the configurator UI sandbox runtime.");
}

/** Card-style single-select component provided by the sandbox runtime. */
export function RadioCards(_props: {
  value?: string | null;
  options: Array<{ value: string; title: string; description: string }>;
  onChange(value: string): void;
}): unknown {
  throw new Error("RadioCards is provided by the configurator UI sandbox runtime.");
}

/**
 * Multi-select checkbox list provided by the sandbox runtime.
 *
 * Because {@link ConfiguratorUIValues} are flat strings, the selection is passed and returned as a
 * comma-separated list of option values.
 *
 * **Option values must not contain a comma.** One that does cannot survive the round trip: it would
 * be read back as two selected values, silently changing what was chosen. A configurator whose
 * values may contain commas should encode them before passing them in, or use a different control.
 */
export function CheckboxList(_props: {
  name: string;
  /** Comma-separated list of selected option values. */
  value?: string | null;
  /**
   * Loads every selectable option at once. Called once per `name`; the runtime caches the result
   * and re-renders when it arrives, so the render function stays synchronous.
   *
   * Unlike {@link Autocomplete}, this takes no query: the list is expected to be small enough to
   * load whole and filter in the browser. May return an already-in-flight promise, which is how a
   * configurator prefetches the options before the list is first shown.
   */
  loadOptions(): Promise<ConfiguratorUIOption[]>;
  /** Receives the new comma-separated selection, or null when nothing is selected. */
  onChange(value: string | null): void;
  /** Displays every loaded option as selected without changing `value`. */
  allSelected?: boolean;
  disabled?: boolean;
}): unknown {
  throw new Error("CheckboxList is provided by the configurator UI sandbox runtime.");
}

/** Async option selection component provided by the sandbox runtime. */
export function Autocomplete(_props: {
  name: string;
  value?: string | null;
  placeholder: string;
  loadOptions(query: string): Promise<ConfiguratorUIOption[]>;
  onChange(value: string | null): void;
  optional?: boolean;
  onClear?(): void;
  disabled?: boolean;
}): unknown {
  throw new Error("Autocomplete is provided by the configurator UI sandbox runtime.");
}

/** JSX factory provided by the sandbox runtime. */
export function h(_component: unknown, _props: unknown, ..._children: unknown[]): unknown {
  throw new Error("h is provided by the configurator UI sandbox runtime.");
}

/** JSX fragment helper provided by the sandbox runtime. */
export function Fragment(_props: { children?: unknown }): unknown {
  throw new Error("Fragment is provided by the configurator UI sandbox runtime.");
}

// JSX ambient types for configurator UI `.tsx` modules. These globals only apply when something
// imports this package, which is intended only for sandboxed configurator UI modules compiled by
// `scripts/build-gatekeeper-configurator.mjs`. Workshop and gatekeeper-server code should NOT
// import from this package to avoid clashing with React's `JSX` namespace.
declare global {
  namespace JSX {
    type Element = unknown;
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicElements {
      [tagName: string]: any;
    }
  }
}
