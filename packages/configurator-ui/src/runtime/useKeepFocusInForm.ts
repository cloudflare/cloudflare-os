import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * When a render removes the control that had focus (a Button whose step is over, such as Convert
 * once the copy is made), hands focus to the first control left in the form rather than dropping it
 * to the body, where the next Tab starts again from the host. Only while focus is in this frame: the
 * user may have moved on to the host while the step finished.
 *
 * Called by the form's root, so it checks after every render of the module's tree. Tracks focus from
 * the first commit, so a click landing before Preact's first passive effects is covered too.
 */
export const useKeepFocusInForm = (form: RefObject<HTMLElement | null>): void => {
  const focused = useRef<Element | null>(null);

  useLayoutEffect(() => {
    const node = form.current;
    if (!node) return;
    const track = (event: FocusEvent) => {
      focused.current = event.target as Element;
    };
    node.addEventListener("focusin", track);
    return () => node.removeEventListener("focusin", track);
  }, [form]);

  useLayoutEffect(() => {
    const lost = focused.current;
    if (!lost || lost.isConnected || document.activeElement !== document.body || !document.hasFocus()) return;
    focused.current = null;
    for (const control of form.current?.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]") ?? []) {
      if (control.tabIndex < 0) continue;
      control.focus();
      // Hidden and disabled controls refuse focus.
      if (document.activeElement === control) return;
    }
  });
};
