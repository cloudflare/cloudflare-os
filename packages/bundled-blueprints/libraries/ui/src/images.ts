/**
 * Images pasted, dropped or picked into a gadget are stored inline as data URLs -- the only form
 * that survives the sandboxed iframe, a reload and every collaborator's browser without an asset
 * store. That makes their size a matter for the whole document, so {@link prepareImage} downscales
 * and re-encodes every image until it fits a byte budget. {@link readFileAsDataURL} and
 * {@link loadImage} are its two steps, exported for a gadget that wants only one of them.
 */

/** A processed image ready to be inserted. */
export interface PreparedImage {
  /** A `data:image/...` URL. */
  src: string;
  alt: string;
  width: number;
  height: number;
}

/** Limits applied by {@link prepareImage}. */
export interface ImageLimits {
  /** Longest edge, in pixels. */
  maxDimension: number;
  /** Longest data URL kept, in characters (about 4/3 of the encoded bytes). */
  maxDataUrlLength: number;
  /**
   * Longest GIF kept un-flattened, in data URL characters. A GIF is the one input the canvas cannot
   * re-encode without losing its animation, so it gets a wider budget than a re-encodable image;
   * one over it is flattened and re-encoded within `maxDataUrlLength` like the rest.
   */
  maxGifDataUrlLength: number;
}

/** What {@link prepareImage} takes beyond the file: any of the limits, and the alt text. */
export interface PrepareImageOptions extends Partial<ImageLimits> {
  /** The alt text to carry; by default {@link altFromFileName} of the file's name. */
  alt?: string;
}

/** Image types accepted from the clipboard, a drop or the file picker. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * Defaults: 1600px on the longest edge, roughly a megabyte of encoded image, and about 2 MB for a
 * GIF kept animated (the budget Docs applied to a GIF before this library).
 */
export const DEFAULT_IMAGE_LIMITS: ImageLimits = { maxDimension: 1600, maxDataUrlLength: 1_400_000, maxGifDataUrlLength: 2_700_000 };

/** Encoding quality steps tried in turn until the result fits the budget. */
const QUALITY_STEPS = [0.86, 0.74, 0.62, 0.5];

/** Whether a file is an image of a type in {@link IMAGE_TYPES}. */
export function isImageFile(file: File | null | undefined): file is File {
  return !!file && IMAGE_TYPES.has(file.type);
}

/** The image files in a paste or drop payload, from its `files` or, failing that, its file `items`. */
export function imageFilesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  const files = Array.from(transfer.files ?? []).filter(isImageFile);
  if (files.length) return files;
  return Array.from(transfer.items ?? [])
    .filter((item) => item.kind === "file" && IMAGE_TYPES.has(item.type))
    .map((item) => item.getAsFile())
    .filter(isImageFile);
}

/**
 * Downscale and re-encode a file into a data URL within the limits. A GIF within `maxDimension`
 * and `maxGifDataUrlLength` is kept as-is so an animation survives; everything else becomes WebP
 * (or JPEG where WebP is not encodable), at falling quality and then falling size until it fits
 * `maxDataUrlLength`. Rejects when even the smallest encoding is over budget, or when the file is
 * not an image the browser can decode.
 */
export async function prepareImage(file: File, options: PrepareImageOptions = {}): Promise<PreparedImage> {
  // Each limit falls back on its own, so an option passed as `undefined` does not unset the default.
  const limits: ImageLimits = {
    maxDimension: options.maxDimension ?? DEFAULT_IMAGE_LIMITS.maxDimension,
    maxDataUrlLength: options.maxDataUrlLength ?? DEFAULT_IMAGE_LIMITS.maxDataUrlLength,
    maxGifDataUrlLength: options.maxGifDataUrlLength ?? DEFAULT_IMAGE_LIMITS.maxGifDataUrlLength,
  };
  const original = await readFileAsDataURL(file);
  const image = await loadImage(original);
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  const alt = options.alt ?? altFromFileName(file.name);

  if (file.type === "image/gif" && original.length <= limits.maxGifDataUrlLength && Math.max(naturalWidth, naturalHeight) <= limits.maxDimension) {
    return { src: original, alt, width: naturalWidth, height: naturalHeight };
  }

  let scale = Math.min(1, limits.maxDimension / Math.max(naturalWidth, naturalHeight, 1));
  for (let attempt = 0; attempt < 4; attempt++) {
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot process images.");
    context.drawImage(image, 0, 0, width, height);
    for (const quality of QUALITY_STEPS) {
      const src = encode(canvas, quality);
      if (src.length <= limits.maxDataUrlLength) return { src, alt, width, height };
    }
    scale *= 0.7;
  }
  throw new Error("That image is too large to embed.");
}

/** A readable default alt text: the file name without its extension and separators, or `Image`. */
export function altFromFileName(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim() || "Image";
}

function encode(canvas: HTMLCanvasElement, quality: number): string {
  const webp = canvas.toDataURL("image/webp", quality);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", quality);
}

/** Read a file as a data URL. Rejects with the reader's error when it cannot be read. */
export function readFileAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read the image.")), { once: true });
    reader.readAsDataURL(file);
  });
}

/** Decode an image from a URL (a data URL, typically), resolving once its size is known. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("That file is not an image this browser can decode.")), { once: true });
    image.src = src;
  });
}
