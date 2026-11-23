import { canvasDensity, openPdf } from "./pdfjs";

/** The tallest thumbnail drawn, as a multiple of its width. */
const MAX_THUMBNAIL_ASPECT = 3;

/**
 * A PDF's first page as a PNG, `width` CSS pixels wide at up to twice that resolution, and
 * whether the page is wider than it is tall.
 */
export const pdfThumbnail = async (
  bytes: Uint8Array,
  width: number,
  signal: AbortSignal,
): Promise<{ image: Blob; landscape: boolean }> => {
  signal.throwIfAborted();
  const task = openPdf(bytes);
  // A card gone before its page is drawn stops pdf.js loading and drawing it.
  const stop = () => void task.destroy();
  signal.addEventListener("abort", stop, { once: true });
  try {
    const page = await (await task.promise).getPage(1);
    const natural = page.getViewport({ scale: 1 });
    // A card shows the top of a tall page, so no more than that is drawn, whatever shape the
    // page claims.
    const shownHeight = Math.min(natural.height * (width / natural.width), width * MAX_THUMBNAIL_ASPECT);
    const density = canvasDensity(width, shownHeight);
    const viewport = page.getViewport({ scale: (width * density) / natural.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(shownHeight * density);
    signal.throwIfAborted();
    await page.render({ canvas, viewport }).promise;
    signal.throwIfAborted();
    const image = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("No thumbnail")), "image/png");
    });
    return { image, landscape: natural.width > natural.height };
  } finally {
    signal.removeEventListener("abort", stop);
    void task.destroy();
  }
};
