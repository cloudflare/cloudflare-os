// Markdown to a PowerPoint deck, as an outline: headings start slides, and what follows a heading is
// that slide's content, laid out on the deck's own layouts so the slides look like the rest of the
// deck and stay editable in PowerPoint (text sits in the layout's placeholders, tables are real
// tables, and long content becomes "(continued)" slides rather than running off the slide).
//
// The outline rules, which `editPptx`'s `addSlides` shares:
//   - Slides start at the shallowest heading level used (`#` in most decks). When the document
//     opens with its only top-level heading and uses deeper ones, that heading is the deck's title
//     slide and slides start at the next level instead (a `# Deck` + `## Slide` outline).
//   - A deck that opens with a heading followed only by a few short paragraphs gets a title slide:
//     the heading as its title, the paragraphs as its subtitle.
//   - `---` also starts a slide; one with no heading of its own has no title.
//   - Deeper headings are bold sub-headings in the slide's body.
//   - A blockquote whose text starts with "Notes:" holds the slide's speaker notes.
//   - Lists keep their nesting, numbering and task boxes; plain paragraphs are unbulleted body text;
//     quotes are italic; code is a monospace box; tables are PowerPoint tables with a header row.
//   - `![description](reference)` on a line of its own is a picture (the caller supplies the
//     bytes): alone on a slide it fills the layout's picture placeholder, or the content area.
//
// Layouts: a slide may name one, `<!-- layout: Two Content -->`, by the deck's own layout names
// (or PowerPoint's standard names, which find the layout of that type). Otherwise the opening
// slide is a Title Slide, a heading with nothing under it a Section Header, content split into
// columns by `+++` lines Two Content (or Comparison when each column opens with a heading), and
// anything else Title and Content. In a layout with several content areas, `+++` separates
// what goes in each, left to right; a heading opening a column fills that column's heading
// placeholder where the layout has one.

import { plainText, parseMarkdown, type MdBlock, type MdInline } from "./markdown-parse";
import {
  GAP, fitPage, imageBox, itemHeight, items, paginate, paragraphs, tableLayout, codeSize, text,
  type ImageItem, type Metrics, type Page,
} from "./pptx-content";
import { Deck, type Box, type LayoutInfo, type LayoutPlaceholder } from "./pptx-deck";
import { FIELD_SLIDE_NUMBER } from "./pptx-default";
import { IMAGE_TOKEN, MediaStore, SlideContentError, prepareMarkdown, type ImageReference, type PptxImages } from "./pptx-images";
import {
  PartWriter, centered, codeBox, notesXml, pictureShape, placeholderShape, slideXml, tableFrame, textBox, titleScale,
} from "./pptx-render";

export { pptxFeatures } from "./pptx-features";
export { describePptx, type SlideInfo } from "./pptx-describe";
export { imageRefs, SlideContentError, type PptxImage, type PptxImageType, type PptxImages } from "./pptx-images";

/** How `markdownToPptx` writes the deck. */
export interface MarkdownToPptxOptions {
  /** The document title; defaults to the deck's first heading. */
  readonly title?: string;
  /** A .pptx or .potx whose masters, layouts and theme the deck uses. Its own slides are dropped. */
  readonly template?: Uint8Array;
  readonly author?: string;
  /** The created and modified time recorded in the file; defaults to now. */
  readonly modifiedAt?: Date;
  /** The pictures image lines name, by reference (see `imageRefs`). */
  readonly images?: PptxImages;
}

/**
 * Writes Markdown as a 16:9 deck in a clean default design, or on a template's design.
 * Throws `SlideContentError` for content that can't be laid out as asked (an image that wasn't
 * provided, an unknown layout) and `PackageError` when the template can't be used.
 */
export async function markdownToPptx(markdown: string, options: MarkdownToPptxOptions = {}): Promise<Uint8Array> {
  let deck: Deck;
  if (options.template) {
    deck = await Deck.open(options.template);
    deck.clearForTemplate();
  } else {
    deck = Deck.create();
  }
  const prepared = prepareMarkdown(markdown);
  const plans = planSlides(parseMarkdown(prepared.markdown));
  renderSlides(deck, plans, prepared.images, { slideNumbers: !options.template, media: new MediaStore(deck.pkg, options.images) });
  const firstTitle = plans.find(plan => plan.title)?.title;
  const title = options.title ?? (firstTitle ? plainText(firstTitle).trim() : undefined);
  deck.writeProperties({ ...(title ? { title } : {}), ...(options.author ? { author: options.author } : {}), ...(options.modifiedAt ? { modifiedAt: options.modifiedAt } : {}) });
  return await deck.toBytes(options.modifiedAt);
}

