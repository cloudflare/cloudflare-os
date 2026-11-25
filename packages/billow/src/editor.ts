import type {
  BillowDocument,
  BillowEditorErrorContext,
  BillowNode,
  BillowEditorOptions,
  ItemData,
  ItemId,
  ItemPresentation,
  ItemRegistry,
  ItemType,
  ModelRange,
  ReplaceDocumentOptions,
  StructuredPasteContext,
} from "./types.js";
import {
  documentLength,
  getItemDefinition,
  nodesWithPositions,
  replaceDocumentRange as replaceModelRange,
  sliceDocument,
} from "./model.js";
import { CLIPBOARD_MIME, createClipboardPayload, parseClipboardMetadata } from "./clipboard.js";
import {
  documentsEqual,
  expandEditingRange,
  moveByGrapheme,
  rangeTouchesItem,
  wordMoveTarget,
} from "./editing.js";
import {
  isCaretSentinel,
} from "./dom-normalization.js";
import {
  atomOnlyLineBoundary,
  decideCharacterDeletion,
  decideRangeDeletion,
  shouldInterceptInsert,
} from "./edit-rules.js";
import { ItemRenderer, crossingDistance } from "./item-renderer.js";
import { NativeEditTracker } from "./native-edit-tracker.js";
import { PointerGestures } from "./pointer-gestures.js";
import { DomReconciler } from "./dom-reconciler.js";
import { HistoryManager, type HistorySnapshot, type HistoryState } from "./history.js";
import { SelectionMapping } from "./selection-mapping.js";
import { EventController } from "./event-controller.js";
import { DocumentController, type DocumentControllerSnapshot } from "./document-controller.js";

/**
 * Marks an error thrown by user-supplied code (onKeyDown, onSubmit, ...) while the editor
 * was handling a browser event. `executeBrowserEvent` uses it to report such errors with
 * phase "callback" and to skip the rollback, since the editor's own state is still valid.
 */
class BrowserCallbackError {
  constructor(readonly cause: unknown) {}
}

type TransactionState<Registry extends ItemRegistry> = {
  document: DocumentControllerSnapshot<Registry>;
  history: HistorySnapshot<Registry>;
  selection: ModelRange;
  nativeEditRecorded: boolean;
  reportedSelection: ModelRange | null | undefined;
};

/** The legacy `keyCode` an IME reports for a keydown it consumed. */
const IME_PROCESSING_KEY_CODE = 229;

/**
 * True when an IME is handling this keydown, so the editor must not act on it. `isComposing`
 * alone is not enough: the consumed keydown can arrive with it false but keyCode 229.
 * `keyCode` is deprecated in lib.dom, so it is read through a local type.
 */
