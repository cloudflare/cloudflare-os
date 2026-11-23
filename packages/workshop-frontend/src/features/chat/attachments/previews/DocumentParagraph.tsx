import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { DocxInline, DocxParagraph, DocxTabStop, DocxUnsupportedKind } from "@gadgets/office-content/docx-document";
import { DocumentImage } from "./DocumentImage";
import { PX_PER_PT, borderStyle, pt, runStyle } from "./documentStyles";

const UNSUPPORTED_LABELS: Readonly<Record<DocxUnsupportedKind, string>> = {
  textBox: "Text box",
  chart: "Chart",
  diagram: "Diagram",
  equation: "Equation",
  object: "Embedded object",
  shape: "Shape",
  picture: "Picture",
};

/** How far Word carries a paragraph's top and bottom borders past its text when it has no side borders. */
const BORDER_OVERHANG = 1.5;

/**
 * The most tabs in one paragraph sized to their stops. Sizing one reads the layout that sizing the
 * one before changed, so each costs a layout of the paragraph; the rest are a default stop wide.
 */
const MAX_MEASURED_TABS = 64;

// Zero-sized and inline-block, so that it sits on the text's baseline and can be measured and widened.
const TAB_STYLE: CSSProperties = { display: "inline-block", textIndent: 0 };

/**
 * Widens each tab to reach its stop. Where a tab starts depends on the text before it, which only
 * the browser can measure, so the tabs are sized in order after layout: each one moves the next.
 */
const layoutTabs = (host: HTMLElement, paragraph: DocxParagraph, paddingLeft: number, defaultTabStop: number) => {
  const tabs = Array.from(host.querySelectorAll<HTMLElement>("[data-tab]"));
  const end = host.querySelector<HTMLElement>("[data-tab-end]");
  // Written before anything is read, so the browser lays the paragraph out once for all of them.
  for (const [index, tab] of tabs.entries()) tab.style.width = index < MAX_MEASURED_TABS ? "0" : pt(defaultTabStop);
  const stops: DocxTabStop[] = [...paragraph.tabStops];
  // A hanging indent is itself a stop: it is where a list's text starts after its marker.
  if (paragraph.indentFirstLine < 0) stops.push({ position: paragraph.indentLeft, alignment: "left" });
  stops.sort((a, b) => a.position - b.position);
  // Stops are measured from the page margin; `offsetLeft` from this paragraph's padding edge.
  const origin = paragraph.indentLeft - paddingLeft;

  tabs.slice(0, MAX_MEASURED_TABS).forEach((tab, index) => {
    const at = origin + tab.offsetLeft / PX_PER_PT;
    const stop = stops.find(candidate => candidate.position > at + 0.5)
      ?? { position: (Math.floor((at + 0.5) / defaultTabStop) + 1) * defaultTabStop, alignment: "left" };
    let width = stop.position - at;
    const next = tabs[index + 1] ?? end;
    // Text set against a centre or right stop ends, or is centred, there. Text that has wrapped cannot be.
    if (stop.alignment !== "left" && next && next.offsetTop === tab.offsetTop) {
      const following = (next.offsetLeft - tab.offsetLeft) / PX_PER_PT;
      width -= stop.alignment === "right" ? following : following / 2;
    }
    tab.style.width = pt(Math.max(0, width));
  });
};

const renderInline = (inline: DocxInline, paragraph: DocxParagraph, key: number): ReactNode => {
  switch (inline.kind) {
    case "text":
      return <span key={key} style={runStyle(inline.run, paragraph.lineSpacing)}>{inline.text}</span>;
    case "tab":
      return <span key={key} data-tab style={TAB_STYLE} />;
    case "break":
      return <br key={key} />;
    case "image":
      return <DocumentImage key={key} image={inline} />;
    case "unsupported":
      return (
        <span key={key} className="mx-0.5 inline-block rounded border border-kumo-line bg-kumo-elevated px-1.5 font-sans text-[11px] leading-5 text-kumo-subtle">
          {UNSUPPORTED_LABELS[inline.what]} not shown
        </span>
      );
  }
};

