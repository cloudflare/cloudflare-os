// Slide markup: runs, paragraphs and the shapes the writer and editor place (placeholders, text
// boxes, code boxes, tables, pictures), written for one part so its hyperlinks and images are
// related from that part.

import { plainText, type MdBlock, type MdInline } from "./markdown-parse";
import {
  CHAR_WIDTH, INSET_X, INSET_Y, MAX_LEVEL, PT, imageBox, lineCount, paragraphSize, paragraphs, text,
  type ImageItem, type Paragraph, type TableItem, type TableLayout,
} from "./pptx-content";
import type { Box, Deck, LayoutPlaceholder } from "./pptx-deck";
import { BODY_MARGINS, BULLET_INDENT, DEFAULT_TABLE_STYLE, GROUP_PROPERTIES, NS } from "./pptx-default";
import type { MediaStore } from "./pptx-images";
import { escapeAttribute, escapeText, XML_DECLARATION } from "./ooxml";
import { REL } from "./pptx-package";

/** Formatting a writer applies to a run on top of its inline Markdown. */
export interface RunStyle {
  readonly size?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly code?: boolean;
  readonly muted?: boolean;
}

/**
 * Formatting new runs start from: an existing run's properties when text replaces a placeholder's,
 * so it keeps the deck's own font, size and color.
 */
export interface RunTemplate {
  /** Attributes of `a:rPr` other than the ones Markdown sets. */
  readonly attributes: string;
  /** Children of `a:rPr` other than hyperlinks and extensions. */
  readonly children: string;
}

const MARKDOWN_ATTRIBUTES = /\s(?:b|i|strike|u|dirty|err|noProof|smtClean)="[^"]*"/g;

/** The template an existing `a:rPr` gives. */
export function runTemplate(rPr: string | undefined): RunTemplate | undefined {
  if (!rPr) return undefined;
  const open = /^<a:rPr\b([^>]*?)(\/?)>/.exec(rPr);
  if (!open) return undefined;
  const attributes = open[1]!.replace(MARKDOWN_ATTRIBUTES, "").trim();
  const children = open[2] ? "" : rPr.slice(open[0].length, rPr.lastIndexOf("</a:rPr>"))
    .replace(/<a:(hlinkClick|hlinkMouseOver|extLst|rtl)\b[^>]*?(?:\/>|>[\s\S]*?<\/a:\1>)/g, "");
  return { attributes, children };
}

/** Consolas as the run's Latin and complex-script font, for code. */
export const MONO = '<a:latin typeface="Consolas" panose="020B0609020204030204" pitchFamily="49" charset="0"/><a:cs typeface="Consolas" panose="020B0609020204030204" pitchFamily="49" charset="0"/>';
const MUTED = '<a:solidFill><a:schemeClr val="tx1"><a:lumMod val="75000"/><a:lumOff val="25000"/></a:schemeClr></a:solidFill>';

/** Writes one part's shapes, relating its hyperlinks and images as it goes. */
export class PartWriter {
  #nextId: number;
  readonly #links = new Map<string, string>();

  constructor(private readonly deck: Deck, readonly part: string, readonly media?: MediaStore, firstId = 2) {
    this.#nextId = firstId;
  }

  id(): number {
    return this.#nextId++;
  }

  link(href: string): string {
    let id = this.#links.get(href);
    if (!id) {
      id = this.deck.pkg.relate(this.part, REL.hyperlink, href, true);
      this.#links.set(href, id);
    }
    return id;
  }

