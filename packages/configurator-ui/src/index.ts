/** Values owned by a sandboxed configurator UI. */
export type ConfiguratorUIValues = Record<string, string | null | undefined>;

/** Option shown by configurator controls such as Autocomplete. */
export type ConfiguratorUIOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

/** What the Workshop tells every configurator UI callback about where it runs. */
export type ConfiguratorUIHostContext = {
  /**
   * The resource types (urlPatterns) the Workshop asks this configurator to choose among; absent
   * when it did not say (an older Workshop, which takes any). A configurator that can return several
   * types offers only these.
   */
  acceptedResourceUrlPatterns?: readonly string[];
};

/** Data and helper callbacks passed to a configurator UI render function. */
export type ConfiguratorUIRenderContext<
  TUI,
  TValues extends ConfiguratorUIValues = ConfiguratorUIValues,
> = ConfiguratorUIHostContext & {
  values: TValues;
  setValues(values: Partial<TValues>): void;
  clearFields(...names: (keyof TValues & string)[]): void;
  /**
   * The gatekeeper-defined `ui` capability. Its method surface is entirely up to the gatekeeper;
   * this helper makes no assumptions about it beyond passing it through to the render function.
   */
  ui: TUI;
  /**
   * Ask Workshop to make sure the connected account holds grants covering `resourceUrlPatterns`,
   * asking the user for consent when it does not. Resolves true when the account already holds
   * them. Otherwise Workshop opens the provider's consent pop-up and resolves false, so re-check
   * through `ui`. Rejects when the request fails or Workshop sees the user cancel. Call it from a
   * click handler, so the browser allows the pop-up.
   */
  ensureResources(resourceUrlPatterns: string[]): Promise<boolean>;
}


/** Values and Gatekeeper helpers used to produce the selected resource URL. */
export type ConfiguratorUIResourceContext<
  TUI,
  TValues extends ConfiguratorUIValues = ConfiguratorUIValues,
> = ConfiguratorUIHostContext & {
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
  initialValuesFromResourceUrl?(context: ConfiguratorUIHostContext & {
    resourceUrl: string;
    resourceUrlPattern: string;
    ui: TUI;
  }): Partial<TValues> | Promise<Partial<TValues>>;

  /**
   * Return whether the current iframe-owned state is ready to submit. If omitted, the generated
   * iframe reports ready after its initial render succeeds.
   */
  isReady?(context: ConfiguratorUIHostContext & { values: TValues }): boolean;

  /** Return the resource URL chosen by current UI state. */
  resourceUrl(context: ConfiguratorUIResourceContext<TUI, TValues>): Promise<string> | string;

  /** Render the configuration UI for the current state. */
  render(context: ConfiguratorUIRenderContext<TUI, TValues>): unknown;
}

/** Props of {@link Section}. */
export type SectionProps = { title?: string | null; children?: unknown };

/** Props of {@link Field}. */
export type FieldProps = {
  label: string;
  description?: string;
  optional?: boolean;
  /** The control this field labels. A field labels one control. */
  children?: unknown;
};

/** Props of {@link TextInput}. */
export type TextInputProps = {
  name: string;
  value?: string | null;
  placeholder: string;
  onChange(value: string | null): void;
  optional?: boolean;
  disabled?: boolean;
};

/** Props of {@link RadioCards}. */
export type RadioCardsProps = {
  value?: string | null;
  options: Array<{ value: string; title: string; description: string }>;
  onChange(value: string): void;
};

