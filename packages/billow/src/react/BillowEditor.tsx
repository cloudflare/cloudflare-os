import {
  BillowEditor as CoreBillowEditor,
  type BillowDocument,
  type BillowEditorOptions,
  type ItemData,
  type ItemId,
  type ItemPresentation,
  type ItemRegistry,
  type ItemType,
  type ModelRange,
  type ReplaceDocumentOptions,
} from "../index.js";
import {
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  type ComponentPropsWithoutRef,
  type DependencyList,
  type EffectCallback,
  type ReactElement,
  type Ref,
} from "react";

export interface BillowEditorHandle<Registry extends ItemRegistry> {
  getElement(): HTMLDivElement;
  getDocument(): BillowDocument<Registry>;
  getLastSelection(): ModelRange | null;
  replaceDocument(document: BillowDocument<Registry>, options: ReplaceDocumentOptions): boolean;
  replaceRange(
    range: ModelRange,
    replacement: BillowDocument<Registry>,
    selection?: ModelRange,
  ): boolean;
  insertItem<Type extends ItemType<Registry>>(
    input: Readonly<{ itemType: Type; data: ItemData<Registry, NoInfer<Type>> }>,
  ): ItemId<Type> | null;
  updateItem<Type extends ItemType<Registry>>(id: ItemId<Type>, data: ItemData<Registry, NoInfer<Type>>): boolean;
  getSelection(): ModelRange | null;
  setSelection(range: ModelRange): void;
  getClientRect(position: number): DOMRectReadOnly | null;
  focus(): void;
  undo(): boolean;
  redo(): boolean;
  refreshItems(ids?: readonly string[]): void;
}

type EditableProps = Omit<
  ComponentPropsWithoutRef<"div">,
  "children" | "contentEditable" | "dangerouslySetInnerHTML" | "defaultValue" | "onChange" | "onError" | "onSubmit"
>;

interface CommonBaseProps<Registry extends ItemRegistry> extends EditableProps {
  readonly registry: Registry;
  readonly enterBehavior?: BillowEditorOptions<Registry>["enterBehavior"];
  readonly onChange?: (document: BillowDocument<Registry>) => void;
  readonly onSubmit?: (document: BillowDocument<Registry>) => void;
  readonly onBeforeEditorKeyDown?: (event: KeyboardEvent) => void;
  readonly onBeforeEditorPaste?: (event: ClipboardEvent) => void;
  readonly onSelectionChange?: (selection: ModelRange | null) => void;
  readonly onError?: BillowEditorOptions<Registry>["onError"];
  readonly onValueRejected?: (document: BillowDocument<Registry>) => void;
  readonly transformStructuredPaste?: BillowEditorOptions<Registry>["transformStructuredPaste"];
  readonly validateDocument?: BillowEditorOptions<Registry>["validateDocument"];
  readonly readOnly?: boolean;
  readonly placeholder?: string;
  readonly createId?: () => string;
  readonly historyLimit?: number;
}

type ReactRenderContextProps<Registry extends ItemRegistry> = unknown extends ItemPresentation<Registry>
  ? { readonly renderContext?: ItemPresentation<Registry> }
  : { readonly renderContext: ItemPresentation<Registry> };

type CommonProps<Registry extends ItemRegistry> = CommonBaseProps<Registry> & ReactRenderContextProps<Registry>;

type ControlledBillowEditorProps<Registry extends ItemRegistry> = CommonProps<Registry> & {
  readonly value: BillowDocument<Registry>;
  readonly defaultValue?: never;
  readonly onChange: (document: BillowDocument<Registry>) => void;
  readonly onValueRejected?: (document: BillowDocument<Registry>) => void;
};

type UncontrolledBillowEditorProps<Registry extends ItemRegistry> = CommonProps<Registry> & {
  readonly value?: never;
  readonly defaultValue?: BillowDocument<Registry>;
  readonly onValueRejected?: never;
};

export type BillowEditorProps<Registry extends ItemRegistry> =
  | ControlledBillowEditorProps<Registry>
  | UncontrolledBillowEditorProps<Registry>;