  #properties(style: RunStyle, template: RunTemplate | undefined, inline?: { bold: boolean; italic: boolean; strike: boolean; code: boolean }, href?: string): string {
    const bold = inline?.bold || style.bold, italic = inline?.italic || style.italic, code = inline?.code || style.code;
    let attributes = template?.attributes || 'lang="en-US"';
    if (style.size) attributes = `${attributes.replace(/\s?\bsz="\d+"/, "")} sz="${style.size}"`;
    attributes += `${bold ? ' b="1"' : ""}${italic ? ' i="1"' : ""}${inline?.strike ? ' strike="sngStrike"' : ""} dirty="0"`;
    let children = template?.children ?? "";
    if (style.muted && !/<a:(solidFill|gradFill|noFill|pattFill)\b/.test(children)) children = MUTED + children;
    if (code) children = children.replace(/<a:(latin|ea|cs|sym)\b[^>]*?(?:\/>|>[\s\S]*?<\/a:\1>)/g, "") + MONO;
    if (href) children += `<a:hlinkClick r:id="${this.link(href)}"/>`;
    return `<a:rPr ${attributes.trim()}${children ? `>${children}</a:rPr>` : "/>"}`;
  }

  runs(inlines: readonly MdInline[], style: RunStyle, template?: RunTemplate, href?: string): string {
    let xml = "";
    for (const inline of inlines) {
      if (inline.kind === "break") {
        xml += `<a:br>${this.#properties(style, template)}</a:br>`;
      } else if (inline.kind === "link") {
        xml += this.runs(inline.children, style, template, inline.href);
      } else if (inline.text) {
        xml += `<a:r>${this.#properties(style, template, inline.style, href)}<a:t>${escapeText(inline.text.replace(/\n/g, " "))}</a:t></a:r>`;
      }
    }
    return xml;
  }

  endParagraph(style: RunStyle, template?: RunTemplate): string {
    return this.#properties(style, template).replace(/^<a:rPr\b/, "<a:endParaRPr").replace(/<\/a:rPr>$/, "</a:endParaRPr>")
      .replace(/<a:hlinkClick\b[^>]*\/>/, "");
  }

  /**
   * A body paragraph. In a placeholder (`sizes` undefined) bullets, indents and sizes come from the
   * layout, or from `levels`, the paragraph properties text being replaced had at each level; in
   * a text box they are written out, matching the master's body style.
   */
  paragraph(paragraph: Paragraph, sizes: readonly number[] | undefined, scale = 1, template?: { run?: RunTemplate; levels?: ReadonlyMap<number, string> }): string {
    const level = Math.min(paragraph.level, MAX_LEVEL);
    const explicit = sizes !== undefined;
    const lvl = level ? ` lvl="${level}"` : "";
    let properties: string;
    switch (paragraph.kind) {
      case "plain":
        properties = `<a:pPr marL="${paragraph.quote ? 457200 : 0}" indent="0"><a:buNone/></a:pPr>`;
        break;
      case "heading":
        properties = '<a:pPr marL="0" indent="0"><a:spcBef><a:spcPts val="1200"/></a:spcBef><a:buNone/></a:pPr>';
        break;
      case "bullet":
        properties = explicit
          ? `<a:pPr marL="${BODY_MARGINS[level]}"${lvl} indent="${BULLET_INDENT}"><a:buFont typeface="Arial" panose="020B0604020202020204"/><a:buChar char="${level % 2 ? "–" : "•"}"/></a:pPr>`
          : template?.levels?.get(level) ?? (lvl ? `<a:pPr${lvl}/>` : "");
        break;
      case "number": {
        // ST_TextBulletStartAtNum is 1..32767; a number outside it is XML PowerPoint offers to repair.
        const startAt = Math.min(32767, Math.max(1, paragraph.number ?? 1));
        properties = `<a:pPr marL="${BODY_MARGINS[level]! + 171450}"${lvl} indent="-457200"><a:buFont typeface="+mj-lt"/>` +
          `<a:buAutoNum type="arabicPeriod"${startAt !== 1 ? ` startAt="${startAt}"` : ""}/></a:pPr>`;
        break;
      }
      case "task":
      case "continuation":
        properties = `<a:pPr marL="${BODY_MARGINS[level]}"${lvl} indent="0"><a:buNone/></a:pPr>`;
        break;
    }
    const size = explicit ? Math.round(paragraphSize(paragraph, { sizes }) * scale) : undefined;
    const style: RunStyle = {
      ...(size ? { size } : {}),
      ...(paragraph.kind === "heading" ? { bold: true } : {}),
      ...(paragraph.quote ? { italic: true, muted: true } : {}),
      ...(paragraph.code ? { code: true } : {}),
    };
    const box = paragraph.kind === "task" ? [text(paragraph.checked ? "☑ " : "☐ ")] : [];
    return `<a:p>${properties}${this.runs([...box, ...paragraph.inlines], style, template?.run)}${this.endParagraph(size ? { size } : {}, template?.run)}</a:p>`;
  }

  /** Paragraphs that keep the placeholder's own paragraph style: a title, a subtitle, a caption. */
  plainParagraphs(blocks: readonly Paragraph[], template?: { run?: RunTemplate; levels?: ReadonlyMap<number, string> }, unbulleted = true): string {
    return blocks.map(paragraph => {
      const properties = template?.levels?.get(0) ?? (unbulleted ? '<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>' : "");
      const style: RunStyle = { ...(paragraph.quote ? { italic: true } : {}), ...(paragraph.code ? { code: true } : {}), ...(paragraph.kind === "heading" ? { bold: true } : {}) };
      return `<a:p>${properties}${this.runs(paragraph.inlines, style, template?.run)}${this.endParagraph({}, template?.run)}</a:p>`;
    }).join("");
  }
}