/**
 * Adds slides written in Markdown to an open deck at `index` (0-based; the end when omitted), on
 * its own layouts. Returns each new slide's part name and title, in order.
 */
export function insertMarkdownSlides(deck: Deck, markdown: string, options: { index?: number; images?: PptxImages } = {}): { part: string; title: string }[] {
  const slideNumbers = deck.slides().some(slide => /<p:ph\b[^>]*type="sldNum"/.test(deck.pkg.text(slide.part) ?? ""));
  const prepared = prepareMarkdown(markdown);
  return renderSlides(deck, planSlides(parseMarkdown(prepared.markdown)), prepared.images,
    { slideNumbers, media: new MediaStore(deck.pkg, options.images) }, options.index);
}

// ---- Outline ----

/** One slide (before any long content is split across several). */
export interface SlidePlan {
  readonly kind: "title" | "content";
  readonly title: readonly MdInline[] | undefined;
  readonly body: MdBlock[];
  readonly notes: MdBlock[];
  /** The layout a `<!-- layout: ... -->` directive named. */
  layout?: string;
}

const MAX_SUBTITLE_CHARS = 300;
const NOTES_PREFIX = /^\s*notes?\s*:\s*/i;
const LAYOUT_DIRECTIVE = /^<!--\s*layout\s*:\s*(.*?)\s*-->$/i;
const COLUMN_BREAK = "+++";

function directiveOf(block: MdBlock): string | undefined {
  return block.kind === "paragraph" ? LAYOUT_DIRECTIVE.exec(plainText(block.inlines).trim())?.[1] : undefined;
}

function isColumnBreak(block: MdBlock): boolean {
  return block.kind === "paragraph" && plainText(block.inlines).trim() === COLUMN_BREAK;
}

/**
 * Headings that open columns (the one after a `+++`, and the matching one before it), which head
 * columns rather than slides.
 */
function columnHeadings(blocks: readonly MdBlock[]): Set<number> {
  const marked = new Set<number>();
  blocks.forEach((block, index) => {
    const next = blocks[index + 1];
    if (!isColumnBreak(block) || next?.kind !== "heading") return;
    marked.add(index + 1);
    for (let back = index - 1; back >= 0; back--) {
      const candidate = blocks[back]!;
      if (candidate.kind !== "heading") continue;
      if (candidate.level === next.level) marked.add(back);
      if (candidate.level <= next.level) break;
    }
  });
  return marked;
}

