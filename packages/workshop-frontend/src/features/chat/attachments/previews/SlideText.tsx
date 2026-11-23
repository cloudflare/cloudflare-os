import type { CSSProperties } from "react";
import type { SlideParagraph, SlideRun, SlideTextBody } from "@gadgets/office-content/pptx-slides";
import { SINGLE_LINE_HEIGHT, cssColor, fontStack } from "./slideStyles";

/** PowerPoint draws superscript and subscript at two thirds of the text's size. */
const SCRIPT_SCALE = 2 / 3;

const runStyle = (run: SlideRun, scale: number): CSSProperties => ({
  fontFamily: fontStack(run.font),
  fontSize: run.size * scale * (run.baseline ? SCRIPT_SCALE : 1),
  fontWeight: run.bold ? 700 : 400,
  fontStyle: run.italic ? "italic" : "normal",
  textDecorationLine: [run.underline && "underline", run.strike && "line-through"].filter(Boolean).join(" ") || "none",
  color: cssColor(run.color),
  letterSpacing: run.letterSpacing ? run.letterSpacing * scale : undefined,
  verticalAlign: run.baseline ? `${run.baseline / SCRIPT_SCALE}em` : undefined,
  lineHeight: run.baseline ? 0 : undefined,
});

const Paragraph = ({ paragraph, body, first }: {
  paragraph: SlideParagraph;
  body: SlideTextBody;
  first: boolean;
}) => {
  const scale = body.fontScale;
  const spacing = paragraph.lineSpacing;
  const lineHeight = spacing.kind === "exact"
    ? `${spacing.points}px`
    : SINGLE_LINE_HEIGHT * spacing.value * (1 - body.lineSpacingReduction);
  const lead = paragraph.runs[0];
  const { bullet } = paragraph;
  return (
    <div
      style={{
        // PowerPoint gives a body's first paragraph no space before it.
        marginTop: first ? 0 : paragraph.spaceBefore * scale,
        marginBottom: paragraph.spaceAfter * scale,
        paddingLeft: paragraph.marginLeft,
        textIndent: paragraph.indent,
        textAlign: paragraph.align,
        whiteSpace: body.wrap ? "pre-wrap" : "pre",
        overflowWrap: body.wrap ? "break-word" : undefined,
        fontFamily: lead ? fontStack(lead.font) : undefined,
        fontSize: paragraph.fontSize * scale,
        lineHeight,
      }}
    >
      {bullet && (
        <span
          style={{
            display: "inline-block",
            // A hanging indent is the column the bullet sits in; the text starts where it ends.
            minWidth: Math.max(0, -paragraph.indent),
            textIndent: 0,
            textAlign: "left",
            fontFamily: fontStack(bullet.font),
            fontSize: bullet.size * scale,
            color: cssColor(bullet.color),
            lineHeight: 0,
          }}
        >
          {bullet.text}{paragraph.indent >= 0 ? " " : ""}
        </span>
      )}
      {paragraph.runs.length === 0
        // An empty paragraph still takes up its line.
        ? "\u200b"
        : paragraph.runs.map((run, index) => (
          <span key={index} style={runStyle(run, scale)}>{run.text}</span>
        ))}
    </div>
  );
};

/** A text body's paragraphs, laid out by the browser in the width it is given. */
export const SlideText = ({ body }: { body: SlideTextBody }) => (
  <div>
    {body.paragraphs.map((paragraph, index) => (
      <Paragraph key={index} paragraph={paragraph} body={body} first={index === 0} />
    ))}
  </div>
);
