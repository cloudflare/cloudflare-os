import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PreviewFormat } from "./previewFormat";
import { decodeText } from "./previews/decodeText";

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

/** Text cut to the lines and columns a card can show. */
const clip = (text: string): string =>
  text.split(/\r\n|\r|\n/, TEXT_LINES).map((line) => line.slice(0, TEXT_COLUMNS)).join("\n");

const view = (drawn: ReactNode): AttachmentThumbnail | null => (drawn ? { type: "view", view: drawn } : null);

const makeThumbnail = async (
  format: PreviewFormat,
  bytes: Uint8Array,
): Promise<AttachmentThumbnail | null> => {
  switch (format) {
    case "text":
    case "markdown":
    case "delimited":
    {
      // A card with nothing on it says less than the file's icon and name.
      const text = clip(decodeText(bytes.subarray(0, 4096)));
      return text.trim() === "" ? null : { type: "text", text };
    }
    // Each Office renderer loads, like pdf.js, only once such a file is on screen.
    case "document": {
      const { documentThumbnail } = await import("./previews/DocumentThumbnail");
      return view(await documentThumbnail(bytes));
    }
    case "slides": {
      const { slideThumbnail } = await import("./previews/SlideThumbnail");
      return view(await slideThumbnail(bytes));
    }
    case "workbook": {
      const { sheetThumbnail } = await import("./previews/SheetThumbnail");
      return view(await sheetThumbnail(bytes));
    }
    case "pdf": {
      // pdf.js is large; it loads only once a PDF is on screen.
      const { pdfThumbnail } = await import("./previews/pdfThumbnail");
      const { image, landscape } = await pdfThumbnail(bytes, THUMBNAIL_WIDTH);
      return { type: "image", url: URL.createObjectURL(image), whole: landscape };
    }
    case "image":
      return null;
  }
};

/** Whether a file of this format gets a thumbnail, which costs fetching the file. */
export const hasThumbnail = (format: PreviewFormat | undefined): format is PreviewFormat =>
  format !== undefined && format !== "image";

/**
 * A thumbnail for the card `ref` is attached to, made once the card nears the viewport: a long
 * chat's files are not all fetched to draw cards nobody scrolls to. Null until it is ready, and
 * for a file with none or one that could not be read, where the card shows the file's kind.
 */
export const useAttachmentThumbnail = <E extends Element>(
  format: PreviewFormat | undefined,
  load: () => Promise<Uint8Array>,
) => {
  const ref = useRef<E>(null);
  const [thumbnail, setThumbnail] = useState<AttachmentThumbnail | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const element = ref.current;
    if (!element || !hasThumbnail(format)) return;
    let cancelled = false;
    let url: string | undefined;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      loadRef.current()
        .then((bytes) => makeThumbnail(format, bytes))
        .then((made) => {
          if (made?.type === "image") url = made.url;
          if (cancelled) {
            if (url) URL.revokeObjectURL(url);
          } else {
            setThumbnail(made);
          }
        })
        // The card keeps its icon; opening the file reports what is wrong with it.
        .catch(() => {});
    }, { rootMargin: "200px" });
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [format]);

  return { ref, thumbnail };
};