/** Splits blocks into slides by the outline rules at the top of this file. */
export function planSlides(blocks: readonly MdBlock[]): SlidePlan[] {
  const headers = columnHeadings(blocks);
  const isSlideHeading = (block: MdBlock, index: number) => block.kind === "heading" && !headers.has(index);
  const levels = blocks.flatMap((block, index) => block.kind === "heading" && isSlideHeading(block, index) ? [block.level] : []);
  const top = levels.length ? Math.min(...levels) : 7;
  let split = top;
  const plans: SlidePlan[] = [];
  let rest = blocks;
  let pending: string | undefined;

  const opening = blocks.findIndex(block => directiveOf(block) === undefined);
  const first = blocks[opening];
  if (first?.kind === "heading" && levels.filter(level => level === top).length === 1 && levels.some(level => level > top)) {
    // `# Deck` then `## Slide`s: the lone top heading is the title slide.
    split = Math.min(...levels.filter(level => level > top));
    const end = blocks.findIndex((block, index) => index > opening && isSlideHeading(block, index));
    const directive = blocks.slice(0, end).map(directiveOf).find(Boolean);
    const intro = blocks.slice(opening + 1, end).filter(block => directiveOf(block) === undefined);
    rest = blocks.slice(end);
    const { body, notes } = separateNotes(intro);
    const title: SlidePlan = { kind: "title", title: first.inlines, body: isSubtitle(body) ? body : [], notes, ...(directive ? { layout: directive } : {}) };
    plans.push(title);
    if (!isSubtitle(body) && body.length) plans.push({ kind: "content", title: undefined, body, notes: [] });
  }

  let current: SlidePlan | undefined;
  const close = () => {
    if (current && (current.title || current.body.length || current.notes.length)) plans.push(current);
    current = undefined;
  };
  const start = (title: readonly MdInline[] | undefined) => {
    current = { kind: "content", title, body: [], notes: [], ...(pending ? { layout: pending } : {}) };
    pending = undefined;
  };
  const offset = blocks.length - rest.length;
  for (const [at, block] of rest.entries()) {
    const directive = directiveOf(block);
    if (directive !== undefined) {
      // A directive names the layout of the slide it opens; at the end of a slide, of the next one.
      if (current && current.body.length === 0 && current.layout === undefined) current.layout = directive;
      else pending = directive;
    } else if (block.kind === "heading" && block.level <= split && isSlideHeading(block, offset + at)) {
      close();
      start(block.inlines);
    } else if (block.kind === "rule") {
      close();
    } else {
      if (!current) start(undefined);
      const notes = notesOf(block);
      if (notes) current!.notes.push(...notes);
      else current!.body.push(block);
    }
  }
  close();

  // A deck that opens with a heading and a short paragraph or two opens with a title slide.
  const head = plans[0];
  if (head && head.kind === "content" && head.title && first?.kind === "heading" && head.layout === undefined && isSubtitle(head.body)) {
    plans[0] = { ...head, kind: "title" };
  }
  // Notes with no slide of their own (after a `---`, say) belong to the slide before.
  for (let index = plans.length - 1; index > 0; index--) {
    const plan = plans[index]!;
    if (!plan.title && plan.body.length === 0) {
      plans[index - 1]!.notes.push(...plan.notes);
      plans.splice(index, 1);
    }
  }
  return plans;
}

function isSubtitle(blocks: readonly MdBlock[]): boolean {
  return blocks.length <= 3 && blocks.every(block => block.kind === "paragraph" && !isColumnBreak(block) && !IMAGE_TOKEN.test(plainText(block.inlines).trim())) &&
    blocks.reduce((total, block) => total + (block.kind === "paragraph" ? plainText(block.inlines).length : 0), 0) <= MAX_SUBTITLE_CHARS;
}

function separateNotes(blocks: readonly MdBlock[]): { body: MdBlock[]; notes: MdBlock[] } {
  const body: MdBlock[] = [], notes: MdBlock[] = [];
  for (const block of blocks) {
    const found = notesOf(block);
    if (found) notes.push(...found);
    else body.push(block);
  }
  return { body, notes };
}

/** A `> Notes: ...` blockquote's content without its label, or undefined for any other block. */
function notesOf(block: MdBlock): MdBlock[] | undefined {
  if (block.kind !== "quote") return undefined;
  const lead = block.blocks[0];
  if (lead?.kind !== "paragraph") return undefined;
  const match = NOTES_PREFIX.exec(plainText(lead.inlines));
  if (!match) return undefined;
  const inlines = dropChars(lead.inlines, match[0].length);
  return [...(inlines.length ? [{ kind: "paragraph" as const, inlines }] : []), ...block.blocks.slice(1)];
}

/** Inlines without their first `count` characters of text. */
function dropChars(inlines: readonly MdInline[], count: number): MdInline[] {
  const out: MdInline[] = [];
  let remaining = count;
  for (const inline of inlines) {
    if (remaining <= 0) {
      out.push(inline);
    } else if (inline.kind === "text") {
      if (inline.text.length > remaining) out.push({ ...inline, text: inline.text.slice(remaining) });
      remaining -= inline.text.length;
    } else if (inline.kind === "break") {
      remaining--;
    } else {
      const length = plainText(inline.children).length;
      if (length > remaining) out.push({ ...inline, children: dropChars(inline.children, remaining) });
      remaining -= length;
    }
  }
  return out;
}

/** Blocks split at `+++` lines. */
function columnsOf(blocks: readonly MdBlock[]): MdBlock[][] {
  const columns: MdBlock[][] = [[]];
  for (const block of blocks) {
    if (isColumnBreak(block)) columns.push([]);
    else columns.at(-1)!.push(block);
  }
  return columns.filter((column, index) => column.length || index === 0);
}

