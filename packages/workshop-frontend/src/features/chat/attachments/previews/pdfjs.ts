import { getDocument, GlobalWorkerOptions, PDFWorker, type PDFDocumentLoadingTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

// Where the build publishes the files pdf.js fetches by name (vite-pdfjs-assets.ts). Absolute,
// because the worker that fetches them resolves a relative URL against its own script.
const PDFJS_ASSETS = new URL(`${import.meta.env.BASE_URL}pdfjs/`, location.href).href;

// Past these a browser draws nothing (Chrome stops at 32,767 pixels a side, iOS Safari at about
// 16.7 million in all) or spends the tab's memory trying.
const MAX_CANVAS_SIDE = 8192;
const MAX_CANVAS_PIXELS = 16_000_000;

/**
 * Device pixels per CSS pixel for a canvas of this CSS size: the screen's, up to 2, and less for
 * a page so large that its canvas would pass what browsers can draw.
 */
export const canvasDensity = (width: number, height: number): number => Math.min(
  window.devicePixelRatio || 1,
  2,
  MAX_CANVAS_SIDE / width,
  MAX_CANVAS_SIDE / height,
  Math.sqrt(MAX_CANVAS_PIXELS / (width * height)),
);

let worker: PDFWorker | undefined;

/**
 * Starts opening a PDF. The caller destroys the task when done with the document. Every PDF is
 * read by one worker, started with the first: without one given, pdf.js starts a worker per file,
 * so a chat's PDF cards would each start their own. A task does not stop a worker it was given.
 */
export const openPdf = (bytes: Uint8Array): PDFDocumentLoadingTask => getDocument({
  worker: worker ??= new PDFWorker(),
  // A copy: pdf.js hands the buffer it is given to its worker, which would empty the caller's.
  data: bytes.slice(),
  cMapUrl: `${PDFJS_ASSETS}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`,
  wasmUrl: `${PDFJS_ASSETS}wasm/`,
  iccUrl: `${PDFJS_ASSETS}iccs/`,
  // An image is decoded at the size the file declares before it is scaled to the canvas, so a few
  // hundred bytes could claim a picture of gigabytes. One past this is left off its page.
  maxImageSize: MAX_CANVAS_PIXELS,
});