/** A shape's position and size, rounded to whole EMU. */
export function xfrm(box: Box): string {
  return `<a:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(box.cx)}" cy="${Math.round(box.cy)}"/></a:xfrm>`;
}

/** The `p:ph` that ties a slide shape to its layout placeholder. */
function placeholderReference(placeholder: Pick<LayoutPlaceholder, "type" | "idx">): string {
  return `<p:ph${placeholder.type === "obj" ? "" : ` type="${placeholder.type}"`}${placeholder.idx !== undefined ? ` idx="${escapeAttribute(placeholder.idx)}"` : ""}/>`;
}

/** Shrink-on-overflow body properties, at `scale` when the text was measured to need shrinking. */
export function autofit(scale: number | undefined): string {
  if (!scale || scale >= 1) return "<a:normAutofit/>";
  return `<a:normAutofit fontScale="${Math.round(scale * 100000)}"${scale < 0.85 ? ' lnSpcReduction="10000"' : ""}/>`;
}

/** A slide shape filling a layout placeholder with `paragraphXml`. */
export function placeholderShape(writer: PartWriter, name: string, placeholder: LayoutPlaceholder, paragraphXml: string, options: { box?: Box; scale?: number; inherit?: boolean } = {}): string {
  const id = writer.id();
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeAttribute(`${name} ${id - 1}`)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr>${placeholderReference(placeholder)}</p:nvPr></p:nvSpPr>${options.box ? `<p:spPr>${xfrm(options.box)}</p:spPr>` : "<p:spPr/>"}` +
    `<p:txBody>${options.inherit ? "<a:bodyPr/>" : `<a:bodyPr>${autofit(options.scale)}</a:bodyPr>`}<a:lstStyle/>${paragraphXml}</p:txBody></p:sp>`;
}

/** A free-standing text box at `box`. */
export function textBox(writer: PartWriter, box: Box, paragraphXml: string, scale?: number): string {
  const id = writer.id();
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id - 1}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" rtlCol="0">${autofit(scale)}</a:bodyPr><a:lstStyle/>${paragraphXml}</p:txBody></p:sp>`;
}

/** A code block: monospace lines in a shaded, outlined box that never autofits. */
export function codeBox(writer: PartWriter, box: Box, lines: readonly string[], size: number): string {
  const id = writer.id();
  const paragraphXml = lines.map(line => line
    ? `<a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr><a:r><a:rPr lang="en-US" sz="${size}" dirty="0"><a:solidFill><a:srgbClr val="1F2937"/></a:solidFill>${MONO}</a:rPr><a:t>${escapeText(line)}</a:t></a:r></a:p>`
    : `<a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr><a:endParaRPr lang="en-US" sz="${size}" dirty="0"/></a:p>`).join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Code ${id - 1}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="F3F4F6"/></a:solidFill>` +
    '<a:ln w="6350"><a:solidFill><a:srgbClr val="D1D5DB"/></a:solidFill></a:ln></p:spPr>' +
    `<p:txBody><a:bodyPr wrap="square" lIns="137160" tIns="91440" rIns="137160" bIns="91440" rtlCol="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphXml}</p:txBody></p:sp>`;
}

const ALIGN = { left: "l", center: "ctr", right: "r" } as const;