/** The paragraph's content, with each stretch of linked inlines inside one link. */
const renderInlines = (paragraph: DocxParagraph): ReactNode[] => {
  const nodes: ReactNode[] = [];
  const { inlines } = paragraph;
  for (let index = 0; index < inlines.length; index++) {
    const inline = inlines[index]!;
    const href = "href" in inline ? inline.href : undefined;
    if (!href) {
      nodes.push(renderInline(inline, paragraph, index));
      continue;
    }
    const linked: ReactNode[] = [];
    const start = index;
    for (let next = inlines[index]; next && "href" in next && next.href === href; next = inlines[++index]) {
      linked.push(renderInline(next, paragraph, index));
    }
    index--;
    nodes.push(
      // The link's look is the file's: its runs carry the colour and underline the document gives them.
      <a key={start} href={href} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
        {linked}
      </a>,
    );
  }
  return nodes;
};

/** One paragraph, with the spacing, indents, borders and list marker the document gives it. */
export const DocumentParagraph = ({ paragraph, defaultTabStop }: {
  paragraph: DocxParagraph;
  defaultTabStop: number;
}) => {
  const hostRef = useRef<HTMLParagraphElement>(null);
  const { marker, borders, mark } = paragraph;
  const hanging = Math.max(0, -paragraph.indentFirstLine);
  // A marker's tab runs to the hanging indent, which a minimum width gives it without measuring.
  // Without a hanging indent it runs to the next stop, like any other tab.
  const markerTab = marker?.suffix === "tab" && hanging === 0;
  const hasTabs = markerTab || paragraph.inlines.some(inline => inline.kind === "tab");

  const overhang = (borders.top || borders.bottom) && !borders.left && !borders.right ? BORDER_OVERHANG : 0;
  const paddingLeft = borders.left?.space ?? overhang;

  useLayoutEffect(() => {
    if (hasTabs && hostRef.current) layoutTabs(hostRef.current, paragraph, paddingLeft, defaultTabStop);
  }, [hasTabs, paragraph, paddingLeft, defaultTabStop]);

  const side = (border: typeof borders.left) => (border ? border.width + border.space : overhang);
  const style: CSSProperties = {
    position: "relative",
    marginTop: pt(paragraph.spacingBefore),
    marginBottom: pt(paragraph.spacingAfter),
    marginLeft: pt(paragraph.indentLeft - side(borders.left)),
    marginRight: pt(paragraph.indentRight - side(borders.right)),
    paddingTop: borders.top && pt(borders.top.space),
    paddingBottom: borders.bottom && pt(borders.bottom.space),
    paddingLeft: pt(paddingLeft),
    paddingRight: pt(borders.right?.space ?? overhang),
    borderTop: borderStyle(borders.top),
    borderRight: borderStyle(borders.right),
    borderBottom: borderStyle(borders.bottom),
    borderLeft: borderStyle(borders.left),
    backgroundColor: paragraph.shading,
    textAlign: paragraph.alignment,
    textIndent: pt(paragraph.indentFirstLine),
    // Word keeps every space the author typed.
    whiteSpace: "pre-wrap",
    // Each run sets its own line height, so that a line is as tall as its tallest run, as in Word.
    // The paragraph's own would add a line of the paragraph mark's size to every line.
    lineHeight: 0,
  };
  const heading = paragraph.headingLevel !== undefined && paragraph.inlines.length > 0;

  return (
    <p ref={hostRef} role={heading ? "heading" : undefined} aria-level={heading ? paragraph.headingLevel : undefined} style={style}>
      {marker && (
        <span
          style={{
            ...runStyle(marker.run, paragraph.lineSpacing),
            display: "inline-block",
            textIndent: 0,
            minWidth: marker.suffix === "tab" ? pt(hanging) : undefined,
            whiteSpace: "pre",
          }}
        >
          {marker.text}{marker.suffix === "space" ? " " : ""}
        </span>
      )}
      {markerTab && <span data-tab style={TAB_STYLE} />}
      {paragraph.inlines.length > 0
        ? renderInlines(paragraph)
        // An empty paragraph is as tall as its paragraph mark.
        : <span style={runStyle(mark, paragraph.lineSpacing)}>{"​"}</span>}
      {hasTabs && <span data-tab-end style={TAB_STYLE} />}
    </p>
  );
};
