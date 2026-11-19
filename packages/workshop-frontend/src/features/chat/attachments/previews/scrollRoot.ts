/**
 * The nearest ancestor that scrolls, for an IntersectionObserver's root. Observed against the
 * viewport, an element inside a scroller is clipped by it before `rootMargin` applies, so a
 * margin meant to start work before the element scrolls into view would do nothing.
 */
export const scrollRoot = (element: Element): Element | null => {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(parent);
    if (/auto|scroll/.test(overflowY) || /auto|scroll/.test(overflowX)) return parent;
  }
  return null;
};
