import { launch, type Page } from "@cloudflare/puppeteer";
import { RpcSession, type RpcStub, type RpcTransport } from "capnweb";
import { createLogger } from "@gadgets/backend-utils/logger";
import type { GadgetExportFormat } from "@gadgets/workshop-shared/api";
import BROWSER_EXPORT_RUNTIME from "./generated/browser-export-runtime.txt";
import HTML_SANITIZER_RUNTIME from "./generated/html-sanitizer-runtime.txt";
import {
  createStaticHtmlSnapshot,
  getValidatedScreenshotClip,
  receiveFromBrowser,
  sendToBrowser,
  setDocumentTitle,
  waitForClientModule,
  waitForDomSettled,
} from "./generated/browser-export-page.js";
import { createExportDeadline, limitExportStream, MAX_EXPORT_BYTES } from "./export-limits";

type BrowserExportLogFields = {
  event?: string;
  error?: unknown;
};

const logger = createLogger<BrowserExportLogFields>({ component: "workshop.browser-export" });

/** Compatibility fallback for clients that schedule DOM work outside top-level await. */
const DOM_SETTLE_MS = 250;
/** Budget for releasing the browser session once an export has settled. */
const BROWSER_CLOSE_TIMEOUT_MS = 10_000;
/** Maximum number of pending Worker-to-browser RPC messages. */
const MAX_PENDING_RPC_SENDS = 1024;
/** Maximum total string length across all pending Worker-to-browser RPC messages. */
const MAX_PENDING_RPC_SEND_CHARS = 32 * 1024 * 1024;
/** Largest full-page screenshot capture, before image compression. */
const MAX_SCREENSHOT_PIXELS = 25_000_000;
/** CSP ignores `sandbox` in a meta tag, so serve the document through interception with a header. */
const EXPORT_DOCUMENT_URL = "https://gadget-export.invalid/";
// TODO: CSP and request interception do not cover WebRTC/STUN. The same gap exists for Gadgets
// running inside an iframe in the user's browser. We should close the gap in both places. For now,
// extending the same gap to remotely-rendered gadgets is acceptable.
const EXPORT_DOCUMENT_CSP = "default-src 'none'; frame-src 'none'; script-src data:; " +
  "style-src data: 'unsafe-inline'; img-src data: blob:; media-src data: blob:; " +
  "font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; " +
  "connect-src 'none'; sandbox allow-scripts;";
const STATIC_HTML_CSP = "default-src 'none'; frame-src 'none'; script-src 'none'; " +
  "style-src data: 'unsafe-inline'; img-src data:; media-src data:; font-src data:; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';";

// Puppeteer's isolated realm is intentionally absent from its public bundled types, though its
// own security-sensitive DOM helpers use it. Keep this narrow until the method is public.
type FrameWithIsolatedRealm = ReturnType<Page["mainFrame"]> & {
  isolatedRealm(): Pick<Page, "evaluate">;
};

async function closeBrowser(browser: Awaited<ReturnType<typeof launch>>): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      browser.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Closing the export browser timed out.")),
            BROWSER_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.warn("failed to close browser after gadget export", {
      event: "gadget.export.browser.close.failed",
      error,
    });
  } finally {
    clearTimeout(timer!);
  }
}

/** Ordered CDP transport for the RPC session between the Worker and remote browser. */
export class BrowserRpcTransport implements RpcTransport {
  #sendChain = Promise.resolve();
  #pendingSendCount = 0;
  #pendingSendChars = 0;
  #abortReason = Promise.withResolvers<Error>();

  constructor(private page: Page) {}

  send(message: string): Promise<void> {
    if (this.#pendingSendCount >= MAX_PENDING_RPC_SENDS ||
        message.length > MAX_PENDING_RPC_SEND_CHARS - this.#pendingSendChars) {
      let error = new Error("The Gadget export RPC send queue overflowed.");
      this.abort(error);
      return Promise.reject(error);
    }

    ++this.#pendingSendCount;
    this.#pendingSendChars += message.length;
    let delivered = this.#sendChain.then(() =>
      this.#untilAborted(this.page.evaluate(sendToBrowser, message)));
    let settled = delivered.finally(() => {
      --this.#pendingSendCount;
      this.#pendingSendChars -= message.length;
    });
    this.#sendChain = settled.catch(() => {});
    return settled;
  }

  async receive(): Promise<string> {
    let message = await this.#untilAborted(
      this.page.evaluate(receiveFromBrowser),
    );
    if (typeof message !== "string") {
      throw new Error("The Gadget export RPC message from the browser was not a string.");
    }
    return message;
  }

  /**
   * Rejects in-flight and queued operations rather than only marking a flag, so a stalled page
   * cannot keep the RPC session alive after the export has settled.
   */
  abort(reason: unknown): void {
    this.#abortReason.resolve(reason instanceof Error ? reason : new Error(String(reason)));
  }

  #untilAborted<T>(work: Promise<T>): Promise<T> {
    return Promise.race([
      work,
      this.#abortReason.promise.then(reason => { throw reason; }),
    ]);
  }
}