// ---- Layout slots ----

/** Where a layout puts things: its title, a subtitle, columns of content (each perhaps with a heading), pictures. */
interface Slots {
  readonly title: LayoutPlaceholder | undefined;
  readonly subtitle: LayoutPlaceholder | undefined;
  readonly columns: readonly { readonly header?: LayoutPlaceholder; readonly content: LayoutPlaceholder }[];
  readonly pictures: readonly LayoutPlaceholder[];
}

const byIdx = (a: LayoutPlaceholder, b: LayoutPlaceholder) => Number(a.idx ?? 0) - Number(b.idx ?? 0);

function slotsOf(layout: LayoutInfo): Slots {
  const title = layout.placeholders.find(placeholder => placeholder.type === "title") ?? layout.placeholders.find(placeholder => placeholder.type === "ctrTitle");
  const subtitle = layout.placeholders.find(placeholder => placeholder.type === "subTitle");
  const pictures = layout.placeholders.filter(placeholder => placeholder.type === "pic").toSorted(byIdx);
  const text = layout.placeholders.filter(placeholder => placeholder.type === "obj" || placeholder.type === "body").toSorted(byIdx);
  // Group content placeholders into columns by where they sit across the slide; a short one above
  // another in the same column is that column's heading (Comparison).
  const groups: LayoutPlaceholder[][] = [];
  for (const placeholder of text) {
    const box = placeholder.box;
    const group = box && groups.find(candidate => {
      const other = candidate[0]!.box;
      return other && Math.abs((box.x + box.cx / 2) - (other.x + other.cx / 2)) < Math.min(box.cx, other.cx) / 2;
    });
    if (group) group.push(placeholder);
    else groups.push([placeholder]);
  }
  groups.sort((a, b) => (a[0]!.box?.x ?? 0) - (b[0]!.box?.x ?? 0));
  const columns = groups.map(group => {
    const stacked = group.toSorted((a, b) => (a.box?.y ?? 0) - (b.box?.y ?? 0));
    const last = stacked.at(-1)!;
    const header = stacked.length > 1 && stacked[0]!.box && last.box && stacked[0]!.box.cy < last.box.cy * 0.5 ? stacked[0] : undefined;
    return header ? { header, content: last } : { content: last };
  });
  return { title, subtitle, columns, pictures };
}

// ---- Rendering ----

interface RenderOptions {
  readonly slideNumbers: boolean;
  readonly media: MediaStore;
}

function continued(title: readonly MdInline[] | undefined, page: number): readonly MdInline[] | undefined {
  return title && page > 0 ? [...title, text(" (continued)")] : title;
}

function layoutNames(deck: Deck): string {
  return deck.layouts().map(layout => layout.name || layout.type).join(", ");
}