/** Props of {@link CheckboxList}. */
export type CheckboxListProps = {
  name: string;
  /** Comma-separated list of selected option values. */
  value?: string | null;
  /**
   * Loads every selectable option at once. The runtime keeps what it loads for each `name` for the
   * life of the frame, so a list that must reload varies its name; a failed load is retried when the
   * list shows that name again. It re-renders when the result arrives, so `render` stays synchronous.
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
};

/** Props of {@link Autocomplete}. */
export type AutocompleteProps = {
  name: string;
  value?: string | null;
  placeholder: string;
  loadOptions(query: string): Promise<ConfiguratorUIOption[]>;
  onChange(value: string | null): void;
  optional?: boolean;
  onClear?(): void;
  disabled?: boolean;
};

/**
 * How an open container is offered as a choice, in the row its listing starts with. Only the
 * gatekeeper knows what connecting a container grants (its whole subtree, or the node alone, as
 * for a page whose subpages it cannot read), so it says so here.
 */
export type ConfiguratorUIHierarchyChoice = {
  /** Defaults to "Everything in" and the container's title, which suits a grant of its subtree. */
  title?: string;
  /** What connecting it grants, such as whether that reaches what is added later. None by default. */
  subtitle?: string;
};

/** An ancestor of a {@link ConfiguratorUIHierarchyItem}, as its breadcrumb shows it. */
export type ConfiguratorUIHierarchyAncestor = {
  id: string;
  title: string;
  /** As for {@link ConfiguratorUIHierarchyItem.selectable}: whether, once open, it is offered as a choice. */
  selectable?: boolean;
  /** As for {@link ConfiguratorUIHierarchyItem.icon}, shown on that choice. */
  icon?: string;
  /** As for {@link ConfiguratorUIHierarchyItem.choice}. */
  choice?: ConfiguratorUIHierarchyChoice;
};

/** One node listed by a {@link HierarchyPicker}. */
export type ConfiguratorUIHierarchyItem = {
  /**
   * Opaque to the runtime and becomes the field value when the node is selected. It must identify
   * the node on its own, so a gatekeeper that needs to tell nodes apart (a folder from a file, say)
   * encodes that in the id.
   */
  id: string;
  title: string;
  /** A container opens to list its own nodes (a folder, a drive, a space); a leaf does not. */
  kind: "container" | "leaf";
  /**
   * Key into the picker's `icons`. A missing or unknown key shows the runtime's default icon for the
   * node's kind.
   */
  icon?: string;
  subtitle?: string;
  /**
   * Whether the node can be connected. Defaults to true. A leaf is chosen from its own row; a
   * container from the row its listing starts with once it is open (see `choice`). An unselectable
   * container still opens, without that row, so a grouping such as "Shared with me" can be browsed
   * without being offered as a resource.
   */
  selectable?: boolean;
  /** For a container, how it is offered as a choice once open. */
  choice?: ConfiguratorUIHierarchyChoice;
  /**
   * The node's ancestors below the root, outermost first. Optional in a listing, where the picker
   * knows where it is, but needed for search results and for `loadItem`, so the breadcrumb can show
   * where the node lives.
   */
  path?: ConfiguratorUIHierarchyAncestor[];
};

/** Where a {@link HierarchyPicker} starts. */
export type ConfiguratorUIHierarchyRoot = {
  id: string;
  title: string;
  /**
   * Whether the root itself can be connected, meaning everything the picker reaches. When it can, it
   * is offered above the list, as "All of" its title.
   */
  selectable?: boolean;
  /** Shown under that choice, saying what it covers. */
  subtitle?: string;
  /** Key into the picker's `icons` for that choice. */
  icon?: string;
};

/** One request a {@link HierarchyPicker} makes of its `loadItems`. */
export type ConfiguratorUIHierarchyRequest = {
  /** Id of the open location: the root's or a container's. */
  parentId: string;
  /**
   * Empty to list the open location. Otherwise the user's search; whether it searches under
   * `parentId` or everywhere the picker reaches is the gatekeeper's choice, and its placeholder
   * should say which.
   */
  query: string;
  /** Null for the first page, otherwise the `nextCursor` of the page before. */
  cursor: string | null;
};

/** One page of nodes returned by a {@link HierarchyPicker}'s `loadItems`. */
export type ConfiguratorUIHierarchyPage = {
  /** In the order to show them; the picker never sorts. */
  items: ConfiguratorUIHierarchyItem[];
  /** Present when more nodes follow; passed back as the next request's `cursor`. */
  nextCursor?: string | null;
  /**
   * Why this location cannot be listed yet, such as a grant the user has still to give. Shown with
   * Retry in place of its nodes, as a rejected load is, but expected, so not reported as an error.
   */
  unavailable?: string;
};

/** Props of {@link HierarchyPicker}. */
export type HierarchyPickerProps = {
  name: string;
  /**
   * Id of the selected node (or the root's), or null when nothing is selected. The root's id is let
   * go of unless the root is selectable.
   */
  value?: string | null;
  root: ConfiguratorUIHierarchyRoot;
  loadItems(request: ConfiguratorUIHierarchyRequest): Promise<ConfiguratorUIHierarchyPage>;
  /**
   * Looks up the node a `value` names, with its `path`, so a value the picker is not showing (a
   * pre-filled one, or one the module sets) opens where it lives. Any such value other than the
   * root's needs it: one it resolves null for, fails on, finds cannot be connected, or resolves to a
   * node of another id is let go of, since the picker cannot show it as that choice.
   */
  loadItem?(id: string): Promise<ConfiguratorUIHierarchyItem | null>;
  /**
   * Receives the user's choice and the node it names (for the root or an open container, a container
   * named after it), or null when the picker lets go of it. As in a file dialog, a choice lasts while
   * it is in view: moving to another location or searching lets go of it, except the root's, whose
   * choice is always in view, and so does a pre-filled value `loadItem` cannot show.
   */
  onChange(value: string | null, item: ConfiguratorUIHierarchyItem | null): void;
  /**
   * The icons nodes can name with `icon`, drawn by the configurator, typically as inline `<svg>`
   * using `currentColor` so they follow the theme. The runtime sizes and places them and hides them
   * from assistive technology, since the title names the node. Define the map once at module level.
   */
  icons?: Record<string, unknown>;
  /**
   * Shows a search box beside the breadcrumb, named by this text. While in use it takes the
   * breadcrumb's place and shows this text as its placeholder. Omit it for a picker without search.
   */
  searchPlaceholder?: string;
  disabled?: boolean;
};

/** Props of {@link Button}. */
export type ButtonProps = {
  children?: unknown;
  onClick(): void;
  /** Ignores clicks but stays focusable, so a Button that disables itself on click keeps focus. */
  disabled?: boolean;
  /** Defaults to `primary`. */
  variant?: "primary" | "secondary";
};

/** Props of {@link Notice}. */
export type NoticeProps = { children?: unknown; tone?: "info" | "error" };

/** Groups related configurator fields. Provided by the sandbox runtime. */
export function Section(_props: SectionProps): unknown {
  throw new Error("Section is provided by the configurator UI sandbox runtime.");
}

/** Labels and describes one configurator input. Provided by the sandbox runtime. */
export function Field(_props: FieldProps): unknown {
  throw new Error("Field is provided by the configurator UI sandbox runtime.");
}

/** Text input component provided by the sandbox runtime. */
export function TextInput(_props: TextInputProps): unknown {
  throw new Error("TextInput is provided by the configurator UI sandbox runtime.");
}

/** Card-style single-select component provided by the sandbox runtime. */
export function RadioCards(_props: RadioCardsProps): unknown {
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
export function CheckboxList(_props: CheckboxListProps): unknown {
  throw new Error("CheckboxList is provided by the configurator UI sandbox runtime.");
}

/** Async option selection component provided by the sandbox runtime. */
export function Autocomplete(_props: AutocompleteProps): unknown {
  throw new Error("Autocomplete is provided by the configurator UI sandbox runtime.");
}

/**
 * Navigable list for choosing one node of a hierarchy -- the whole hierarchy, a container in it, or a
 * single leaf -- with breadcrumbs, optional search, and paging. As in a file dialog, a choice lasts
 * while it is in view. Provided by the sandbox runtime.
 */
export function HierarchyPicker(_props: HierarchyPickerProps): unknown {
  throw new Error("HierarchyPicker is provided by the configurator UI sandbox runtime.");
}

/**
 * Button component provided by the sandbox runtime. When a render removes the focused Button, focus
 * moves to the first control left rather than to nowhere.
 */
export function Button(_props: ButtonProps): unknown {
  throw new Error("Button is provided by the configurator UI sandbox runtime.");
}

/**
 * Inline message provided by the sandbox runtime. An `error` notice is announced assertively. An
 * `info` notice is announced politely, through one live region that announces the last info notice
 * on screen whenever its text changes.
 */
export function Notice(_props: NoticeProps): unknown {
  throw new Error("Notice is provided by the configurator UI sandbox runtime.");
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
// `scripts/build-gatekeeper-configurator.ts`. Workshop and gatekeeper-server code should NOT
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
