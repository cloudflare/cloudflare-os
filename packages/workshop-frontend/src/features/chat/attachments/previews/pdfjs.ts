import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

// Where the build publishes the files pdf.js fetches by name (vite-pdfjs-assets.ts). Absolute,
// because the worker that fetches them resolves a relative URL against its own script.
const PDFJS_ASSETS = new URL(`${import.meta.env.BASE_URL}pdfjs/`, location.href).href;

/** Starts opening a PDF. The caller destroys the task when done with the document. */
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

export const openPdf = (bytes: Uint8Array): PDFDocumentLoadingTask => getDocument({
  // A copy: pdf.js hands the buffer it is given to its worker, which would empty the caller's.
  data: bytes.slice(),
  cMapUrl: `${PDFJS_ASSETS}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`,
  wasmUrl: `${PDFJS_ASSETS}wasm/`,
  iccUrl: `${PDFJS_ASSETS}iccs/`,
});