type CurrentPropKey =
  | "onChange"
  | "onError"
  | "onBeforeEditorKeyDown"
  | "onBeforeEditorPaste"
  | "onSelectionChange"
  | "onSubmit"
  | "onValueRejected"
  | "transformStructuredPaste"
  | "validateDocument";
type CurrentProps<Registry extends ItemRegistry> = {
  [Key in CurrentPropKey]?: CommonBaseProps<Registry>[Key] | undefined;
};

interface ControlledSyncState<Registry extends ItemRegistry> {
  applyingExternalValue: boolean;
  emittedValue: BillowDocument<Registry> | null;
  appliedValue: BillowDocument<Registry> | undefined;
  rejectedValue: {
    value: BillowDocument<Registry>;
    validateDocument: CommonBaseProps<Registry>["validateDocument"];
  } | null;
}

function reconcileControlledValue<Registry extends ItemRegistry>(
  coreEditor: CoreBillowEditor<Registry>,
  value: BillowDocument<Registry>,
  validateDocument: CommonBaseProps<Registry>["validateDocument"],
  onValueRejected: CommonBaseProps<Registry>["onValueRejected"],
  state: ControlledSyncState<Registry>,
): void {
  // The parent accepted the exact document emitted by the editor. Keep its history.
  if (Object.is(state.emittedValue, value)) {
    state.emittedValue = null;
    state.appliedValue = value;
    state.rejectedValue = null;
    return;
  }
  if (Object.is(state.appliedValue, value)) return;

  const rejected = state.rejectedValue;
  if (rejected
    && Object.is(rejected.value, value)
    && Object.is(rejected.validateDocument, validateDocument)) return;

  // A previous value rolls back an unacknowledged edit; a new value is an external replacement.
  state.emittedValue = null;
  state.applyingExternalValue = true;
  try {
    if (coreEditor.replaceDocument(value, { history: "reset", selection: "preserve" })) {
      state.appliedValue = value;
      state.rejectedValue = null;
    } else {
      state.rejectedValue = { value, validateDocument };
      onValueRejected?.(value);
    }
  } finally {
    state.applyingExternalValue = false;
  }
}

function useClientLayoutEffect(effect: EffectCallback, dependencies?: DependencyList): void {
  const useEffectForEnvironment = typeof window === "undefined" ? useEffect : useLayoutEffect;
  useEffectForEnvironment(effect, dependencies);
}

function isDevelopmentEnvironment(): boolean {
  const runtimeProcess = (globalThis as typeof globalThis & {
    readonly process?: { readonly env?: { readonly NODE_ENV?: string } };
  }).process;
  return runtimeProcess?.env?.NODE_ENV !== "production";
}

function createHandle<Registry extends ItemRegistry>(
  getCoreEditor: () => CoreBillowEditor<Registry>,
  getElement: () => HTMLDivElement,
): BillowEditorHandle<Registry> {
  return {
    getElement,
    getDocument: () => getCoreEditor().getDocument(),
    getLastSelection: () => getCoreEditor().getLastSelection(),
    replaceDocument: (document, options) => getCoreEditor().replaceDocument(document, options),
    replaceRange: (range, replacement, selection) => getCoreEditor().replaceRange(range, replacement, selection),
    insertItem<Type extends ItemType<Registry>>(
      input: Readonly<{ itemType: Type; data: ItemData<Registry, NoInfer<Type>> }>,
    ): ItemId<Type> | null {
      return getCoreEditor().insertItem(input);
    },
    updateItem<Type extends ItemType<Registry>>(id: ItemId<Type>, data: ItemData<Registry, NoInfer<Type>>): boolean {
      return getCoreEditor().updateItem(id, data);
    },
    getSelection: () => getCoreEditor().getSelection(),
    setSelection: (range) => getCoreEditor().setSelection(range),
    getClientRect: (position) => getCoreEditor().getClientRect(position),
    focus: () => getCoreEditor().focus(),
    undo: () => getCoreEditor().undo(),
    redo: () => getCoreEditor().redo(),
    refreshItems: (ids) => getCoreEditor().refreshItems(ids),
  };
}

