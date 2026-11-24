export interface ItemRenderContext<Type extends string = string, Presentation = unknown> {
  readonly document: Document;
  readonly itemId: ItemId<Type>;
  readonly element: HTMLElement;
  readonly presentation: Presentation;
  reportError(error: unknown): void;
}
export type ItemAccessibilityAttributes = Readonly<{
  role?: string | null;
} & Partial<Record<`aria-${string}`, string | null>>>;
export type EnterBehavior = "newline" | "submit";
/** How one type of item looks and converts. Registered by name in an `ItemRegistry`. */
export interface ItemDefinition<Data = unknown, Serialized = Data, Presentation = unknown> {
  /**
   * Draws an item into `context.element`, which is inert (not interactive). Either return the
   * content (a node, or a string used as text) or return nothing and fill `context.element`
   * yourself.
   */
  render(data: Data, context: ItemRenderContext<string, Presentation>): Node | string | void;
  /**
   * Changes an already-rendered item in place when its data changes. Without it the item is
   * rendered again from scratch. If it throws, the element is put back as it was.
   */
  update?(element: HTMLElement, previousData: Data, data: Data, context: ItemRenderContext<string, Presentation>): void;
  /** Cleans up whatever `render` or `update` created, when the item leaves the document. */
  destroy?(element: HTMLElement, data: Data): void;
  /** The item as plain text: used for the `text/plain` clipboard flavor and as the default accessible name. */
  toPlainText(data: Data): string;
  /** Converts item data to JSON-safe form for `serializeDocument` and the clipboard. Defaults to the data itself. */
  serialize?(data: Data): Serialized;
  /**
   * Inverse of `serialize`. Receives untrusted data (e.g. from the clipboard); throw to reject it,
   * which makes a paste fall back to plain text. Defaults to the value as is.
   */
  deserialize?(value: unknown): Data;
  /** The accessible name of the item. Defaults to `toPlainText`. */
  getLabel?(data: Data): string;
  /** Extra `role` and `aria-*` attributes for the item; `null` removes one. The default role is "img". */
  getAccessibilityAttributes?(data: Data, context: ItemRenderContext<string, Presentation>): ItemAccessibilityAttributes;
}

export type ItemRegistry = Readonly<Record<string, ItemDefinition<any, any, any>>>;
type ItemRegistryWithPresentation<Presentation> = Readonly<Record<string, ItemDefinition<any, any, Presentation>>>;
declare const registryPresentationBrand: unique symbol;

export function defineItemRegistry<Presentation = unknown>() {
  return <Registry extends ItemRegistryWithPresentation<Presentation>>(
    registry: Registry,
  ): Registry & { readonly [registryPresentationBrand]: Presentation } => registry as Registry & {
    readonly [registryPresentationBrand]: Presentation;
  };
}

export type ItemType<Registry extends ItemRegistry> = Extract<keyof Registry, string>;
declare const itemTypeBrand: unique symbol;
export type ItemId<Type extends string = string> = string & { readonly [itemTypeBrand]?: Type };
export type ItemData<
  Registry extends ItemRegistry,
  Type extends ItemType<Registry> = ItemType<Registry>,
> = Registry[Type] extends { render(data: infer Data, ...arguments_: any[]): any } ? Data : never;
export type ItemPresentation<Registry extends ItemRegistry> = Registry extends { readonly [registryPresentationBrand]: infer Presentation }
  ? Presentation
  : Registry[ItemType<Registry>] extends ItemDefinition<any, any, infer Presentation>
    ? Presentation
    : unknown;
export type ItemNode<Registry extends ItemRegistry = ItemRegistry> = {
  [Type in ItemType<Registry>]: Readonly<{
    type: "item";
    id: ItemId<Type>;
    itemType: Type;
    data: ItemData<Registry, Type>;
  }>;
}[ItemType<Registry>];
export type BillowNode<Registry extends ItemRegistry = ItemRegistry> = string | ItemNode<Registry>;
export type BillowDocument<Registry extends ItemRegistry = ItemRegistry> = readonly BillowNode<Registry>[];
export type ModelRange = Readonly<{ anchor: number; focus: number }>;
export interface ReplaceDocumentOptions {
  /**
   * What happens to undo/redo history:
   * - `"reset"`: cleared; the new document is the starting point (how `setDocument` works).
   * - `"record"`: the current state is pushed first, so the replacement can be undone.
   * - `"preserve"`: the stacks are left as they are, but typing is no longer grouped with what came before.
   */
  readonly history: "reset" | "preserve" | "record";
  /**
   * Where the selection ends up: `"preserve"` (the default) keeps the current one, clamped to the
   * new length; `"end"` puts the caret at the end; a `ModelRange` sets it explicitly.
   */
  readonly selection?: "preserve" | "end" | ModelRange;
}
export interface StructuredPasteContext<Registry extends ItemRegistry = ItemRegistry> {
  readonly document: BillowDocument<Registry>;
  readonly range: ModelRange;
  readonly replacement: BillowDocument<Registry>;
  readonly prospectiveDocument: BillowDocument<Registry>;
}

export interface BrowserEventErrorContext {
  readonly origin: "browser-event";
  readonly event: Event;
  readonly operation: string;
  readonly phase: "callback" | "mutation";
}

export interface RendererErrorContext {
  readonly origin: "renderer";
  readonly itemId: string;
}

export type BillowEditorErrorContext = BrowserEventErrorContext | RendererErrorContext;

type BillowEditorOptionsBase<Registry extends ItemRegistry> = {
  registry: Registry;
  value?: BillowDocument<Registry>;
  enterBehavior?: EnterBehavior;
  onChange?: (document: BillowDocument<Registry>) => void;
  onSubmit?: (document: BillowDocument<Registry>) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onPaste?: (event: ClipboardEvent) => void;
  onSelectionChange?: (selection: ModelRange | null) => void;
  onError?: (error: unknown, context: BillowEditorErrorContext) => void;
  transformStructuredPaste?: (context: StructuredPasteContext<Registry>) => BillowDocument<Registry> | null;
  validateDocument?: (document: BillowDocument<Registry>) => boolean;
  readOnly?: boolean;
  placeholder?: string;
  createId?: () => string;
  historyLimit?: number;
};

export type BillowEditorOptions<Registry extends ItemRegistry = ItemRegistry> = BillowEditorOptionsBase<Registry> & (unknown extends ItemPresentation<Registry>
  ? { renderContext?: ItemPresentation<Registry> }
  : { renderContext: ItemPresentation<Registry> });

export type InsertItemInput<Registry extends ItemRegistry = ItemRegistry> = {
  [Type in ItemType<Registry>]: Readonly<{ itemType: Type; data: ItemData<Registry, Type> }>;
}[ItemType<Registry>];

export interface ClipboardPayload {
  readonly plainText: string;
  readonly metadata: string;
}