/** A table as a graphic frame, in the default table style with a header row. */
export function tableFrame(writer: PartWriter, box: Box, item: TableItem, layout: TableLayout): string {
  const id = writer.id();
  const cell = (inlines: readonly MdInline[], column: number) => {
    const align = item.align[column];
    return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${align ? `<a:pPr algn="${ALIGN[align]}"/>` : ""}` +
      `${writer.runs(inlines, { size: layout.size })}<a:endParaRPr lang="en-US" sz="${layout.size}" dirty="0"/></a:p></a:txBody><a:tcPr/></a:tc>`;
  };
  const rows = [item.header, ...item.rows].map((row, index) =>
    `<a:tr h="${layout.heights[index]}">${row.map((inlines, column) => cell(inlines, column)).join("")}</a:tr>`).join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id - 1}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(box.cx)}" cy="${Math.round(box.cy)}"/></p:xfrm>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    `<a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>${DEFAULT_TABLE_STYLE}</a:tableStyleId></a:tblPr>` +
    `<a:tblGrid>${layout.widths.map(width => `<a:gridCol w="${width}"/>`).join("")}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

/**
 * A picture. In a placeholder it fills the placeholder's box, cropped to keep its aspect ratio as
 * PowerPoint crops a picture dropped into one; otherwise it sits in `box` as given.
 */
export function pictureShape(writer: PartWriter, item: ImageItem, target: { box: Box } | { placeholder: LayoutPlaceholder & { box: Box }; fit?: boolean }): string {
  if (!writer.media) throw new Error("No images were provided");
  const id = writer.id();
  const blip = writer.media.blip(writer.part, item.ref);
  let crop = "";
  let shapeProperties: string;
  let placeholder = "";
  if ("placeholder" in target) {
    placeholder = placeholderReference(target.placeholder);
    const box = target.placeholder.box;
    if (target.fit) {
      shapeProperties = `<p:spPr>${xfrm(centered(imageBox(item, box), box))}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`;
    } else {
      const imageRatio = item.width / item.height, boxRatio = box.cx / box.cy;
      if (Math.abs(imageRatio - boxRatio) > 0.001) {
        const cut = Math.round((imageRatio > boxRatio ? 1 - boxRatio / imageRatio : 1 - imageRatio / boxRatio) * 50000);
        crop = imageRatio > boxRatio ? `<a:srcRect l="${cut}" r="${cut}"/>` : `<a:srcRect t="${cut}" b="${cut}"/>`;
      }
      // The box is written out rather than inherited: Office for the web draws nothing for a picture whose geometry it must inherit.
      shapeProperties = `<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`;
    }
  } else {
    shapeProperties = `<p:spPr>${xfrm(target.box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`;
  }
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id - 1}"${item.alt ? ` descr="${escapeAttribute(item.alt)}"` : ""}/>` +
    `<p:cNvPicPr><a:picLocks${placeholder ? ' noGrp="1"' : ""} noChangeAspect="1"/></p:cNvPicPr><p:nvPr>${placeholder}</p:nvPr></p:nvPicPr>` +
    `<p:blipFill>${blip}${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill>${shapeProperties}</p:pic>`;
}

/** `inner` centered vertically within `outer` too. */
export function centered(inner: Box, outer: Box): Box {
  return { ...inner, y: outer.y + (outer.cy - inner.cy) / 2 };
}

/** A slide part holding `shapes`. */
export function slideXml(shapes: string): string {
  return `${XML_DECLARATION}<p:sld ${NS}><p:cSld><p:spTree>${GROUP_PROPERTIES}${shapes}</p:spTree></p:cSld>` +
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>";
}

const NOTES_SIZES = Array.from({ length: 9 }, () => 1200);

/** Speaker notes as notes-page paragraphs. */
export function notesParagraphs(writer: PartWriter, notes: readonly MdBlock[]): string {
  const body = notes.flatMap(block => paragraphs(block, 0, false)).map(paragraph => writer.paragraph(paragraph, NOTES_SIZES)).join("");
  return body || '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>';
}

/** The notes slide written at `part`, holding `notes`. */
export function notesXml(deck: Deck, part: string, notes: readonly MdBlock[]): string {
  const writer = new PartWriter(deck, part);
  return `${XML_DECLARATION}<p:notes ${NS}><p:cSld><p:spTree>${GROUP_PROPERTIES}` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    `<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${notesParagraphs(writer, notes)}</p:txBody></p:sp>` +
    "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>";
}

/** How much a title must shrink to fit its placeholder's box: 1 when it fits. */
export function titleScale(title: readonly MdInline[], box: Box | undefined, size: number): number | undefined {
  if (!box) return undefined;
  const value = plainText(title);
  const widthPt = (box.cx - INSET_X) / PT;
  for (const scale of [1, 0.9, 0.8, 0.7, 0.6]) {
    const lines = lineCount(value, widthPt, size * scale, CHAR_WIDTH * 1.05);
    if (lines * size * scale * 1.05 * PT <= box.cy - INSET_Y) return scale;
  }
  return 0.5;
}