function BillowEditorInner<Registry extends ItemRegistry>(
  props: BillowEditorProps<Registry>,
  forwardedRef: Ref<BillowEditorHandle<Registry>>,
): ReactElement {
  const {
    registry,
    enterBehavior = "newline",
    onChange,
    onSubmit,
    onBeforeEditorKeyDown,
    onBeforeEditorPaste,
    onSelectionChange,
    onError,
    transformStructuredPaste,
    validateDocument,
    renderContext,
    readOnly = false,
    placeholder,
    createId,
    historyLimit,
    value,
    defaultValue,
    onValueRejected,
    ...domProps
  } = props;
  const controlled = "value" in props;
  const [controlledSyncRevision, requestControlledSync] = useReducer((revision: number) => revision + 1, 0);
  const elementRef = useRef<HTMLDivElement>(null);
  const coreEditorRef = useRef<CoreBillowEditor<Registry> | null>(null);
  const initialRegistryRef = useRef(registry);
  const initialCreateIdRef = useRef(createId);
  const initialHistoryLimitRef = useRef(historyLimit);
  const currentPropsRef = useRef<CurrentProps<Registry>>({
    onChange,
    onError,
    onBeforeEditorKeyDown,
    onBeforeEditorPaste,
    onSelectionChange,
    onSubmit,
    onValueRejected,
    transformStructuredPaste,
    validateDocument,
  });
  const initialControlledRef = useRef(controlled);
  const controlledSyncRef = useRef<ControlledSyncState<Registry>>({
    applyingExternalValue: false,
    emittedValue: null,
    appliedValue: controlled ? value : undefined,
    rejectedValue: null,
  });
  const synchronizedPropsRef = useRef({ enterBehavior, readOnly, placeholder, renderContext });
  const warnedRegistryRef = useRef(false);
  const warnedCreateIdRef = useRef(false);
  const warnedHistoryLimitRef = useRef(false);
  const warnedModeRef = useRef(false);

  useClientLayoutEffect(() => {
    currentPropsRef.current = {
      onChange,
      onError,
      onBeforeEditorKeyDown,
      onBeforeEditorPaste,
      onSelectionChange,
      onSubmit,
      onValueRejected,
      transformStructuredPaste,
      validateDocument,
    };
  });

  const getCoreEditor = (): CoreBillowEditor<Registry> => {
    const coreEditor = coreEditorRef.current;
    if (!coreEditor) throw new Error("BillowEditor is not mounted");
    return coreEditor;
  };
  const getElement = (): HTMLDivElement => {
    const element = elementRef.current;
    if (!element) throw new Error("BillowEditor is not mounted");
    return element;
  };
  const handleRef = useRef<BillowEditorHandle<Registry> | null>(null);
  handleRef.current ??= createHandle(getCoreEditor, getElement);

  useClientLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const initialValue = controlled ? value : defaultValue;
    const options = {
      registry: initialRegistryRef.current,
      enterBehavior: synchronizedPropsRef.current.enterBehavior,
      readOnly: synchronizedPropsRef.current.readOnly,
      onChange: (document: BillowDocument<Registry>) => {
        const controlledSync = controlledSyncRef.current;
        if (controlledSync.applyingExternalValue) return;
        controlledSync.emittedValue = document;
        controlledSync.appliedValue = undefined;
        try {
          currentPropsRef.current.onChange?.(document);
        } finally {
          if (initialControlledRef.current) requestControlledSync();
        }
      },
      onError: (error: unknown, context: Parameters<NonNullable<CommonBaseProps<Registry>["onError"]>>[1]) => {
        const handler = currentPropsRef.current.onError;
        if (!handler) throw error;
        handler(error, context);
      },
      onSubmit: (document: BillowDocument<Registry>) => currentPropsRef.current.onSubmit?.(document),
      onKeyDown: (event: KeyboardEvent) => currentPropsRef.current.onBeforeEditorKeyDown?.(event),
      onPaste: (event: ClipboardEvent) => currentPropsRef.current.onBeforeEditorPaste?.(event),
      onSelectionChange: (selection: ModelRange | null) => currentPropsRef.current.onSelectionChange?.(selection),
      transformStructuredPaste: (context: Parameters<NonNullable<CommonBaseProps<Registry>["transformStructuredPaste"]>>[0]) => {
        const transform = currentPropsRef.current.transformStructuredPaste;
        return transform ? transform(context) : context.replacement;
      },
      validateDocument: (document: BillowDocument<Registry>) => currentPropsRef.current.validateDocument?.(document) ?? true,
      ...(initialValue === undefined ? {} : { value: initialValue }),
      ...(synchronizedPropsRef.current.renderContext === undefined ? {} : { renderContext: synchronizedPropsRef.current.renderContext }),
      ...(synchronizedPropsRef.current.placeholder === undefined ? {} : { placeholder: synchronizedPropsRef.current.placeholder }),
      ...(initialCreateIdRef.current === undefined ? {} : { createId: initialCreateIdRef.current }),
      ...(initialHistoryLimitRef.current === undefined ? {} : { historyLimit: initialHistoryLimitRef.current }),
    };
    const coreEditor = new CoreBillowEditor(element, options as BillowEditorOptions<Registry>);
    coreEditorRef.current = coreEditor;
    return () => {
      coreEditorRef.current = null;
      coreEditor.destroy();
    };
  }, []);

  useClientLayoutEffect(() => {
    const coreEditor = coreEditorRef.current;
    if (!coreEditor) return;
    const previous = synchronizedPropsRef.current;
    if (previous.enterBehavior !== enterBehavior) coreEditor.setEnterBehavior(enterBehavior);
    if (previous.readOnly !== readOnly) coreEditor.setReadOnly(readOnly);
    if (previous.placeholder !== placeholder) coreEditor.setPlaceholder(placeholder);
    if (!Object.is(previous.renderContext, renderContext)) {
      coreEditor.setRenderContext(renderContext as ItemPresentation<Registry>);
      coreEditor.refreshItems();
    }
    synchronizedPropsRef.current = { enterBehavior, readOnly, placeholder, renderContext };
  }, [enterBehavior, readOnly, placeholder, renderContext]);

  // Publish the handle after the preceding layout effect has constructed the core.
  useImperativeHandle(forwardedRef, () => handleRef.current!, []);

  useClientLayoutEffect(() => {
    if (!initialControlledRef.current || !controlled || value === undefined) return;
    const coreEditor = coreEditorRef.current;
    if (!coreEditor) return;
    reconcileControlledValue(
      coreEditor,
      value,
      validateDocument,
      currentPropsRef.current.onValueRejected,
      controlledSyncRef.current,
    );
  }, [controlled, controlledSyncRevision, validateDocument, value]);

  useEffect(() => {
    if (initialRegistryRef.current !== registry && !warnedRegistryRef.current) {
      warnedRegistryRef.current = true;
      console.error("BillowEditor requires a stable registry. Remount the component to apply a different registry.");
    }
    if (initialCreateIdRef.current !== createId && !warnedCreateIdRef.current) {
      warnedCreateIdRef.current = true;
      console.error("BillowEditor requires a stable createId function. Remount the component to replace it.");
    }
    if (initialHistoryLimitRef.current !== historyLimit && !warnedHistoryLimitRef.current) {
      warnedHistoryLimitRef.current = true;
      console.error("BillowEditor requires a stable historyLimit. Remount the component to apply a different limit.");
    }
    if (isDevelopmentEnvironment()
      && initialControlledRef.current !== controlled
      && !warnedModeRef.current) {
      warnedModeRef.current = true;
      console.error("BillowEditor cannot switch between controlled and uncontrolled mode. Remount the component to change modes.");
    }
  }, [registry, createId, historyLimit, controlled]);

  return createElement("div", { ...(domProps as EditableProps), ref: elementRef });
}

const ForwardedBillowEditor = forwardRef(BillowEditorInner);
ForwardedBillowEditor.displayName = "BillowEditor";

export const BillowEditor = ForwardedBillowEditor as <Registry extends ItemRegistry>(
  props: BillowEditorProps<Registry> & { readonly ref?: Ref<BillowEditorHandle<Registry>> },
) => ReactElement;
