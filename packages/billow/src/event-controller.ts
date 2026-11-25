export interface EventControllerHandlers {
  keyDown(event: KeyboardEvent): void;
  beforeInput(event: InputEvent): void;
  input(event: Event): void;
  copy(event: ClipboardEvent): void;
  cut(event: ClipboardEvent): void;
  paste(event: ClipboardEvent): void;
  compositionStart(event: Event): void;
  compositionEnd(event: Event): void;
  pointerDown(event: PointerEvent): void;
  pointerMove(event: PointerEvent): void;
  pointerEnd(event: PointerEvent): void;
  mouseDown(event: MouseEvent): void;
  doubleClick(event: MouseEvent): void;
  historyBoundary(event: Event): void;
  documentPointerDown(event: PointerEvent): void;
  selectionChange(event: Event): void;
}

export type BrowserEventExecutionBoundary = (
  operation: string,
  event: Event,
  dispatch: () => void,
) => void;

type Registration = {
  target: EventTarget;
  type: string;
  listener: EventListener;
  capture: boolean;
};

/**
 * Registers every DOM listener the editor uses and removes them again on `destroy`. Each
 * listener runs through `execute` (the editor's `executeBrowserEvent`), so every handler gets
 * the same error reporting and rollback without handling it itself.
 *
 * The `operation` argument of `add` is the name reported in error contexts. Two listeners are
 * attached to the editor's `ownerDocument` instead of the element: a press anywhere on the page
 * (to clear a read-only selection) and `selectionchange`, which fires on the document.
 */
export class EventController {
  private readonly registrations: Registration[] = [];
  private destroyed = false;

  constructor(
    element: HTMLElement,
    handlers: EventControllerHandlers,
    execute: BrowserEventExecutionBoundary,
  ) {
    const add = <EventType extends Event>(
      target: EventTarget,
      type: string,
      operation: string,
      handler: (event: EventType) => void,
      capture = false,
    ): void => {
      const listener: EventListener = (event) => execute(operation, event, () => handler(event as EventType));
      const registration = { target, type, listener, capture };
      this.registrations.push(registration);
      target.addEventListener(type, listener, capture);
    };

    try {
      add<KeyboardEvent>(element, "keydown", "keydown", handlers.keyDown);
      add<InputEvent>(element, "beforeinput", "beforeinput", handlers.beforeInput);
      add(element, "input", "input", handlers.input);
      add<ClipboardEvent>(element, "copy", "copy", handlers.copy);
      add<ClipboardEvent>(element, "cut", "cut", handlers.cut);
      add<ClipboardEvent>(element, "paste", "paste", handlers.paste);
      add(element, "compositionstart", "compositionstart", handlers.compositionStart);
      add(element, "compositionend", "compositionend", handlers.compositionEnd);
      add<PointerEvent>(element, "pointerdown", "pointerdown", handlers.pointerDown);
      add<PointerEvent>(element, "pointermove", "pointermove", handlers.pointerMove);
      add<PointerEvent>(element, "pointerup", "pointerend", handlers.pointerEnd);
      add<PointerEvent>(element, "pointercancel", "pointerend", handlers.pointerEnd);
      add<MouseEvent>(element, "mousedown", "mousedown", handlers.mouseDown);
      add<MouseEvent>(element, "dblclick", "dblclick", handlers.doubleClick);
      add(element, "blur", "blur", handlers.historyBoundary);
      add<PointerEvent>(element.ownerDocument, "pointerdown", "document-pointerdown", handlers.documentPointerDown, true);
      add(element.ownerDocument, "selectionchange", "selectionchange", handlers.selectionChange);
    } catch (error) {
      try {
        this.destroy();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Event listener registration and cleanup failed");
      }
      throw error;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const errors: unknown[] = [];
    for (const { target, type, listener, capture } of this.registrations) {
      try {
        target.removeEventListener(type, listener, capture);
      } catch (error) {
        errors.push(error);
      }
    }
    this.registrations.length = 0;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Event listener cleanup failed");
  }
}
