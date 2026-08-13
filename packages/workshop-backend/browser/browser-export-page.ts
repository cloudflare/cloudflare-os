// These functions run in the remote browser via Puppeteer's page.evaluate().
// While they are imported by the Worker, they never run in the Worker, and are
// typed for the browser environment. Functions that need to interact directly
// with client.js run in the main world. Everything else runs in an isolated
// realm.

declare global {
  // Globals set in the main world:

  /** Sends a Cap'n Web RPC message from the Worker to the browser-side session. */
  var __workshopExportSendToBrowser: (message: string) => void;
  /** Receives the next Cap'n Web RPC message from the browser-side session. */
  var __workshopExportReceiveFromBrowser: () => Promise<string>;
  /** Settles when the Gadget client module has finished loading. */
  var __workshopExportModulePromise: Promise<Record<string, unknown>>;

  // Globals set in the isolated realm:

  /** Sanitizes a complete HTML document inside Puppeteer's isolated realm. */
  var __workshopExportSanitizeHtml: (html: string) => HTMLHtmlElement;
}

// Functions that run in the main world:

/** Delivers one Cap'n Web RPC message to the browser-side session. */
export function sendToBrowser(message: string): void {
  globalThis.__workshopExportSendToBrowser(message);
}

/** Receives one Cap'n Web RPC message from the browser-side session. */
export function receiveFromBrowser(): Promise<string> {
  return globalThis.__workshopExportReceiveFromBrowser();
}

/** Waits for the Gadget client module to finish evaluating in the main world. */
export async function waitForClientModule(): Promise<void> {
  await globalThis.__workshopExportModulePromise;
}

// Functions that run in the isolated realm:

/** Waits until the rendered DOM has remained unchanged for the requested interval. */
export function waitForDomSettled(quietMs: number): Promise<void> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(finish, quietMs);
    });
    function finish() {
      observer.disconnect();
      resolve();
    }
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    timer = setTimeout(finish, quietMs);
  });
}

/** Assigns the title used by PDF viewers and the static HTML snapshot. */
export function setDocumentTitle(title: string): void {
  document.title = title;
}

/** Creates an inert, self-contained HTML snapshot unless it exceeds the byte limit. */
export function createStaticHtmlSnapshot(csp: string, maxBytes: number): string {
  const sanitized = globalThis.__workshopExportSanitizeHtml(
    `<!DOCTYPE html>\n${document.documentElement.outerHTML}`,
  );
  const ownerDocument = sanitized.ownerDocument;
  const policy = ownerDocument.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = csp;
  const charset = ownerDocument.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  ownerDocument.head!.prepend(charset, policy);
  const html = `<!DOCTYPE html>\n${sanitized.outerHTML}`;
  if (new TextEncoder().encode(html).byteLength > maxBytes) {
    throw new Error(`Gadget exports may not exceed ${maxBytes} bytes.`);
  }
  return html;
}

/** Returns fixed full-document dimensions after validating their pixel area. */
export function getValidatedScreenshotClip(maxPixels: number) {
  const root = document.documentElement;
  const width = root.scrollWidth;
  const height = root.scrollHeight;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= 0 || width > Math.floor(maxPixels / height)) {
    throw new Error(`Gadget screenshots may not exceed ${maxPixels} pixels.`);
  }
  return {x: 0, y: 0, width, height};
}
