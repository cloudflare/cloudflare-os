import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type { ResourceConfiguratorIframe } from "@gadgets/workshop-shared/gatekeeper";
import { collectResourceUrl, type ConfiguratorSession } from "./session.ts";
import type { ParentViewport } from "./store.ts";

/** The part of `ResourceConfiguratorHost` the frame's own chrome talks to. */
export type FrameHost = {
  resize(height: number, layoutHeight: number): void;
  forwardScroll(deltaX: number, deltaY: number): void;
};

/** What the Workshop calls on the frame. Usable before the configurator has started. */
@validateRpc<ResourceConfiguratorIframe>()
export class ConfiguratorFrame extends RpcTarget implements ResourceConfiguratorIframe {
  #session: ConfiguratorSession | undefined;
  #viewport: ParentViewport = { iframeTop: 0, viewportHeight: 0 };

  /** Static so the Workshop cannot reach it: RPC exposes the instance's methods, not the class's. */
  static attach(frame: ConfiguratorFrame, session: ConfiguratorSession): void {
    frame.#session = session;
    session.store.setViewport(frame.#viewport);
  }

  async collectResourceUrl(): Promise<string> {
    if (!this.#session) throw new Error("Configurator has not finished starting.");
    return collectResourceUrl(this.#session);
  }

  updateViewport(iframeTop: number, viewportHeight: number): void {
    if (!Number.isFinite(iframeTop) || !Number.isFinite(viewportHeight)) return;
    this.#viewport = { iframeTop, viewportHeight };
    this.#session?.store.setViewport(this.#viewport);
  }

  windowResized(): void {
    this.#session?.store.requestPopupClose();
  }
}

/**
 * Keeps the host's iframe sized to the form, plus any popup hanging below it. `layoutHeight` is what
 * the modal reserves; `height` may be larger so a dropdown can overlap the modal's footer without
 * pushing it down.
 */
export const reportSize = (host: FrameHost): void => {
  let lastHeight = -1;
  let lastLayoutHeight = -1;
  let scheduled = false;
  const post = () => {
    scheduled = false;
    const docTop = document.documentElement.getBoundingClientRect().top;
    const layoutRoot = document.getElementById("layout-root") ?? document.getElementById("root");
    const layoutBottom = layoutRoot ? layoutRoot.getBoundingClientRect().bottom - docTop : 0;
    // Base UI marks every positioned popup with `data-side`; they portal outside the layout root.
    const floatingBottom = Math.max(0, ...Array.from(document.querySelectorAll("[data-side]"),
      node => node.getBoundingClientRect().bottom - docTop));
    const height = Math.ceil(Math.max(layoutBottom, floatingBottom) + 8);
    const layoutHeight = Math.ceil(layoutBottom + 4);
    if (height === lastHeight && layoutHeight === lastLayoutHeight) return;
    lastHeight = height;
    lastLayoutHeight = layoutHeight;
    host.resize(height, layoutHeight);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(post);
  };
  new ResizeObserver(schedule).observe(document.documentElement);
  // Popups open and close without resizing the document, since they are positioned.
  new MutationObserver(schedule).observe(document.body,
    { subtree: true, childList: true, attributes: true });
};

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
export const scrollsWithin = (target: EventTarget | null, deltaX: number, deltaY: number): boolean => {
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
 * `scrollBy` would lose.
 */
export const forwardScrolls = (host: FrameHost): void => {
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

  window.addEventListener("wheel", event => {
    if (!scrollsWithin(event.target, event.deltaX, event.deltaY)) forward(event.deltaX, event.deltaY);
  }, { passive: true });

  let lastTouch = { x: 0, y: 0 };
  window.addEventListener("touchstart", event => {
    const touch = event.touches[0];
    if (touch) lastTouch = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  window.addEventListener("touchmove", event => {
    const touch = event.touches[0];
    if (!touch) return;
    // A drag up the screen scrolls content down, matching wheel's sign convention.
    const deltaX = lastTouch.x - touch.clientX;
    const deltaY = lastTouch.y - touch.clientY;
    lastTouch = { x: touch.clientX, y: touch.clientY };
    if (!scrollsWithin(event.target, deltaX, deltaY)) forward(deltaX, deltaY);
  }, { passive: true });
};