function isImeKeyDown(event: KeyboardEvent): boolean {
  return event.isComposing || (event as { keyCode?: number }).keyCode === IME_PROCESSING_KEY_CODE;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * A contenteditable editor for plain text with typed, atomic inline items (mentions, tags, ...).
 *
 * ## The model is the source of truth
 *
 * The content is a `BillowDocument`: an array of strings and item nodes. Positions count one per
 * UTF-16 code unit of text and one per item (see `nodesWithPositions` in model.ts), and a selection
 * is a `ModelRange` of such positions. The DOM is only a rendering of the model, rebuilt by
 * `DomReconciler` (text nodes plus one host element per item, drawn by `ItemRenderer`).
 *
 * ## Who does what
 *
 * - `DocumentController`  holds the current document, validates it and reserves item IDs.
 * - `HistoryManager`      undo/redo stacks, typing/deleting grouping and IME composition baselines.
 * - `DomReconciler`       model -> DOM (`render`) and DOM -> model (`readDocument`).
 * - `ItemRenderer`        lifecycle of the elements that items render into.
 * - `SelectionMapping`    converts between DOM selection points and model positions.
 * - `EventController`     registers the DOM listeners; every one runs through `executeBrowserEvent`.
 * - `PointerGestures`     mouse/touch handling for inert items.
 *
 * This class connects them: the public API, the keyboard/input/clipboard/selection handlers
 * below, and the commit pipeline. Start reading at the constructor, then at `handleBeforeInput`.
 *
 * ## Two ways an edit happens
 *
 * 1. Intercepted: the handler calls `preventDefault()` and applies the edit to the model itself
 *    through `commit()`, which records history, swaps the document, re-renders the DOM and then
 *    notifies `onChange`/`onSelectionChange`. Used for everything the browser cannot do exactly:
 *    anything touching an item, Enter, undo/redo, deletions across graphemes or next to items,
 *    and typing where the DOM cannot hold a caret faithfully (right after a newline, or in an
 *    item or caret placeholder).
 * 2. Native: for plain typing and deleting in text the browser's own edit is allowed to happen.
 *    `handleBeforeInput` only records history and captures a restore point (`NativeEditTracker`); then
 *    `handleInput` reads the DOM back into a document, validates it, and either adopts it or
 *    restores that captured state if it is rejected. This keeps spell-check, autocorrect and
 *    mobile keyboards working.
 *
 * During IME composition the browser owns the DOM entirely; the result is read back once, in
 * `handleCompositionEnd`.
 *
 * ## Failure handling
 *
 * Browser listeners are wrapped by `executeBrowserEvent`, which rolls back to a captured
 * `TransactionState` on internal failure and reports through `onError`. Errors thrown by user
 * callbacks are tagged with `BrowserCallbackError` so they are reported without a rollback.
 *
 * ## Terms used in this file
 *
 * - item: a typed inline unit in the document (a mention, tag, ...). Older names in the code,
 *   such as "atom" and "atomic", mean the same thing. An item is one position wide, and its
 *   DOM content is `inert`, so the browser treats it as a single opaque unit.
 * - model position: a number from 0 to the document length. A `ModelRange` has an `anchor`
 *   (where the selection started) and a `focus` (the end that moves); either can be smaller.
 * - DOM point: a browser selection endpoint (node + offset). `SelectionMapping` converts
 *   between DOM points and model positions, and they are not interchangeable.
 * - grapheme: one user-perceived character, which can span several code units (emoji, combining
 *   marks). A caret or deletion never lands inside one; see `expandEditingRange`.
 * - logical line: the text between two "\n" characters. A visual line is one the browser wrapped.
 * - native edit: the browser changed the DOM itself and we read the result back.
 *   Intercepted edit: we cancelled the event and changed the model ourselves.
 * - canonical DOM: exactly the DOM shape `DomReconciler.render` would produce. A native edit can
 *   leave something else behind (extra blocks, stray `<br>`s), which is detected and re-rendered.
 * - sentinel: a helper node in the DOM that is not part of the document. See dom-normalization.ts.
 * - history group: a run of typing or deleting merged into one undo step. A "boundary" ends it.
 * - observers: the `onChange` and `onSelectionChange` callbacks.
 */
export class BillowEditor<Registry extends ItemRegistry = ItemRegistry> {
  // Collaborators; see the class comment.
  private readonly documentController: DocumentController<Registry>;
  private readonly history: HistoryManager<Registry>;
  private readonly itemRenderer: ItemRenderer<Registry>;
  private readonly domReconciler: DomReconciler<Registry>;
  private readonly selectionMapping: SelectionMapping<Registry>;
  private readonly pointerGestures: PointerGestures<Registry>;
  private eventController: EventController | undefined;

  // Options fixed at construction.
  private readonly registry: Registry;
  private readonly onChange: ((document: BillowDocument<Registry>) => void) | undefined;
  private readonly onSubmit: ((document: BillowDocument<Registry>) => void) | undefined;
  private readonly onKeyDown: ((event: KeyboardEvent) => void) | undefined;
  private readonly onPaste: ((event: ClipboardEvent) => void) | undefined;
  private readonly onSelectionChange: ((selection: ModelRange | null) => void) | undefined;
  private readonly onError: ((error: unknown, context: BillowEditorErrorContext) => void) | undefined;
  private readonly transformStructuredPaste: ((context: StructuredPasteContext<Registry>) => BillowDocument<Registry> | null) | undefined;

  // Options that can change later through setters.
  private readOnly: boolean;
  private enterBehavior: "newline" | "submit";
  private renderContext: ItemPresentation<Registry>;
  private placeholder: string | undefined;
  /** True once this editor has set `aria-placeholder`, so it only removes an attribute it added. */
  private managesAriaPlaceholder = false;

  private destroyed = false;

  /**
   * Edits the browser makes itself, and IME composition. The restore point is everything as it
   * was at `beforeinput`, used if the edit turns out invalid or throws.
   */
  private readonly nativeEdit = new NativeEditTracker<TransactionState<Registry>>();

  // Selection state.
  /**
   * The last selection expressed against the current document. After a native edit the live DOM
   * selection already belongs to the new document, so this is the only record of the old caret.
   */
  private lastSelection: ModelRange | null = null;
  /** The last value handed to `onSelectionChange` (`undefined`: never reported), to skip repeats. */
  private reportedSelection: ModelRange | null | undefined;
  /** Set while re-rendering, so the intermediate DOM selection changes are not reported. */
  private suppressSelectionNotifications = false;
  /** The fixed end of a Shift+Arrow selection, remembered across the selectionchange the arrow causes. */
  private pendingShiftAnchor: number | null = null;

  /** The event currently being handled; decides whether observer errors are tagged as callback errors. */
  private activeBrowserEvent: Event | null = null;

  constructor(
    private readonly element: HTMLElement,
    options: BillowEditorOptions<Registry>,
  ) {
    const originalAttributes = [...element.attributes].map(({ name, value }) => [name, value] as const);
    const originalChildren = [...element.childNodes];
    this.registry = options.registry;
    this.history = new HistoryManager(options.historyLimit);
    this.onChange = options.onChange;
    this.onSubmit = options.onSubmit;
    this.onKeyDown = options.onKeyDown;
    this.onPaste = options.onPaste;
    this.onSelectionChange = options.onSelectionChange;
    this.onError = options.onError;
    this.transformStructuredPaste = options.transformStructuredPaste;
    this.readOnly = options.readOnly ?? false;
    this.enterBehavior = options.enterBehavior ?? "newline";
    this.placeholder = options.placeholder;
    this.renderContext = options.renderContext as ItemPresentation<Registry>;
    this.itemRenderer = new ItemRenderer(
      element,
      this.registry,
      () => this.renderContext,
      (error, itemId) => this.reportRendererError(error, itemId),
    );
    this.domReconciler = new DomReconciler(
      element,
      this.itemRenderer,
      () => this.document,
      () => this.placeholder,
      (selection) => this.applySelection(selection),
    );
    this.documentController = new DocumentController(
      this.registry,
      options.value ?? [],
      options.validateDocument,
      options.createId,
    );
    this.selectionMapping = new SelectionMapping(
      element,
      () => this.document,
      (node): node is HTMLElement => this.domReconciler.isTrackedItemElement(node),
    );
    this.pointerGestures = new PointerGestures(element, this.itemRenderer, this.selectionMapping, {
      getDocument: () => this.document,
      isReadOnly: () => this.readOnly,
      isDestroyed: () => this.destroyed,
      applySelection: (range) => this.applySelection(range),
      endHistoryGroup: () => this.history.boundary(),
      clearShiftAnchor: () => {
        this.pendingShiftAnchor = null;
      },
    });
    try {
      element.setAttribute("data-billow-editor", "");
      if (!element.hasAttribute("role")) element.setAttribute("role", "textbox");
      if (!element.hasAttribute("aria-multiline")) element.setAttribute("aria-multiline", "true");
      this.applyPlaceholderAttributes();
      this.applyReadOnlyState();
      this.eventController = new EventController(element, {
        keyDown: this.handleKeyDown,
        beforeInput: this.handleBeforeInput,
        input: this.handleInput,
        copy: this.handleCopy,
        cut: this.handleCut,
        paste: this.handlePaste,
        compositionStart: this.handleCompositionStart,
        compositionEnd: this.handleCompositionEnd,
        pointerDown: (event) => this.pointerGestures.handlePointerDown(event),
        pointerMove: (event) => this.pointerGestures.handlePointerMove(event),
        pointerEnd: (event) => this.pointerGestures.handlePointerEnd(event),
        mouseDown: (event) => this.pointerGestures.handleMouseDown(event),
        doubleClick: (event) => this.pointerGestures.handleDoubleClick(event),
        historyBoundary: this.handleHistoryBoundary,
        documentPointerDown: this.handleDocumentPointerDown,
        selectionChange: this.handleSelectionChange,
      }, (operation, event, dispatch) => this.executeBrowserEvent(operation, event, dispatch));
      this.domReconciler.render(this.endSelection(), false);
    } catch (error) {
      const errors = [error];
      try {
        this.eventController?.destroy();
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      try {
        this.itemRenderer.releaseAll();
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      element.replaceChildren(...originalChildren);
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
      for (const [name, value] of originalAttributes) element.setAttribute(name, value);
      if (errors.length > 1) throw new AggregateError(errors, "BillowEditor construction and cleanup failed");
      throw error;
    }
  }

  getDocument(): BillowDocument<Registry> {
    return this.document;
  }

  private get document(): BillowDocument<Registry> {
    return this.documentController.document;
  }

  private set document(document: BillowDocument<Registry>) {
    this.documentController.document = document;
  }

  setEnterBehavior(behavior: "newline" | "submit"): void {
    this.assertActive();
    this.enterBehavior = behavior;
  }

  setDocument(document: BillowDocument<Registry>): boolean {
    return this.replaceDocument(document, { history: "reset", selection: "end" });
  }

  replaceDocument(document: BillowDocument<Registry>, options: ReplaceDocumentOptions): boolean {
    this.assertActive();
    const next = this.documentController.normalize(document);
    if (!this.isValidDocument(next)) return false;
    const currentSelection = this.getSelection() ?? this.endSelection();
    const end = documentLength(next);
    const selection = options.selection === "end"
      ? { anchor: end, focus: end }
      : options.selection && options.selection !== "preserve"
        ? options.selection
        : { anchor: Math.min(currentSelection.anchor, end), focus: Math.min(currentSelection.focus, end) };
    this.assertSelection(next, selection);
    this.withRollback(this.captureTransactionState(), () => {
      if (options.history === "reset") {
        this.history.reset();
        this.documentController.resetIds(next);
      } else if (options.history === "record") {
        this.documentController.reserveIds(next);
        this.recordHistory();
      } else {
        this.history.boundary();
        this.documentController.reserveIds(next);
      }
      this.document = next;
      this.reconcileDocumentChange(selection);
    });
    if (this.nativeEdit.isComposing) this.history.setCompositionBaseline({ document: next, selection });
    this.emitObservers(selection);
    return true;
  }

  replaceRange(
    range: ModelRange,
    replacement: BillowDocument<Registry>,
    selection?: ModelRange,
  ): boolean {
    this.assertActive();
    this.assertSelection(this.document, range);
    const normalizedRange = expandEditingRange(this.document, range);
    const normalizedReplacement = this.documentController.normalize(replacement);
    const next = replaceModelRange(this.document, normalizedRange, normalizedReplacement);
    this.documentController.validateItems(next);
    const start = Math.min(normalizedRange.anchor, normalizedRange.focus);
    const defaultSelection = {
      anchor: start + documentLength(normalizedReplacement),
      focus: start + documentLength(normalizedReplacement),
    };
    const resolvedSelection = selection ?? defaultSelection;
    this.assertSelection(next, resolvedSelection);
    return this.commit(next, resolvedSelection);
  }

  getSelection(): ModelRange | null {
    if (this.destroyed) return null;
    const selection = this.element.ownerDocument.getSelection();
    if (!selection?.anchorNode || !selection.focusNode) return null;
    const range = this.selectionMapping.domSelectionToModel(selection);
    // selectionchange may be deferred until after callers inspect the result.
    // Keep the fixed keyboard endpoint stable during that short browser gap.
    return range && this.pendingShiftAnchor !== null
      ? { anchor: this.pendingShiftAnchor, focus: range.focus }
      : range;
  }

  getLastSelection(): ModelRange | null {
    return this.destroyed ? null : this.lastSelection;
  }

  setSelection(range: ModelRange): void {
    this.assertActive();
    this.history.boundary();
    this.pendingShiftAnchor = null;
    this.applySelection(range);
  }

  private applySelection(range: ModelRange): void {
    this.assertSelection(this.document, range);
    this.itemRenderer.setSelection(this.document, range);
    const anchor = this.selectionMapping.modelToDom(range.anchor);
    const focus = this.selectionMapping.modelToDom(range.focus);
    const selection = this.element.ownerDocument.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    if (typeof selection.setBaseAndExtent === "function") {
      selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    } else {
      const domRange = this.element.ownerDocument.createRange();
      domRange.setStart(anchor.node, anchor.offset);
      domRange.collapse(true);
      selection.addRange(domRange);
      selection.extend(focus.node, focus.offset);
    }
    this.lastSelection = range;
    this.notifySelectionChange(range);
    this.revealSelectionFocus(range.focus);
    this.element.ownerDocument.defaultView?.requestAnimationFrame(() => {
      if (this.destroyed) return;
      const current = this.getSelection();
      if (current?.anchor === range.anchor && current.focus === range.focus) {
        this.revealSelectionFocus(range.focus);
      }
    });
  }

  private revealSelectionFocus(position: number): void {
    if (this.element.ownerDocument.activeElement !== this.element) return;
    const caret = this.getClientRect(position);
    if (!caret) return;
    const surface = this.element.getBoundingClientRect();
    const left = surface.left + this.element.clientLeft;
    const top = surface.top + this.element.clientTop;
    const right = left + this.element.clientWidth;
    const bottom = top + this.element.clientHeight;
    if (this.element.scrollWidth > this.element.clientWidth) {
      if (caret.left < left) this.element.scrollLeft -= left - caret.left;
      else if (caret.right > right) this.element.scrollLeft += caret.right - right;
    }
    if (this.element.scrollHeight > this.element.clientHeight) {
      if (caret.top < top) this.element.scrollTop -= top - caret.top;
      else if (caret.bottom > bottom) this.element.scrollTop += caret.bottom - bottom;
    }
  }

  setReadOnly(readOnly: boolean): void {
    this.assertActive();
    if (this.readOnly === readOnly) return;
    const wasComposing = this.nativeEdit.isComposing;
    this.readOnly = readOnly;
    if (readOnly) {
      this.setComposing(false);
      this.history.cancelComposition();
      this.nativeEdit.setHistoryRecorded(false);
      if (wasComposing) this.domReconciler.render(this.lastSelection ?? this.endSelection());
    }
    this.applyReadOnlyState();
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  setPlaceholder(placeholder?: string): void {
    this.assertActive();
    if (this.placeholder === placeholder) return;
    this.placeholder = placeholder;
    this.applyPlaceholderAttributes();
    const selection = this.getSelection() ?? this.lastSelection ?? this.endSelection();
    this.domReconciler.render(selection);
  }

  setRenderContext(context: ItemPresentation<Registry>): void {
    this.assertActive();
    this.renderContext = context;
  }

  refreshItems(ids?: readonly string[]): void {
    this.assertActive();
    this.itemRenderer.refresh(this.document, ids);
  }

  getClientRect(position: number): DOMRectReadOnly | null {
    this.assertActive();
    const range = { anchor: position, focus: position };
    this.assertSelection(this.document, range);
    if (!this.element.isConnected) return null;
    for (const { node, index, start, end } of nodesWithPositions(this.document)) {
      if (typeof node === "string") continue;
      if (start === position) {
        const boundaries = this.itemRenderer.measureItemBoundaries(node.id);
        if (boundaries) return boundaries.before;
      }
      // Right after an item followed by text, the caret belongs to that text, not to the item.
      if (end === position && typeof this.document[index + 1] !== "string") {
        const boundaries = this.itemRenderer.measureItemBoundaries(node.id);
        if (boundaries) return boundaries.after;
      }
    }
    const domRange = this.element.ownerDocument.createRange();
    const point = this.selectionMapping.modelToDom(position);
    domRange.setStart(point.node, point.offset);
    domRange.collapse(true);
    const direct = domRange.getClientRects()[0];
    if (direct) return direct;
    const length = documentLength(this.document);
    if (length > 0) {
      const otherPosition = position < length ? moveByGrapheme(this.document, position, 1) : moveByGrapheme(this.document, position, -1);
      const other = this.selectionMapping.modelToDom(otherPosition);
      const start = position < otherPosition ? point : other;
      const end = position < otherPosition ? other : point;
      domRange.setStart(start.node, start.offset);
      domRange.setEnd(end.node, end.offset);
      const adjacent = domRange.getClientRects()[0];
      if (adjacent) return adjacent;
    }
    const surface = this.element.getBoundingClientRect();
    return surface.width || surface.height ? surface : null;
  }

  insertItem<Type extends ItemType<Registry>>(
    input: Readonly<{ itemType: Type; data: ItemData<Registry, NoInfer<Type>> }>,
  ): ItemId<Type> | null {
    this.assertActive();
    getItemDefinition(this.registry, input.itemType);
    const selection = this.getSelection() ?? this.endSelection();
    const id = this.documentController.createUniqueId();
    const item = { type: "item", id, itemType: input.itemType, data: input.data } as BillowNode<Registry>;
    const position = Math.min(selection.anchor, selection.focus) + 1;
    let accepted = false;
    try {
      accepted = this.commit(replaceModelRange(this.document, selection, [item]), { anchor: position, focus: position });
    } finally {
      const committed = this.document.some((node) => typeof node !== "string" && node.id === id);
      if (!committed) this.documentController.releaseId(id);
    }
    if (!accepted) {
      return null;
    }
    return id as ItemId<Type>;
  }

  updateItem<Type extends ItemType<Registry>>(
    id: ItemId<Type>,
    data: ItemData<Registry, NoInfer<Type>>,
  ): boolean {
    this.assertActive();
    const item = this.document.find((node) => typeof node !== "string" && node.id === id);
    if (!item || typeof item === "string") return false;
    const updateDocument = (document: BillowDocument<Registry>): BillowDocument<Registry> =>
      document.map((node) => typeof node !== "string" && node.id === id
        ? { ...node, data }
        : node);
    const updatedDocument = updateDocument(this.document);
    if (!this.isValidDocument(updatedDocument)) return false;
    const state = this.captureTransactionState();
    try {
      this.document = updatedDocument;
      this.history.mapDocuments(updateDocument);
      this.itemRenderer.rerender({ ...item, data } as Extract<BillowNode<Registry>, { type: "item" }>);
    } catch (error) {
      this.documentController.restore(state.document);
      this.history.restore(state.history);
      throw error;
    }
    this.onChange?.(this.document);
    return true;
  }

  undo(): boolean {
    return this.stepHistory("undo");
  }

  redo(): boolean {
    return this.stepHistory("redo");
  }

  /** Returns false when there is nothing to step to, or the target state fails `validateDocument`. */
  private stepHistory(direction: "undo" | "redo"): boolean {
    this.assertActive();
    const state = this.captureTransactionState();
    const target = this.history[direction](this.snapshot(), (document) => this.isValidDocument(document));
    if (!target) return false;
    this.withRollback(state, () => {
      this.document = target.document;
      this.reconcileDocumentChange(target.selection);
    });
    this.emitObservers(target.selection);
    return true;
  }

  focus(): void {
    this.assertActive();
    const selection = this.element.ownerDocument.activeElement === this.element
      ? this.getSelection()
      : null;
    this.element.focus();
    if (!selection) this.setSelection(this.lastSelection ?? this.endSelection());
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pointerGestures.cancelPending();
    this.element.removeAttribute("data-billow-editor");
    this.element.removeAttribute("data-billow-composing");
    const errors: unknown[] = [];
    try {
      this.eventController?.destroy();
    } catch (caught) {
      errors.push(caught);
    }
    try {
      this.itemRenderer.releaseAll();
    } catch (caught) {
      errors.push(caught);
    } finally {
      this.element.contentEditable = "false";
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "BillowEditor cleanup failed");
  }

  private assertActive(): void {
    if (this.destroyed) throw new Error("BillowEditor has been destroyed");
  }

  private executeBrowserEvent(
    operation: string,
    event: Event,
    dispatch: () => void,
  ): void {
    const state = this.stateToRestoreOnFailure(operation);
    this.activeBrowserEvent = event;
    try {
      dispatch();
    } catch (error) {
      const phase = error instanceof BrowserCallbackError ? "callback" : "mutation";
      let reportedError = error instanceof BrowserCallbackError ? error.cause : error;
      // A throwing user callback leaves the editor consistent, so only internal failures roll back.
      if (!(error instanceof BrowserCallbackError) && state) {
        try {
          this.restoreTransaction(state);
        } catch (rollbackError) {
          reportedError = new AggregateError([error, rollbackError], "Browser operation and rollback failed");
        }
      }
      this.nativeEdit.clearRestorePoint();
      if (!this.onError) throw reportedError;
      this.onError(reportedError, { origin: "browser-event", event, operation, phase });
    } finally {
      this.activeBrowserEvent = null;
    }
  }

  /**
   * What to restore if handling `operation` fails halfway.
   * - `copy` and `selectionchange` never change the document, so there is nothing to restore.
   * - `input` runs after the browser already edited the DOM, so the state captured in
   *   `beforeinput` (before the edit was recorded) is the one to go back to.
   */
  private stateToRestoreOnFailure(operation: string): TransactionState<Registry> | null {
    if (operation === "copy" || operation === "selectionchange") return null;
    if (operation === "input") {
      return this.nativeEdit.pendingRestorePoint
        ?? this.captureTransactionState(this.lastSelection ?? this.endSelection());
    }
    return this.captureTransactionState();
  }

  private reportRendererError(error: unknown, itemId: string): void {
    if (!this.onError) throw error;
    this.onError(error, { origin: "renderer", itemId });
  }

  private applyPlaceholderAttributes(): void {
    if (this.placeholder === undefined) {
      this.element.removeAttribute("data-billow-placeholder");
      if (this.managesAriaPlaceholder) this.element.removeAttribute("aria-placeholder");
      this.managesAriaPlaceholder = false;
      return;
    }
    this.element.setAttribute("data-billow-placeholder", this.placeholder);
    this.element.setAttribute("aria-placeholder", this.placeholder);
    this.managesAriaPlaceholder = true;
  }

  private assertSelection(document: BillowDocument<Registry>, range: ModelRange): void {
    const length = documentLength(document);
    if (!Number.isInteger(range.anchor) || !Number.isInteger(range.focus) || range.anchor < 0 || range.focus < 0 || range.anchor > length || range.focus > length) {
      throw new RangeError("Selection is outside the document");
    }
  }

  private isValidDocument(document: BillowDocument<Registry>): boolean {
    return this.documentController.isValid(document);
  }

  private applyReadOnlyState(): void {
    this.element.contentEditable = this.readOnly ? "false" : "true";
    this.element.setAttribute("aria-readonly", String(this.readOnly));
  }

  private notifySelectionChange(range: ModelRange | null): void {
    if (this.suppressSelectionNotifications) return;
    const previous = this.reportedSelection;
    if (previous !== undefined && (previous === null
      ? range === null
      : range !== null && previous.anchor === range.anchor && previous.focus === range.focus)) return;
    this.reportedSelection = range;
    try {
      this.onSelectionChange?.(range);
    } catch (error) {
      throw this.asCallbackFailure(error);
    }
  }

  private endSelection(): ModelRange {
    const end = documentLength(this.document);
    return { anchor: end, focus: end };
  }

  private snapshot(): HistoryState<Registry> {
    return { document: this.document, selection: this.getSelection() ?? this.endSelection() };
  }

  private recordHistory(group: "typing" | "deleting" | null = null): void {
    this.history.record(this.snapshot(), group);
  }

  private commit(next: BillowDocument<Registry>, selection: ModelRange, group: "typing" | "deleting" | null = null): boolean {
    const normalized = this.documentController.normalize(next);
    if (!this.isValidDocument(normalized)) return false;
    this.withRollback(this.captureTransactionState(), () => {
      this.documentController.reserveIds(normalized);
      this.recordHistory(group);
      this.pendingShiftAnchor = null;
      this.document = normalized;
      this.reconcileDocumentChange(selection);
    });
    this.emitObservers(selection);
    return true;
  }

  private emitDocumentChange(selection: ModelRange, reconcile = true): void {
    this.reconcileDocumentChange(selection, reconcile);
    this.emitObservers(selection);
  }

  private reconcileDocumentChange(selection: ModelRange, reconcile = true): void {
    this.suppressSelectionNotifications = true;
    try {
      if (reconcile) this.domReconciler.render(selection);
    } finally {
      this.suppressSelectionNotifications = false;
    }
  }

  private emitObservers(selection: ModelRange): void {
    const errors: unknown[] = [];
    try {
      this.onChange?.(this.document);
    } catch (error) {
      errors.push(error);
    }
    try {
      this.notifySelectionChange(selection);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) return;
    const callbackErrors = errors.map((error) => error instanceof BrowserCallbackError ? error.cause : error);
    const error = callbackErrors.length === 1
      ? callbackErrors[0]
      : new AggregateError(callbackErrors, "Multiple observer failures");
    throw this.asCallbackFailure(error);
  }

  /** Runs user-supplied code from inside a browser event handler, tagging any failure as theirs. */
  private callUserCallback<T>(callback: () => T): T {
    try {
      return callback();
    } catch (error) {
      throw new BrowserCallbackError(error);
    }
  }

  /**
   * Observers also run from public API calls (`commit`, `undo`, ...), where the caller should
   * see the original error. Only inside a browser event is it tagged for `executeBrowserEvent`.
   */
  private asCallbackFailure(error: unknown): unknown {
    return this.activeBrowserEvent ? new BrowserCallbackError(error) : error;
  }

  private captureTransactionState(selection = this.getSelection() ?? this.lastSelection ?? this.endSelection()): TransactionState<Registry> {
    return {
      document: this.documentController.snapshot(),
      history: this.history.snapshot(),
      selection,
      nativeEditRecorded: this.nativeEdit.historyRecorded,
      reportedSelection: this.reportedSelection,
    };
  }

  /**
   * Runs the mutating steps of an edit. If they fail after the document was swapped,
   * everything is restored to `state` before the error is rethrown.
   */
  private withRollback(state: TransactionState<Registry>, mutate: () => void): void {
    try {
      mutate();
    } catch (error) {
      if (this.document !== state.document.document) this.rollbackTransaction(state, error);
      throw error;
    }
  }

  private rollbackTransaction(
    state: TransactionState<Registry>,
    originalError: unknown,
  ): never {
    try {
      this.restoreTransaction(state);
    } catch (rollbackError) {
      throw new AggregateError([originalError, rollbackError], "BillowEditor transaction and rollback failed");
    }
    throw originalError;
  }

  private restoreTransaction(state: TransactionState<Registry>): void {
    this.documentController.restore(state.document);
    this.history.restore(state.history);
    this.nativeEdit.setHistoryRecorded(state.nativeEditRecorded);
    this.reportedSelection = state.reportedSelection;
    this.reconcileDocumentChange(state.selection);
  }

  private submit(): void {
    this.callUserCallback(() => this.onSubmit?.(this.document));
  }

  private insertText(text: string, range?: ModelRange, group: "typing" | null = null): void {
    const selection = expandEditingRange(this.document, range ?? this.getSelection() ?? this.endSelection());
    const start = Math.min(selection.anchor, selection.focus);
    this.commit(replaceModelRange(this.document, selection, [text]), {
      anchor: start + text.length,
      focus: start + text.length,
    }, group);
  }

  private deleteRange(range: ModelRange): void {
    const selection = expandEditingRange(this.document, range);
    if (selection.anchor === selection.focus) return;
    const start = Math.min(selection.anchor, selection.focus);
    const group = rangeTouchesItem(this.document, selection) ? null : "deleting";
    this.commit(replaceModelRange(this.document, selection, []), { anchor: start, focus: start }, group);
  }

  /**
   * Intercepts only the keys the browser cannot handle exactly; all other keys stay native.
   * Checks run in this order, and each early return ends handling of the key:
   *
   * 1. The user's `onKeyDown` runs first and may `preventDefault()`.
   * 2. Ignored while composing (IME) or read-only.
   * 3. Undo/redo shortcuts.
   * 4. Select All: history boundary only, so typing after it starts a new undo step.
   * 5. Enter: submit or insert a newline.
   * 6. Backspace/Delete: taken over only when `decideCharacterDeletion` (edit-rules.ts) says
   *    the browser cannot do it exactly (graphemes, newlines, deleting next to an item).
   * 7. Cmd/Ctrl+Arrow on a line holding only items: jump to the line edge.
   * 8. Navigation keys: history boundary only; the browser moves the caret.
   * 9. Left/Right: boundary, then correct the caret if the browser's move skips an item.
   */
  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    // Steps 1-2: let the user veto the key, and stay out of IME and read-only editors.
    this.callUserCallback(() => this.onKeyDown?.(event));
    if (event.defaultPrevented) return;
    if (this.nativeEdit.isComposing || isImeKeyDown(event)) return;
    if (this.readOnly) return;
    // A plain arrow press starts a fresh selection, so forget a remembered Shift anchor.
    if (!event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      this.pendingShiftAnchor = null;
    }
    // The shortcut modifier: Cmd on macOS, Ctrl elsewhere. Either counts.
    const primary = event.metaKey || event.ctrlKey;

    // Step 3: undo/redo (Ctrl+Y, and Cmd/Ctrl+Z with Shift for redo).
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      this.redo();
      return;
    }
    if (primary && !event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) this.redo(); else this.undo();
      return;
    }
    // Step 4: Select All. Nothing to intercept, only the undo-step boundary (the browser selects).
    // Chromium can deliver Select All's selectionchange after the next input, too late
    // to split the active typing group, so this boundary must precede native handling.
    if (primary && !event.altKey && event.key.toLowerCase() === "a") {
      this.history.boundary();
      return;
    }

    // Step 5: Enter never reaches the browser; it either submits or inserts "\n" into the model.
    // Shift+Enter always inserts a newline, even when Enter submits.
    if (event.key === "Enter") {
      event.preventDefault();
      this.enter(event.shiftKey ? "line-break" : "paragraph");
      return;
    }

    // Step 6: plain Backspace/Delete (no modifiers; word and line deletion go through beforeinput).
    // WebKit can omit beforeinput when Delete targets a multi-code-unit grapheme.
    // Take over only deletions that native DOM editing cannot represent exactly. When
    // `decideCharacterDeletion` finds the browser can do it, fall through and let it run;
    // `handleBeforeInput` then sees it as a native edit.
    if ((event.key === "Backspace" || event.key === "Delete")
      && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const direction = event.key === "Backspace" ? "backward" : "forward";
      const decision = decideCharacterDeletion(this.document, this.getSelection() ?? this.endSelection(), direction, null);
      if (decision.handler === "intercept") {
        event.preventDefault();
        this.deleteRange(decision.range);
        return;
      }
    }
    // Step 7: Cmd/Ctrl+Arrow. On a line that holds only items, jump to the line edge ourselves
    // (Shift keeps the anchor, extending the selection). Any other line is left to the browser.
    if (primary && !event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      const selection = this.getSelection();
      const boundary = selection && atomOnlyLineBoundary(
        this.document,
        selection.focus,
        event.key === "ArrowLeft" ? "backward" : "forward",
      );
      if (selection && boundary !== null && boundary !== selection.focus) {
        event.preventDefault();
        this.history.boundary();
        this.applySelection({
          anchor: event.shiftKey ? selection.anchor : boundary,
          focus: boundary,
        });
        return;
      }
    }

    // Step 8: other navigation keys. The browser moves the caret; we only end the undo step.
    // Navigation can be a no-op and emit no changed selection to end the active group.
    if (["Home", "End", "ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(event.key)) {
      this.history.boundary();
      return;
    }

    // Step 9: Left/Right. Everything below runs for these keys only.
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      this.history.boundary();
      const selection = this.getSelection();
      // Word movement (Alt/Ctrl+Arrow): the browser moves, we check afterwards that it did.
      if (selection && !event.metaKey && (event.altKey || event.ctrlKey)) {
        this.scheduleWordNavigationFallback(event, selection);
      }
      // Past this point only plain and Shift+Arrow remain: single-step moves, not word or line jumps.
      if (!selection || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.shiftKey) {
        // Chromium can move the fixed range endpoint from after an inert atom to
        // before it while the focus continues into text. Remember the keyboard
        // anchor for the selectionchange caused by this one native arrow action.
        this.pendingShiftAnchor = selection.anchor;
      }
      // Native arrows can skip an editable atom whose content is inert, especially
      // when the atom direction differs from its paragraph. Correct only a move
      // that physically crosses an atom boundary and leave all other arrows native.
      //
      // Find the item the caret is touching: crossing it is only possible when the focus sits
      // right before it (`fromBefore`) or right after it (`fromAfter`).
      const moveRight = event.key === "ArrowRight";
      for (const { node, start, end } of nodesWithPositions(this.document)) {
        if (typeof node === "string") continue;
        const fromBefore = start === selection.focus;
        const fromAfter = end === selection.focus;
        if (!fromBefore && !fromAfter) continue;
        const boundaries = this.itemRenderer.measureItemBoundaries(node.id);
        if (!boundaries) continue;
        // An item that wrapped onto the next line has its two edges on different lines;
        // "crossing" it is then not a horizontal move, so leave that to the browser.
        if (!boundaries.sameLine) continue;
        // Which way the caret moves on screen when it crosses the item, measured from the side
        // it is on now. In right-to-left text "after" is on the left, so this can be negative.
        const travel = fromBefore ? crossingDistance(boundaries) : -crossingDistance(boundaries);
        // If crossing goes the opposite way from the key, the browser's own move is not
        // crossing this item, so there is nothing to correct.
        if ((moveRight && travel <= 0) || (!moveRight && travel >= 0)) continue;
        // Cross the item: land on its far edge (end if we started before it, start if after).
        const target = fromBefore ? end : start;
        event.preventDefault();
        this.applySelection({
          anchor: event.shiftKey ? selection.anchor : target,
          focus: target,
        });
        return;
      }
    }
  };

  /**
   * The decision point between the two edit paths (see the class comment). Cancelable
   * `beforeinput` events are either intercepted here (`preventDefault()` plus a model edit) or
   * allowed to run natively, in which case the state is captured and history recorded here so
   * `handleInput` can adopt or undo the result.
   *
   * - `historyUndo`/`historyRedo`: always intercepted.
   * - `delete*`: native only if the browser would delete exactly the one plain-text character
   *   we would; word/line deletions are intercepted when they touch or sit next to an item.
   * - `insert*` text: intercepted when `shouldInterceptInsert` says so (item, caret placeholder,
   *   after a newline).
   * - `insertLineBreak`/`insertParagraph`: always intercepted (newline or submit).
   */
  private readonly handleBeforeInput = (event: InputEvent): void => {
    // Gate: decide whether this event is ours to look at.
    if (event.defaultPrevented) return;
    if (this.readOnly) {
      // Read-only editors take no edits at all; cancel whatever the browser was about to do.
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (this.nativeEdit.isComposing || event.isComposing) return;
    // A non-cancelable event cannot be intercepted. It is left to `handleInput`, which then
    // sees an edit that `beforeinput` never recorded (`nativeEdit.historyRecorded` stays false).
    if (!event.cancelable) return;

    // Undo/redo from the browser's own menus or gestures: use our history, not the browser's.
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault();
      if (event.inputType === "historyUndo") this.undo(); else this.redo();
      return;
    }

    // Deletions. For each, either do it ourselves in the model or let the browser delete.
    if (event.inputType.startsWith("delete")) {
      // `target` is the range the browser says it is about to delete, as a model range
      // (null if it gave none or it cannot be mapped). `direction` is null for types
      // with no direction, such as deleteByDrag.
      const target = this.inputTargetRange(event);
      const direction = event.inputType.endsWith("Backward") ? "backward"
        : event.inputType.endsWith("Forward") ? "forward"
          : null;
      // One Backspace/Delete press is decided character by character; anything larger (a word,
      // a line, a selection...) by whether it involves an item. See edit-rules.ts.
      const decision = event.inputType === "deleteContentBackward" || event.inputType === "deleteContentForward"
        ? decideCharacterDeletion(this.document, this.getSelection() ?? this.endSelection(), direction!, target)
        : decideRangeDeletion(this.document, this.getSelection(), direction, target);
      if (decision.handler === "intercept") {
        event.preventDefault();
        this.deleteRange(decision.range);
        return;
      }
      // Native path: let the browser delete.
      this.allowNativeEdit("deleting");
      return;
    }

    // Text insertion (typing, drops, ...), but not line breaks, which are handled below.
    if (event.inputType.startsWith("insert") && !["insertLineBreak", "insertParagraph"].includes(event.inputType)) {
      // Typing puts the text in `data`; other insert types, such as a drop, in `dataTransfer`.
      const data = event.data ?? event.dataTransfer?.getData("text/plain");
      if (data === undefined || data === null) return;
      const selection = this.inputTargetRange(event) ?? this.getSelection() ?? this.endSelection();
      // Intercept when the browser's own insertion would go somewhere it cannot handle.
      const mustHandle = shouldInterceptInsert(this.document, selection, {
        endpointInsideItem: () => this.selectionEndpointInsideItem(),
        endpointInsideCaretSentinel: () => this.selectionEndpointInsideCaretSentinel(),
      });
      // Plain typing (`insertText`) joins the current "typing" undo group; any other kind of
      // insertion gets its own undo step.
      const group = event.inputType === "insertText" ? "typing" : null;
      if (mustHandle) {
        event.preventDefault();
        this.insertText(normalizeLineEndings(data), selection, group);
      } else {
        // Native path, as for deletions above.
        this.allowNativeEdit(group);
      }
      return;
    }

    // Line breaks never go native: Enter inserts "\n" into the model (or submits).
    if (event.inputType === "insertLineBreak") {
      event.preventDefault();
      this.enter("line-break");
      return;
    }
    if (event.inputType === "insertParagraph") {
      event.preventDefault();
      this.enter("paragraph");
      return;
    }
  };

  /**
   * Enter. A "paragraph" (plain Enter) submits when `enterBehavior` is "submit"; a "line-break"
   * (Shift+Enter) always inserts a newline, as does a paragraph when Enter does not submit.
   */
  private enter(kind: "paragraph" | "line-break"): void {
    if (kind === "paragraph" && this.enterBehavior === "submit") this.submit();
    else this.insertText("\n");
  }

  /**
   * Lets the browser perform the edit that `beforeinput` announced. Captures what to restore if
   * `handleInput` rejects the result, and records the undo step now, since once the browser
   * has edited, the document and caret that history needs are no longer available.
   */
  private allowNativeEdit(group: "typing" | "deleting" | null): void {
    const restorePoint = this.captureTransactionState();
    this.recordHistory(group);
    this.nativeEdit.begin(restorePoint);
  }

  /**
   * Runs after the browser edited the DOM itself (the native path). Reads the DOM back into a
   * document and decides what to do with it:
   *
   * - read-only: undo the browser's change.
   * - unchanged: drop the history entry `handleBeforeInput` recorded, and re-render if the
   *   browser left the DOM in a shape the editor does not produce (not canonical).
   * - rejected by `validateDocument`: restore the state captured before the edit.
   * - otherwise: adopt it as the new document, fix up the caret, and notify observers.
   *
   * Ignored during composition; `handleCompositionEnd` does the same job once for the whole IME run.
   */
  private readonly handleInput = (event: Event): void => {
    // Rung 1: read-only, yet the browser edited anyway. Put the DOM back.
    if (this.readOnly) {
      const restorePoint = this.nativeEdit.takeRestorePoint();
      if (restorePoint) this.restoreTransaction(restorePoint);
      else this.domReconciler.render(this.lastSelection ?? this.endSelection());
      return;
    }
    // Rung 2: mid-composition. The IME is still changing the DOM; wait for compositionend.
    if (this.nativeEdit.isComposing) return;

    // `next` is what the DOM says the document is now. The rest of the function compares it
    // with `this.document`, which is still the document from before the browser's edit.
    const next = this.domReconciler.readDocument();

    // Rung 3: the content is unchanged (the browser may still have reshaped the DOM, which is
    // tidied up at the end of this branch). Undo the bookkeeping `handleBeforeInput` did for an
    // edit that did not change anything.
    if (documentsEqual(next, this.document)) {
      const restorePoint = this.nativeEdit.takeRestorePoint();
      if (restorePoint) {
        // Only the document and history go back; the DOM and caret were not disturbed.
        this.documentController.restore(restorePoint.document);
        this.history.restore(restorePoint.history);
        this.nativeEdit.setHistoryRecorded(restorePoint.nativeEditRecorded);
      } else {
        this.nativeEdit.setHistoryRecorded(false);
      }
      if (!this.domReconciler.isCanonicalDom()) this.domReconciler.render(this.getSelection() ?? this.endSelection());
      return;
    }

    // Rung 4: rejected by `validateDocument`. Go back to the state before the edit; if there is
    // none (the edit never went through `beforeinput`), re-render the DOM from the model.
    if (!this.isValidDocument(next)) {
      const restorePoint = this.nativeEdit.takeRestorePoint();
      if (restorePoint) this.restoreTransaction(restorePoint);
      else {
        this.nativeEdit.setHistoryRecorded(false);
        this.domReconciler.render(this.lastSelection ?? this.endSelection());
      }
      return;
    }

    // Rung 5: accept the edit. First the undo step, if `handleBeforeInput` did not record one.
    if (!this.nativeEdit.historyRecorded) {
      // With input-only edits the DOM is already mutated, so its live selection belongs
      // to `next`; use the last selection measured against the current document instead.
      this.history.record({
        document: this.document,
        selection: this.lastSelection ?? this.endSelection(),
      });
    }
    // The native edit is now settled, so clear the in-flight bookkeeping.
    this.nativeEdit.settle();
    // The DOM selection after input belongs to the new document. A remembered
    // pre-edit Shift anchor is useful for history, but must not shape this caret.
    this.pendingShiftAnchor = null;
    // Where the caret is now, as a model position in the new document.
    let selection = this.getSelection() ?? this.endSelection();
    // True if we override the caret below, which means the DOM selection must be re-applied.
    let selectionAdjusted = false;
    const inputType = "inputType" in event ? (event as InputEvent).inputType : "";
    // Removing a selected atom can leave WebKit's live range spanning the text that
    // moved together around it. Collapse from the pre-mutation model range instead.
    if (inputType.startsWith("delete")
      && this.lastSelection
      && this.lastSelection.anchor !== this.lastSelection.focus
      && rangeTouchesItem(this.document, this.lastSelection)
      && documentLength(next) < documentLength(this.document)) {
      const start = Math.min(this.lastSelection.anchor, this.lastSelection.focus, documentLength(next));
      selection = { anchor: start, focus: start };
      selectionAdjusted = true;
    }
    this.adoptDocumentFromDom(next, selection, selectionAdjusted);
  };

  /**
   * Makes `next`, a document read back from the DOM after the browser edited it, the current
   * document, and tells the observers. The DOM is already correct, so it is only re-rendered if
   * the browser left it in a non-canonical shape or `caretChanged` (we overrode the caret, so
   * the DOM selection has to be re-applied). If it is canonical, items the edit removed still
   * have live elements to release; a re-render would release them itself.
   */
  private adoptDocumentFromDom(next: BillowDocument<Registry>, selection: ModelRange, caretChanged = false): void {
    this.lastSelection = selection;
    this.document = next;
    const canonical = this.domReconciler.isCanonicalDom();
    if (canonical) this.itemRenderer.releaseMissing(this.document);
    this.emitDocumentChange(selection, caretChanged || !canonical);
  }

  private readonly handleCompositionStart = (): void => {
    if (this.readOnly) return;
    this.history.beginComposition(this.snapshot());
    this.setComposing(true);
  };

  /** Keeps the tracker and the `data-billow-composing` attribute (used by the CSS) in step. */
  private setComposing(composing: boolean): void {
    this.nativeEdit.setComposing(composing);
    if (composing) this.element.setAttribute("data-billow-composing", "");
    else this.element.removeAttribute("data-billow-composing");
  }

  /** Reads the finished IME composition back from the DOM; mirrors `handleInput` for one whole run. */
  private readonly handleCompositionEnd = (): void => {
    if (this.readOnly) return;
    this.setComposing(false);
    const next = this.domReconciler.readDocument();
    if (documentsEqual(next, this.document)) {
      this.history.cancelComposition();
      const selection = this.getSelection() ?? this.endSelection();
      this.lastSelection = selection;
      if (!this.domReconciler.isCanonicalDom()) this.domReconciler.render(selection);
      return;
    }
    if (!this.isValidDocument(next)) {
      this.history.cancelComposition();
      this.domReconciler.render(this.lastSelection ?? this.endSelection());
      return;
    }
    this.history.commitComposition();
    this.adoptDocumentFromDom(next, this.getSelection() ?? this.endSelection());
  };

  private readonly handleHistoryBoundary = (): void => {
    this.history.boundary();
  };

  /**
   * Word movement (Alt/Ctrl+Arrow) is left to the browser, then checked once it has run: if the
   * selection did not move, the editor moves it to the next word boundary itself.
   */
  private scheduleWordNavigationFallback(event: KeyboardEvent, before: ModelRange): void {
    const view = this.element.ownerDocument.defaultView;
    const native = this.element.ownerDocument.getSelection();
    if (!native || !view) return;
    const { anchorNode, anchorOffset, focusNode, focusOffset } = native;
    const document = this.document;
    // Firefox word movement and WebKit word extension can stall at an inert atom.
    // Compare DOM endpoints first: successful native movement needs neither another
    // model conversion nor a style/layout read. Only an unchanged selection falls back.
    view.setTimeout(() => {
      if (this.destroyed || this.nativeEdit.isComposing || this.readOnly || event.defaultPrevented
        || this.document !== document) return;
      const current = this.element.ownerDocument.getSelection();
      if (!current) return;
      const endpointsChanged = current.anchorNode !== anchorNode || current.anchorOffset !== anchorOffset
        || current.focusNode !== focusNode || current.focusOffset !== focusOffset;
      if (endpointsChanged) {
        // A new interior offset in canonical text is genuine movement. At edges,
        // Firefox can instead switch DOM representations of the same model boundary.
        const focus = current.focusNode;
        if ((focus !== focusNode || current.focusOffset !== focusOffset)
          && focus?.nodeType === Node.TEXT_NODE && focus.parentNode === this.element
          && current.focusOffset > 0 && current.focusOffset < (focus.textContent?.length ?? 0)) return;
        const range = this.selectionMapping.domSelectionToModel(current);
        if (!range || range.anchor !== before.anchor || range.focus !== before.focus) return;
      }
      const arrowRight = event.key === "ArrowRight";
      const rtl = view.getComputedStyle(this.element).direction === "rtl";
      const direction = arrowRight !== rtl ? 1 : -1;
      const target = wordMoveTarget(this.document, before.focus, direction);
      if (target !== before.focus) {
        this.applySelection({ anchor: event.shiftKey ? before.anchor : target, focus: target });
      }
    }, 0);
  }

  /** In a read-only editor, a press elsewhere on the page clears this editor's selection. */
  private readonly handleDocumentPointerDown = (event: PointerEvent): void => {
    if (!this.readOnly || this.element.contains(event.target as Node)) return;
    const selection = this.element.ownerDocument.getSelection();
    const belongsToElement = (node: Node | null): boolean => Boolean(
      node && (node === this.element || this.element.contains(node)),
    );
    const ownsNativeSelection = belongsToElement(selection?.anchorNode ?? null)
      || belongsToElement(selection?.focusNode ?? null);
    this.itemRenderer.setSelection(this.document, null);
    if (!ownsNativeSelection) return;
    selection!.removeAllRanges();
    this.notifySelectionChange(null);
  };

  /**
   * Mirrors the browser's selection into the model: converts it, restores a remembered
   * Shift+Arrow anchor, starts a new undo step when the selection moved, updates which items
   * look selected, and reports it. If the browser put an endpoint inside an item, the selection
   * is re-applied so it snaps to the item's edge.
   */
  private readonly handleSelectionChange = (): void => {
    if (this.destroyed) return;
    const selection = this.element.ownerDocument.getSelection();
    if (!selection?.anchorNode || !selection.focusNode) {
      this.itemRenderer.setSelection(this.document, null);
      this.notifySelectionChange(null);
      return;
    }
    let nativeRange = this.selectionMapping.domSelectionToModel(selection);
    if (!nativeRange) {
      this.itemRenderer.setSelection(this.document, null);
      this.notifySelectionChange(null);
      return;
    }
    const shiftAnchorAdjusted = this.pendingShiftAnchor !== null
      && nativeRange.anchor !== this.pendingShiftAnchor;
    if (this.pendingShiftAnchor !== null) {
      nativeRange = { anchor: this.pendingShiftAnchor, focus: nativeRange.focus };
      // Keep the model anchor through repeated Shift+Arrow presses. Chromium's
      // native Selection remains normalized to the wrong side until it collapses.
      if (selection.isCollapsed || !shiftAnchorAdjusted) this.pendingShiftAnchor = null;
    }
    const { anchor, focus } = nativeRange;
    if (!this.lastSelection || this.lastSelection.anchor !== anchor || this.lastSelection.focus !== focus) {
      this.history.boundary();
    }
    this.lastSelection = nativeRange;
    this.itemRenderer.setSelection(this.document, nativeRange);
    this.notifySelectionChange(nativeRange);
    if (shiftAnchorAdjusted || this.selectionEndpointInsideItem()) {
      this.applySelection(nativeRange);
    }
  };

  private readonly handleCopy = (event: ClipboardEvent): void => {
    if (event.defaultPrevented) return;
    const selection = this.getSelection();
    if (!selection || selection.anchor === selection.focus || !event.clipboardData) return;
    event.preventDefault();
    const payload = createClipboardPayload(sliceDocument(this.document, selection), this.registry);
    event.clipboardData.setData("text/plain", payload.plainText);
    event.clipboardData.setData(CLIPBOARD_MIME, payload.metadata);
  };

  private readonly handleCut = (event: ClipboardEvent): void => {
    if (event.defaultPrevented) return;
    const current = this.getSelection();
    if (!current || current.anchor === current.focus || !event.clipboardData) return;
    const selection = expandEditingRange(this.document, current);
    event.preventDefault();
    const payload = createClipboardPayload(sliceDocument(this.document, selection), this.registry);
    event.clipboardData.setData("text/plain", payload.plainText);
    event.clipboardData.setData(CLIPBOARD_MIME, payload.metadata);
    if (this.readOnly) return;
    const start = Math.min(selection.anchor, selection.focus);
    this.commit(replaceModelRange(this.document, selection, []), { anchor: start, focus: start });
  };

  /**
   * The browser's own paste is always cancelled; the pasted content goes into the model.
   *
   * The clipboard can hold two versions of the content: our own structured metadata (with
   * items) and plain text. The structured one is used only if it is present and valid, the
   * user's `transformStructuredPaste` does not return null, and the resulting document passes
   * validation. In every other case the plain text is pasted instead.
   */
  private readonly handlePaste = (event: ClipboardEvent): void => {
    this.callUserCallback(() => this.onPaste?.(event));
    if (event.defaultPrevented) return;
    if (!event.clipboardData) return;
    event.preventDefault();
    if (this.readOnly) return;
    const selection = expandEditingRange(this.document, this.getSelection() ?? this.endSelection());
    // Parsing the structured version below gives every pasted item a new ID, which reserves it
    // in `documentController`. That is undone in the `finally`, so a paste that ends up using
    // plain text does not leave unused IDs reserved; `commit` reserves the ones really used.
    const documentState = this.documentController.snapshot();
    // The fallback: the plain text as a single string, with line endings normalized to "\n".
    const plain = [normalizeLineEndings(event.clipboardData.getData("text/plain"))] as BillowDocument<Registry>;
    let replacement: BillowDocument<Registry> = plain;
    try {
      const metadata = event.clipboardData.getData(CLIPBOARD_MIME);
      // null when there is no structured data, or it is too large or malformed.
      const structured = parseClipboardMetadata(metadata, this.registry, () => this.documentController.createUniqueId());
      if (structured) {
        // What the document would be, so the user's transform can look at the whole result.
        const initialProspective = replaceModelRange(this.document, selection, structured);
        const transformed = this.transformStructuredPaste
          ? this.callUserCallback(() => this.transformStructuredPaste!({
            document: this.document,
            range: selection,
            replacement: structured,
            prospectiveDocument: initialProspective,
          }))
          : structured;
        // The transform may have changed the content, so check it again before trusting it.
        if (transformed) {
          const normalized = this.documentController.normalize(transformed);
          const prospective = replaceModelRange(this.document, selection, normalized);
          this.documentController.validateItems(prospective);
          if (this.isValidDocument(prospective)) replacement = normalized;
        }
      }
    } finally {
      this.documentController.restore(documentState);
    }
    const start = Math.min(selection.anchor, selection.focus);
    this.commit(replaceModelRange(this.document, selection, replacement), {
      anchor: start + documentLength(replacement),
      focus: start + documentLength(replacement),
    });
  };

  private inputTargetRange(event: InputEvent): ModelRange | null {
    const target = event.getTargetRanges()[0];
    if (!target) return null;
    const anchor = this.selectionMapping.domToModel(target.startContainer, target.startOffset);
    const focus = this.selectionMapping.domToModel(target.endContainer, target.endOffset);
    return anchor === null || focus === null ? null : { anchor, focus };
  }

  private selectionEndpointInsideItem(): boolean {
    const selection = this.element.ownerDocument.getSelection();
    const inside = (node: Node | null): boolean => {
      let current = node;
      while (current && current !== this.element) {
        if (this.domReconciler.isTrackedItemElement(current)) return true;
        current = current.parentNode;
      }
      return false;
    };
    return inside(selection?.anchorNode ?? null) || inside(selection?.focusNode ?? null);
  }

  private selectionEndpointInsideCaretSentinel(): boolean {
    const selection = this.element.ownerDocument.getSelection();
    const inside = (node: Node | null): boolean => Boolean(node && (
      isCaretSentinel(node) || isCaretSentinel(node.parentNode)
    ));
    return inside(selection?.anchorNode ?? null) || inside(selection?.focusNode ?? null);
  }

}
