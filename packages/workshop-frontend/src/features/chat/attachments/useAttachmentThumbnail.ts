import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PreviewFormat } from "./previewFormat";
import { decodeText } from "./previews/decodeText";
import { acquireObjectUrl } from "./useObjectUrl";

/**
 * A card-sized glimpse of a file: the start of its text, a picture of its first page, or its
 * first page, slide or sheet drawn by the file's own previewer.
 */
export type AttachmentThumbnail =
  | { type: "text"; text: string }
  | { type: "view"; view: ReactNode }
  /** `whole` shows all of a wide page, as a slide is shown; otherwise the card shows the page's top. */
  | { type: "image"; url: string; whole: boolean };

/** The width a card's picture is drawn for: the larger card size. */
const THUMBNAIL_WIDTH = 110;
const TEXT_LINES = 18;
const TEXT_COLUMNS = 64;
/** The bytes a text card reads: more than its lines and columns can show. */
const TEXT_BYTES = 4096;
const TEXT_FORMATS: ReadonlySet<PreviewFormat> = new Set(["text", "markdown", "delimited"]);

/** Text cut to the lines and columns a card can show. */
const clip = (text: string): string =>
  text.split(/\r\n|\r|\n/, TEXT_LINES).map((line) => line.slice(0, TEXT_COLUMNS)).join("\n");

type Made = { thumbnail: AttachmentThumbnail | null; release?: () => void };

const view = (drawn: ReactNode): Made => ({ thumbnail: drawn ? { type: "view", view: drawn } : null });

const makeThumbnail = async (
  format: PreviewFormat,
  bytes: Uint8Array,
  mimeType: string,
  signal: AbortSignal,
): Promise<Made> => {
  switch (format) {
    case "text":
    case "markdown":
    case "delimited":
    {
      // A card with nothing on it says less than the file's icon and name.
      const text = clip(decodeText(bytes.subarray(0, TEXT_BYTES)));
      return { thumbnail: text.trim() === "" ? null : { type: "text", text } };
    }
    // Each Office renderer loads, like pdf.js, only once such a file is on screen.
    case "document": {
      const { documentThumbnail } = await import("./previews/DocumentThumbnail");
      return view(await documentThumbnail(bytes, signal));
    }
    case "slides": {
      const { slideThumbnail } = await import("./previews/SlideThumbnail");
      return view(await slideThumbnail(bytes, signal));
    }
    case "workbook": {
      const { sheetThumbnail } = await import("./previews/SheetThumbnail");
      return view(await sheetThumbnail(bytes, signal));
    }
    case "pdf": {
      // pdf.js is large; it loads only once a PDF is on screen.
      const { pdfThumbnail } = await import("./previews/pdfThumbnail");
      const { image, landscape } = await pdfThumbnail(bytes, THUMBNAIL_WIDTH, signal);
      const url = URL.createObjectURL(image);
      return { thumbnail: { type: "image", url, whole: landscape }, release: () => URL.revokeObjectURL(url) };
    }
    case "image": {
      // The viewer's URL for the same bytes, which for an SVG has no origin to run its script as.
      const { url, release } = acquireObjectUrl(bytes, mimeType);
      try {
        return { thumbnail: { type: "image", url: await url, whole: false }, release };
      } catch {
        release();
        return { thumbnail: null };
      }
    }
  }
};

/**
 * Whether a file of this format gets a thumbnail, which costs fetching the file. A card that can
 * draw its image without one passes no format.
 */
const hasThumbnail = (format: PreviewFormat | undefined): format is PreviewFormat =>
  format !== undefined;

/**
 * A thumbnail for the card `ref` is attached to, made once the card nears the viewport: a long
 * chat's files are not all fetched to draw cards nobody scrolls to. `load` reads the file, or with
 * `limit` only its first bytes, which is all a text card shows; `signal` aborts once the card no
 * longer needs it. `thumbnail` is null until it is ready, and for a file with none or one that
 * could not be read, where the card shows the file's kind; `loading` tells the two apart while one
 * is still to come.
 */
export const useAttachmentThumbnail = <E extends Element>(
  format: PreviewFormat | undefined,
  load: (signal: AbortSignal, limit?: number) => Promise<Uint8Array>,
  mimeType: string,
) => {
  const ref = useRef<E>(null);
  const [thumbnail, setThumbnail] = useState<AttachmentThumbnail | null>(null);
  const [settled, setSettled] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const element = ref.current;
    if (!element || !hasThumbnail(format)) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    // A card gone before its file arrives, or while it is being read, stops the read.
    const abort = new AbortController();
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      loadRef.current(abort.signal, TEXT_FORMATS.has(format) ? TEXT_BYTES : undefined)
        .then((bytes) => (cancelled ? null : makeThumbnail(format, bytes, mimeType, abort.signal)))
        .then((made) => {
          release = made?.release;
          if (cancelled) {
            release?.();
          } else {
            setThumbnail(made?.thumbnail ?? null);
            setSettled(true);
          }
        })
        // The card shows its icon; opening the file reports what is wrong with it.
        .catch(() => { if (!cancelled) setSettled(true); });
    }, { rootMargin: "200px" });
    observer.observe(element);
    return () => {
      cancelled = true;
      abort.abort();
      observer.disconnect();
      release?.();
    };
  }, [format, mimeType]);

  return { ref, thumbnail, loading: hasThumbnail(format) && !settled };
};
