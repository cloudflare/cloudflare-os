import { useLayoutEffect, useRef, useState } from "react";
import type { DocxBlock, DocxPageSetup } from "@gadgets/office-content/docx-document";
import { DocumentBlocks } from "./DocumentBlocks";
import { pt } from "./documentStyles";

/**
 * One sheet of paper: the page's width and margins, at least a page tall and as much taller as
 * its content needs. It is laid out at its true size and then scaled as a whole, so its lines
 * break in the same places whatever the viewer's width.
 */
export const DocumentSheet = ({ page, scale, blocks, header, footer, defaultTabStop }: {
  page: DocxPageSetup;
  scale: number;
  blocks: readonly DocxBlock[];
  /** Drawn in the top margin; absent on every sheet but the first. */
  header?: readonly DocxBlock[];
  /** Drawn in the bottom margin; absent on every sheet but the last. */
  footer?: readonly DocxBlock[];
  defaultTabStop: number;
}) => {
  const paperRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  // A transform does not change the room an element takes, so the scaled sheet's is set from its
  // measured height.
  useLayoutEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    setHeight(paper.offsetHeight);
    const observer = new ResizeObserver(() => setHeight(paper.offsetHeight));
    observer.observe(paper);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className="shrink-0 overflow-hidden shadow-sm ring-1 ring-kumo-line"
      style={{ width: `calc(${pt(page.width)} * ${scale})`, height: height === null ? undefined : height * scale }}
    >
      <div
        ref={paperRef}
        style={{
          display: "flex",
          flexDirection: "column",
          boxSizing: "border-box",
          width: pt(page.width),
          minHeight: pt(page.height),
          paddingLeft: pt(page.marginLeft),
          paddingRight: pt(page.marginRight),
          // Paper is white and its automatic text black in either app theme: these are the
          // document's colours, not the app's.
          backgroundColor: "#FFFFFF",
          color: "#000000",
          overflowWrap: "break-word",
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        <div style={{ boxSizing: "border-box", minHeight: pt(page.marginTop), paddingTop: pt(page.headerDistance) }}>
          {header && <DocumentBlocks blocks={header} defaultTabStop={defaultTabStop} />}
        </div>
        <div style={{ flex: "1 0 auto" }}>
          <DocumentBlocks blocks={blocks} defaultTabStop={defaultTabStop} />
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            boxSizing: "border-box",
            minHeight: pt(page.marginBottom),
            paddingBottom: pt(page.footerDistance),
          }}
        >
          {footer && <div><DocumentBlocks blocks={footer} defaultTabStop={defaultTabStop} /></div>}
        </div>
      </div>
    </div>
  );
};
