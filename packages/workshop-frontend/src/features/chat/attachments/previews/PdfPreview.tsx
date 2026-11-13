import { useEffect, useRef, useState } from "react";
import { Loader } from "@cloudflare/kumo";
import {
  PasswordException, RenderingCancelledException, TextLayer, type PDFDocumentProxy,
} from "pdfjs-dist";
import { AttachmentPreviewError, type AttachmentPreviewProps } from "../attachmentPreviewers";
import styles from "./PdfPreview.module.css";
import { canvasDensity, openPdf } from "./pdfjs";
import { scrollRoot } from "./scrollRoot";

/** Pages are drawn no wider than this, however wide the viewer. */
const MAX_PAGE_WIDTH = 900;
/** US Letter, for a page's placeholder before its real shape is known. */
const DEFAULT_ASPECT = 11 / 8.5;
/**
 * The tallest a page is shown, as a multiple of its width; the rest of a taller one is cut off.
 * A page can claim any shape, and one a hundred thousand times taller than wide is not a page.
 */
const MAX_ASPECT = 40;

/**
 * One page: a placeholder of the right shape until it nears the viewport, then the page drawn at
 * the device's resolution with its text selectable on top, and a placeholder again once it is
 * far behind: a drawn page holds megabytes, and a long PDF scrolled through would keep them all.
 */
const PdfPage = ({ doc, pageNumber, width }: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  width: number;
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  /** Whether pdf.js holds this page, whose decoded images stay until it is told to let go. */
  const loadedRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver((entries) => {
      setNear(entries[entries.length - 1]!.isIntersecting);
    }, { root: scrollRoot(host), rootMargin: "200% 0px" });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || width <= 0) return;
    if (!near) {
      host.replaceChildren();
      if (loadedRef.current) {
        loadedRef.current = false;
        void doc.getPage(pageNumber).then((page) => page.cleanup());
      }
      return;
    }
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    let textLayer: TextLayer | undefined;

    const draw = async () => {
      const page = await doc.getPage(pageNumber);
      loadedRef.current = true;
      if (cancelled) return;
      const natural = page.getViewport({ scale: 1 });
      setAspect(Math.min(MAX_ASPECT, natural.height / natural.width));
      const scale = width / natural.width;
      const viewport = page.getViewport({ scale });
      const shownHeight = Math.min(viewport.height, width * MAX_ASPECT);
      const density = canvasDensity(viewport.width, shownHeight);

      // A new canvas each time, swapped in once drawn: pdf.js cannot draw twice to one canvas at
      // once, and the page drawn at the old width stays up until the new one is ready.
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * density);
      canvas.height = Math.floor(shownHeight * density);
      canvas.className = "block h-full w-full";
      renderTask = page.render({
        canvas,
        viewport,
        ...(density !== 1 ? { transform: [density, 0, 0, density, 0, 0] } : {}),
      });
      await renderTask.promise;
      if (cancelled) return;

      const text = document.createElement("div");
      text.className = styles.textLayer;
      host.style.setProperty("--total-scale-factor", String(scale));
      host.replaceChildren(canvas, text);
      textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: text,
        viewport,
      });
      await textLayer.render();
    };

    draw().catch((error: unknown) => {
      if (cancelled || error instanceof RenderingCancelledException) return;
      console.error(`Failed to draw PDF page ${pageNumber}:`, error);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [doc, pageNumber, width, near]);

  return (
    <div
      ref={hostRef}
      role="group"
      aria-label={`Page ${pageNumber}`}
      className="relative shrink-0 overflow-hidden bg-kumo-base shadow-sm ring-1 ring-kumo-line"
      style={{ width, height: Math.round(width * aspect) }}
    />
  );
};

/** A PDF, every page drawn by pdf.js as the document specifies. */
export const PdfPreview = ({ bytes }: AttachmentPreviewProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const task = openPdf(bytes);
    task.promise.then(
      (loaded) => { if (!cancelled) setDoc(loaded); },
      (error: unknown) => { if (!cancelled) setFailure(error); },
    );
    return () => {
      cancelled = true;
      setDoc(null);
      void task.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.min(MAX_PAGE_WIDTH, Math.floor(entry.contentRect.width)));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  if (failure) {
    throw failure instanceof PasswordException
      ? new AttachmentPreviewError("This PDF is password-protected. Download it to open it.")
      : failure;
  }

  return (
    <div className="min-h-full px-4 py-4">
      <div ref={containerRef} className="flex flex-col items-center gap-3">
        {doc ? Array.from({ length: doc.numPages }, (_, index) => (
          <PdfPage key={index} doc={doc} pageNumber={index + 1} width={width} />
        )) : (
          <div className="grid h-40 place-items-center" role="status" aria-label="Loading preview">
            <Loader size="base" />
          </div>
        )}
      </div>
    </div>
  );
};