function scriptUrl(source: string): string {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

function makeExportHtml(clientCode: string, formatId: string): string {
  let clientPrefix = String.raw`//# sourceURL=client.js
const { gadget, RpcStub, RpcTarget } = globalThis.__workshopExportRuntime;
delete globalThis.__workshopExportRuntime;
`;
  let clientUrl = scriptUrl(clientPrefix + clientCode);
  let runtimeUrl = scriptUrl(
      `globalThis.gadgetExportFormatId = ${JSON.stringify(formatId)};\n` +
      `globalThis.__workshopExportClientUrl = ${JSON.stringify(clientUrl)};\n` +
      BROWSER_EXPORT_RUNTIME);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body>
  <script src="${runtimeUrl}"></script>
</body>
</html>`;
}

/**
 * Renders a Gadget's browser-mode export and streams the bytes back.
 *
 * Takes ownership of `gadget` and disposes it once the export settles. The
 * returned stream must be consumed or cancelled: the browser session stays open
 * until it settles or times out.
 */
export async function renderGadgetInBrowser(
  browserBinding: BrowserRun,
  clientCode: string,
  documentTitle: string,
  gadget: RpcStub<any>,
  format: GadgetExportFormat,
): Promise<ReadableStream<Uint8Array>> {
  const deadline = createExportDeadline("Browser export timed out.");

  let launchPromise = launch(browserBinding);
  let browser: Awaited<ReturnType<typeof launch>>;
  try {
    browser = await deadline.race(launchPromise);
  } catch (error) {
    deadline.clear();
    gadget[Symbol.dispose]();
    // A timed-out launch cannot be cancelled. Close it if it eventually produces a browser.
    void launchPromise.then(closeBrowser, () => {});
    logger.warn("failed to launch browser for gadget export", {
      event: "gadget.export.browser.launch.failed",
      error,
    });
    throw error;
  }

  let sessionCloser: RpcStub<any> | undefined;
  let releasePromise: Promise<void> | undefined;
  let release = () => {
    if (!releasePromise) {
      releasePromise = (async () => {
        deadline.clear();
        if (sessionCloser) {
          sessionCloser[Symbol.dispose]();
        } else {
          // RpcSession takes ownership of its local main object. Before it exists, ownership remains
          // here and setup failures must release the stub directly.
          gadget[Symbol.dispose]();
        }
        await closeBrowser(browser);
      })();
    }
    return releasePromise;
  };
  try {
    let source = await deadline.race((async () => {
      let page = await browser.newPage();
      await page.emulateMediaType(
        format.contentType === "application/pdf" ? "print" : "screen",
      );
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        let url = request.url();
        if (request.isNavigationRequest()) {
          if (url === EXPORT_DOCUMENT_URL && request.frame() === page.mainFrame()) {
            void request.respond({
              status: 200,
              contentType: "text/html",
              headers: {"Content-Security-Policy": EXPORT_DOCUMENT_CSP},
              body: makeExportHtml(clientCode, format.id),
            });
          } else {
            void request.abort();
          }
        } else if (url.startsWith("data:") || url.startsWith("blob:")) {
          void request.continue();
        } else {
          void request.abort();
        }
      });
      await page.goto(EXPORT_DOCUMENT_URL, { waitUntil: "load" });
      let transport = new BrowserRpcTransport(page);
      page.on("close", () => transport.abort(new Error("Browser page closed.")));
      let rpcSession = new RpcSession(transport, gadget);
      sessionCloser = rpcSession.getRemoteMain();
      await page.evaluate(waitForClientModule);
      const frame = page.mainFrame() as FrameWithIsolatedRealm;
      const isolatedRealm = frame.isolatedRealm();
      await isolatedRealm.evaluate(waitForDomSettled, DOM_SETTLE_MS);
      await isolatedRealm.evaluate(setDocumentTitle, documentTitle);
      switch (format.contentType) {
        case "application/pdf":
          return page.createPDFStream({
            preferCSSPageSize: true,
            printBackground: true,
            waitForFonts: true,
          });
        case "text/html": {
          await isolatedRealm.evaluate(HTML_SANITIZER_RUNTIME);
          const html = await isolatedRealm.evaluate(
            createStaticHtmlSnapshot,
            STATIC_HTML_CSP,
            MAX_EXPORT_BYTES,
          );
          return streamBytes(new TextEncoder().encode(html));
        }
        case "image/png": {
          const clip = await isolatedRealm.evaluate(
            getValidatedScreenshotClip,
            MAX_SCREENSHOT_PIXELS,
          );
          return streamBytes(await page.screenshot({
            type: "png",
            clip,
            captureBeyondViewport: true,
          }));
        }
        case "image/jpeg": {
          const clip = await isolatedRealm.evaluate(
            getValidatedScreenshotClip,
            MAX_SCREENSHOT_PIXELS,
          );
          return streamBytes(await page.screenshot({
            type: "jpeg",
            clip,
            captureBeyondViewport: true,
          }));
        }
        default:
          throw new Error(`Unsupported browser export content type: ${format.contentType}`);
      }
    })());
    return limitExportStream(source, deadline, release);
  } catch (error) {
    // Deliberately omits the caught value: failures here can carry Gadget-authored exception text,
    // which must not reach logs or the external issue Reporter.
    logger.warn("failed to render gadget export", { event: "gadget.export.render.failed" });
    if (error === deadline.error) {
      void release();
    } else {
      await release();
    }
    throw error;
  }
}

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