function renderSlides(deck: Deck, plans: readonly SlidePlan[], images: readonly ImageReference[], options: RenderOptions, index?: number): { part: string; title: string }[] {
  const layouts = deck.chooseLayouts();
  const sizes = deck.bodySizes();
  const metrics: Metrics = { sizes };
  // A placeholder that sets its own size (a caption, a half-width column) is measured at that size.
  const metricsFor = (slot: LayoutPlaceholder | undefined): Metrics =>
    slot?.size ? { sizes: sizes.map(size => Math.round(size * slot.size! / sizes[0]!)) } : metrics;
  const { cx: slideWidth, cy: slideHeight } = deck.slideSize();
  const sizeOf = (ref: string) => options.media.get(ref);
  const out: { part: string; title: string }[] = [];
  let at = index;
  // Where content goes on a layout with no place for it (Title Only, Blank): the standard content area.
  const contentSlot = slotsOf(layouts.content).columns[0]?.content;
  const contentArea: Box = contentSlot?.box ?? { x: slideWidth * 0.069, y: slideHeight * 0.266, cx: slideWidth * 0.862, cy: slideHeight * 0.635 };

  const add = (layout: LayoutInfo, title: readonly MdInline[] | undefined, build: (writer: PartWriter) => string, notes: readonly MdBlock[]) => {
    const part = deck.insertSlide(layout, slidePart => {
      const writer = new PartWriter(deck, slidePart, options.media);
      const numbered = options.slideNumbers && layout.slideNumber !== undefined && layout.type !== "title" && layout.type !== "secHead";
      return slideXml(build(writer) + (numbered
        ? placeholderShape(writer, "Slide Number Placeholder", { type: "sldNum", idx: layout.slideNumber, box: undefined },
          `<a:p>${FIELD_SLIDE_NUMBER}<a:endParaRPr lang="en-US" dirty="0"/></a:p>`, { inherit: true })
        : ""));
    }, at);
    if (at !== undefined) at++;
    if (notes.length) deck.addNotes(part, notesPart => notesXml(deck, notesPart, notes));
    out.push({ part, title: title ? plainText(title).trim() : "" });
  };

  const titleShape = (writer: PartWriter, slot: LayoutPlaceholder | undefined, title: readonly MdInline[] | undefined) => {
    if (!slot || !title) return "";
    const scale = titleScale(title, slot.box, slot.type === "ctrTitle" ? 54 : 36);
    return placeholderShape(writer, "Title", slot, `<a:p>${writer.runs(title, {})}<a:endParaRPr lang="en-US" dirty="0"/></a:p>`, scale !== undefined ? { scale } : {});
  };

  /** One page of content in `area`: text in the placeholder (positioned when it shares the area), the rest stacked below. */
  const renderPage = (writer: PartWriter, page: Page, area: Box, slot: LayoutPlaceholder | undefined): string => {
    const metrics = metricsFor(slot);
    const single = page.items[0];
    if (page.items.length === 1 && single?.kind === "text" && slot && area === slot.box) {
      return placeholderShape(writer, "Content Placeholder", slot, single.paragraphs.map(paragraph => writer.paragraph(paragraph, undefined)).join(""),
        page.scale !== undefined ? { scale: page.scale } : {});
    }
    if (page.items.length === 1 && single?.kind === "image") {
      // A picture alone fills the area, centered both ways.
      return pictureShape(writer, single, { box: centered(imageBox(single, area), area) });
    }
    let shapes = "";
    let y = area.y;
    let usedPlaceholder = false;
    for (const item of page.items) {
      const height = page.items.length === 1 && item.kind === "text" ? area.cy : Math.min(itemHeight(item, area.cx, metrics, area.cy), area.y + area.cy - y);
      const box = { x: area.x, y, cx: area.cx, cy: Math.max(height, 0) };
      switch (item.kind) {
        case "text":
          if (slot && !usedPlaceholder) {
            usedPlaceholder = true;
            shapes += placeholderShape(writer, "Content Placeholder", slot,
              item.paragraphs.map(paragraph => writer.paragraph(paragraph, undefined)).join(""), { box, ...(page.scale !== undefined ? { scale: page.scale } : {}) });
          } else {
            shapes += textBox(writer, box, item.paragraphs.map(paragraph => writer.paragraph(paragraph, sizes, page.scale ?? 1)).join(""));
          }
          break;
        case "table": {
          const table = tableLayout(item, area.cx);
          shapes += tableFrame(writer, { ...box, cy: table.heights.reduce((sum, value) => sum + value, 0) }, item, table);
          break;
        }
        case "code":
          shapes += codeBox(writer, box, item.lines, codeSize(item.lines.length));
          break;
        case "image":
          shapes += pictureShape(writer, item, { box: imageBox(item, { ...area, y }, height) });
          break;
      }
      y += height + GAP;
    }
    return shapes;
  };

  for (const plan of plans) {
    let columns = columnsOf(plan.body);
    const content = columns.flat();
    const explicit = plan.layout !== undefined;
    let layout: LayoutInfo;
    if (explicit) {
      const found = deck.findLayout(plan.layout!);
      if (!found) throw new SlideContentError(`There's no "${plan.layout}" layout in this deck. Its layouts are: ${layoutNames(deck)}.`);
      layout = found;
    } else if (plan.kind === "title") {
      layout = layouts.title;
    } else if (content.length === 0) {
      layout = plan.title ? layouts.sectionHeader : layouts.blank;
    } else if (columns.length >= 2) {
      const headed = columns.every(column => column[0]?.kind === "heading");
      layout = (headed ? layouts.comparison : undefined) ?? layouts.twoContent ?? layouts.comparison ?? layouts.content;
    } else {
      // Content with no title goes on a blank slide, so no empty title or title rule shows.
      layout = plan.title ? layouts.content : layouts.blank;
    }
    const slots = slotsOf(layout);
    const name = plan.title ? `"${plainText(plan.title).trim()}"` : "without a title";

    // Columns: as many as the layout has, or one.
    const capacity = Math.max(1, slots.columns.length);
    if (columns.length > capacity) {
      if (explicit) {
        throw new SlideContentError(`The slide ${name} has ${columns.length} columns separated by +++, but the "${layout.name || layout.type}" layout ` +
          `has room for ${capacity}. Remove a +++ or name a layout with more content areas.`);
      }
      columns = [...columns.slice(0, capacity - 1), columns.slice(capacity - 1).flat()];
    }

    // A title slide: the paragraphs are its subtitle.
    if (slots.subtitle && slots.columns.length === 0) {
      add(layout, plan.title, writer => {
        const subtitle = content.flatMap(block => paragraphs(block, 0, false));
        return titleShape(writer, slots.title, plan.title) +
          (subtitle.length ? placeholderShape(writer, "Subtitle", slots.subtitle!, writer.plainParagraphs(subtitle)) : "");
      }, plan.notes);
      continue;
    }

    // A heading opening a column fills that column's heading placeholder, where the layout has one.
    const split = columns.map((column, at) => {
      const header = slots.columns[at]?.header;
      const lead = column[0];
      return header && lead?.kind === "heading" ? { header: lead.inlines, blocks: column.slice(1) } : { header: undefined, blocks: column };
    });
    const columnItems = split.map(column => items(column.blocks, images, sizeOf));

    // Pictures go to the layout's picture placeholders first, in order.
    const pictures: { item: ImageItem; slot: LayoutPlaceholder & { box: Box } }[] = [];
    for (const slot of slots.pictures) {
      if (!slot.box) continue;
      for (const list of columnItems) {
        const found = list.findIndex(item => item.kind === "image");
        if (found === -1) continue;
        pictures.push({ item: list[found] as ImageItem, slot: slot as LayoutPlaceholder & { box: Box } });
        list.splice(found, 1);
        break;
      }
    }
    const fixed = (writer: PartWriter, title: readonly MdInline[] | undefined, first: boolean) =>
      titleShape(writer, slots.title, title) +
      (first ? pictures.map(picture => pictureShape(writer, picture.item, { placeholder: picture.slot })).join("") : "") +
      split.map((column, at) => column.header && slots.columns[at]?.header
        ? placeholderShape(writer, "Text Placeholder", slots.columns[at]!.header!, writer.plainParagraphs([{ inlines: column.header, kind: "plain", level: 0 }]))
        : "").join("");

    if (slots.columns.length >= 2 && columns.length >= 2) {
      // Side by side, each column fitted to its own area.
      add(layout, plan.title, writer => fixed(writer, plan.title, true) + columnItems.map((list, at) => {
        const slot = slots.columns[at]!.content;
        const area = slot.box ?? contentArea;
        return list.length ? renderPage(writer, fitPage(list, area, metricsFor(slot)), area, slot) : "";
      }).join(""), plan.notes);
      continue;
    }

    // One column of content, continued on further slides as it needs.
    const slot = slots.columns[0]?.content;
    const list = columnItems.flat();
    let area: Box = slot?.box ?? contentArea;
    // With no title, content may rise into the title's place.
    const titleBox = slotsOf(layouts.content).title?.box;
    if (!plan.title && !slots.title && titleBox && area === contentArea) {
      area = { ...area, y: titleBox.y, cy: area.y + area.cy - titleBox.y };
    }
    if (list.length === 0) {
      add(layout, plan.title, writer => fixed(writer, plan.title, true), plan.notes);
      continue;
    }
    paginate(list, area, metricsFor(slot)).forEach((page, pageIndex) => {
      const title = continued(plan.title, pageIndex);
      add(layout, title, writer => fixed(writer, title, pageIndex === 0) + renderPage(writer, page, area, slot), pageIndex === 0 ? plan.notes : []);
    });
  }
  return out;
}
