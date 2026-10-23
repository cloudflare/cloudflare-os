import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type {
  ResourceConfiguratorHost, ResourceConfiguratorIframe,
} from "@gadgets/workshop-shared/gatekeeper";
import { collectResourceUrl, type ConfiguratorSession } from "./session.ts";
import type { ParentViewport } from "./store.ts";

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
export const reportSize = (host: Pick<ResourceConfiguratorHost, "resize">): void => {
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
