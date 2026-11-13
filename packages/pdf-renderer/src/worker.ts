// The PDF renderer as a Worker other Workers bind to. A caller streams a PDF in and is handed a
// document that stays here: the file's bytes and the PDFium instance are in this isolate's
// memory and nowhere else, and what goes back is a page's grey rows, cut into bands. Whatever a
// PDF or a page of it is refused for is answered as a value, since an error's fields do not
// cross a service binding.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/observability/logger";
import type {
  PdfDocument, PdfRendering, RenderedPage, RenderOptions, RenderRefusalReason, RenderRefused,
} from "./api";
import { pdfiumModules } from "./pdfium-module";
import { pdfRenderer, RenderRefusal, type HoldRelease, type Renderer, type RenderHold } from "./renderer";
// The licence notices of the PDFium build and of everything linked into it. Nothing reads them
// at run time: this import is what puts them in the bundle that carries the binary, so that a
// release ships the notices its licences ask to travel with it.
import "../vendor/pdfium/NOTICES.txt";

/** What the renderer's log lines carry: sizes, counts and fixed words, and nothing of a document. */
type RendererLogFields = {
  pdfBytes: number;
  pages: number;
  /** Which page, from 1 in the page tree's order. */
  page: number;
  reason: RenderRefusalReason;
  releasedBy: HoldRelease;
  width: number;
  height: number;
  bands: number;
  blank: boolean;
  images: number;
  dpi: number;
  reduced: boolean;
  heapBytes: number;
  objects: number;
  imagePixels: number;
  steps: number;
  strips: number;
  work: number;
};

const logger = createLogger<RendererLogFields>({ component: "pdf-renderer" });

/** The isolate's one renderer, once the first PDF has been opened. */
let made: Renderer | undefined;

/**
 * The isolate's one renderer over the vendored build: there is one PDFium instance in an isolate
 * however many PDFs are open in it. The modules are asked for when the first PDF is opened.
 */
async function renderer(): Promise<Renderer> {
  let modules = await pdfiumModules();
  return made ??= pdfRenderer(modules);
}

/** `error` as the value a caller is answered with when it is a refusal, logged; thrown when it is not. */
function refused(error: unknown, page?: number): RenderRefused {
  if (!(error instanceof RenderRefusal)) throw error;
  let { reason, ofPage, heapBytes, work } = error;
  logger.warn("a PDF was not rendered", {
    event: "pdf-renderer.refused", reason, heapBytes, work, ...(page === undefined ? {} : { page }),
    // The cause is what starting the instance threw: it names no document.
    ...(reason === "start" ? { error: error.cause } : {}),
  });
  return { refused: reason, ofPage, heapBytes, work };
}

/** A PDF open in this isolate: the hold that has its bytes, behind the one call a caller makes of it. */
@validateRpc()
export class OpenDocument extends RpcTarget implements PdfDocument {
  #hold: RenderHold;
  #disposed: () => void;

  /** `disposed` is called each time the document is disposed. */
  constructor(hold: RenderHold, disposed: () => void) {
    super();
    this.#hold = hold;
    this.#disposed = disposed;
  }

  async renderPage(index: number, options: RenderOptions): Promise<RenderedPage | RenderRefused> {
    try {
      let page = this.#hold.renderPage(index, options);
      let { width, height, bands, blank, images, dpi, reduced, cost } = page;
      logger.info("rendered a PDF page", {
        event: "pdf-renderer.page_rendered", page: index + 1, width, height, bands: bands.length, blank, images,
        dpi, reduced, ...cost,
      });
      return page;
    } catch (error) {
      return refused(error, index + 1);
    }
  }

  [Symbol.dispose](): void {
    this.#hold.release();
    this.#disposed();
  }
}

/** The entrypoint a caller's service binding names. */
@validateRpc()
export class PdfRenderer extends WorkerEntrypoint implements PdfRendering {
  async open(pdf: ReadableStream<Uint8Array>, size: number): Promise<{ document: OpenDocument; pages: number } | RenderRefused> {
    let hold: RenderHold;
    let opened = false;
    try {
      hold = (await renderer()).hold(size, releasedBy => {
        // A PDF that was refused has said so: only one that was opened is said to be given back.
        if (opened) logger.info("gave back a PDF's room", { event: "pdf-renderer.released", releasedBy });
      });
    } catch (error) {
      await pdf.cancel();
      return refused(error);
    }
    let reader = pdf.getReader();
    try {
      let read = 0;
      for (;;) {
        let next = await reader.read();
        if (next.done) break;
        hold.fill(next.value, read);
        read += next.value.byteLength;
      }
      if (read !== size) throw new RenderRefusal("size-mismatch");
      let pages = hold.countPages();
      opened = true;
      logger.info("opened a PDF", { event: "pdf-renderer.opened", pdfBytes: size, pages });
      // The invocation is kept until the document is disposed. Without this the runtime does
      // not run the disposer when the document's stub is the last capability of its session to
      // go, which it always is. What ends the wait is the disposer and not the hold's release:
      // a hold taken back for another PDF is released during that PDF's invocation, and a
      // promise this one waits for is not to be settled from another.
      let disposed = Promise.withResolvers<void>();
      this.ctx.waitUntil(disposed.promise);
      return { document: new OpenDocument(hold, disposed.resolve), pages };
    } catch (error) {
      hold.release();
      // A stream that failed is passed on as it failed; one that is refused is not read further.
      if (error instanceof RenderRefusal) await reader.cancel();
      return refused(error);
    }
  }
}

/** The Worker serves nothing: it is reached through its entrypoint alone. */
export default {
  fetch: () => new Response(null, { status: 404 }),
};
