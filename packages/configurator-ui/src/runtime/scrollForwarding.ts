import type { ResourceConfiguratorHost } from "@gadgets/workshop-shared/gatekeeper";

/** A wheel gesture, trackpad momentum included, ends once its events pause this long. */
const WHEEL_GESTURE_GAP_MS = 200;

const canScroll = (element: Element, deltaX: number, deltaY: number): boolean => {
  const style = getComputedStyle(element);
  if (/auto|scroll/.test(style.overflowY)) {
    if (deltaY < 0 && element.scrollTop > 0) return true;
    if (deltaY > 0 && element.scrollTop + element.clientHeight < element.scrollHeight - 1) return true;
  }
  if (/auto|scroll/.test(style.overflowX)) {
    if (deltaX < 0 && element.scrollLeft > 0) return true;
    if (deltaX > 0 && element.scrollLeft + element.clientWidth < element.scrollWidth - 1) return true;
  }
  return false;
};

/** Whether something under the pointer can consume the scroll itself. */
const scrollsWithin = (target: EventTarget | null, deltaX: number, deltaY: number): boolean => {
  for (let element = target instanceof Element ? target : null;
    element && element !== document.body && element !== document.documentElement;
    element = element.parentElement) {
    if (canScroll(element, deltaX, deltaY)) return true;
  }
  return false;
};

/**
 * Forwards wheel and touch scrolls to the host so the modal scrolls when the pointer is over the
 * frame. A scroll that something inside the frame can consume is left to the browser, so a long list
 * scrolls rather than moving the modal underneath it -- including trackpad momentum, which a manual
 * `scrollBy` would lose. As the browser does with nested scrollers, the rest of the gesture goes the
 * same way: a list reaching its end does not hand it to the modal, and a list the modal slides under
 * the pointer does not take it over. A wheel gesture ends when the wheel pauses or turns back, which
 * momentum never does.
 */
export const forwardScrolls = (host: Pick<ResourceConfiguratorHost, "forwardScroll">): void => {
  let pendingX = 0;
  let pendingY = 0;
  let scheduled = false;
  const forward = (deltaX: number, deltaY: number) => {
    pendingX += deltaX;
    pendingY += deltaY;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const [x, y] = [pendingX, pendingY];
      pendingX = 0;
      pendingY = 0;
      if (x || y) host.forwardScroll(x, y);
    });
  };

  let wheelForwarded = false;
  let wheelGestureEnd = -Infinity;
  let wheelDeltaY = 0;
  window.addEventListener("wheel", event => {
    // Pinch and Ctrl+wheel zoom the page.
    if (event.ctrlKey) return;
    // Turning back counts only vertically: a vertical swipe's small horizontal deltas can flip sign.
    if (event.timeStamp > wheelGestureEnd || event.deltaY * wheelDeltaY < 0) {
      wheelForwarded = !scrollsWithin(event.target, event.deltaX, event.deltaY);
    }
    wheelGestureEnd = event.timeStamp + WHEEL_GESTURE_GAP_MS;
    wheelDeltaY = event.deltaY || wheelDeltaY;
    if (!wheelForwarded) return;
    // Cancelled, hence not passive, so a list moving under the pointer does not scroll as well.
    event.preventDefault();
    forward(event.deltaX, event.deltaY);
  }, { passive: false });

  // A touch keeps its target throughout, so only a list reaching its end could hand it over.
  let lastTouch = { x: 0, y: 0 };
  let touchScrollsWithin = false;
  window.addEventListener("touchstart", event => {
    const touch = event.touches[0];
    if (touch) lastTouch = { x: touch.clientX, y: touch.clientY };
    touchScrollsWithin = false;
  }, { passive: true });
  window.addEventListener("touchmove", event => {
    const touch = event.touches[0];
    if (!touch) return;
    // A drag up the screen scrolls content down, matching wheel's sign convention.
    const deltaX = lastTouch.x - touch.clientX;
    const deltaY = lastTouch.y - touch.clientY;
    lastTouch = { x: touch.clientX, y: touch.clientY };
    touchScrollsWithin ||= scrollsWithin(event.target, deltaX, deltaY);
    if (!touchScrollsWithin) forward(deltaX, deltaY);
  }, { passive: true });
};
