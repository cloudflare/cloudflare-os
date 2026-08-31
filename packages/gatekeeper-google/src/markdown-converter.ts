// Bidirectional conversion between Google Docs structure and Markdown,
// with source mapping to allow Markdown-level edits to be translated back
// to Google Docs batchUpdate operations.

import type { GoogleDocsDocument, Paragraph } from "./docs-api";

// ---------------------------------------------------------------------------
// Source map types
// ---------------------------------------------------------------------------

/** A complete snapshot of a document, cached in the gatekeeper's DO storage. */
export type DocSnapshot = {
  /** Document title. */
  title: string;
  /** The revisionId at the time the document was fetched. */
  revisionId: string;
  /** The Markdown rendering of the document content. */
  markdown: string;
  /** Maps Markdown positions back to Google Docs character indices. */
  sourceMap: SourceMap;
  /** `Date.now()` at the time of fetch, used for TTL checks. */
  fetchedAt: number;
  /**
   * Write IDs whose marked batch is already present in this snapshot's document.
   *
   * Filled in by the gatekeeper, which owns the write-marker convention; absent on snapshots
   * persisted before it existed, which self-correct on the next fetch.
   */
  committedWriteIds?: string[];
  /** The endIndex of the last structural element in the document body. */
  bodyEndIndex: number;
}

export type SourceMap = {
  /** One entry per structural element (paragraph/heading/list item), in document order. */
  blocks: BlockMapping[];
}

export type BlockMapping = {
  /** Range in the Markdown string [mdStart, mdEnd). */
  mdStart: number;
  mdEnd: number;
  /** Range in Google Docs index space [docStart, docEnd). */
  docStart: number;
  docEnd: number;
  /** Fine-grained segments within this block. */
  segments: Segment[];
}

/**
 * A segment maps a range of Markdown characters to Google Docs characters.
 * Content segments have a 1:1 character mapping (since we emit the raw text
 * from the doc). Syntax-only segments represent Markdown syntax characters
 * (like "**", "# ", "- ") that don't exist in the doc.
 */
export type Segment =
  | { mdStart: number; mdEnd: number; docStart: number; docEnd: number }
  | { mdStart: number; mdEnd: number; syntaxOnly: true };

// ---------------------------------------------------------------------------
// Google Docs → Markdown
// ---------------------------------------------------------------------------

/** Convert a Google Docs document to Markdown with source map. */
export function docToMarkdown(document: GoogleDocsDocument): DocSnapshot {
  let md = "";
  let blocks: BlockMapping[] = [];
  let lastWasListItem = false;

  let elements = document.body.content;
  let bodyEndIndex = elements.length > 0 ? elements[elements.length - 1].endIndex : 0;

  for (let elem of elements) {
    if (!elem.paragraph) {
      // Skip section breaks, tables, table of contents, etc.
      continue;
    }

    let para = elem.paragraph;
    let segments: Segment[] = [];
    let mdStart = md.length;
    let docStart = elem.startIndex;
    let docEnd = elem.endIndex;

    let isListItem = !!para.bullet;
    let isBullet = false;
    let isNumbered = false;
    let nestingLevel = 0;

    if (para.bullet) {
      nestingLevel = para.bullet.nestingLevel;
      let list = document.lists[para.bullet.listId];
      if (list) {
        let level = list.listProperties.nestingLevels[nestingLevel];
        if (level) {
          isBullet = !!level.glyphSymbol;
          isNumbered = !!level.glyphType;
        }
      }
      // Default to bullet if we can't determine the type.
      if (!isBullet && !isNumbered) {
        isBullet = true;
      }
    }

    // Blank line between paragraphs, but not between consecutive list items.
    if (md.length > 0) {
      if (isListItem && lastWasListItem) {
        // No blank line between list items — just the newline from the
        // previous block is sufficient.
      } else {
        md += "\n";
      }
    }

    // Paragraph prefix (heading markers, list markers, etc.).
    let prefix = getParagraphPrefix(para, isBullet, isNumbered, nestingLevel);
    if (prefix) {
      let prefixStart = md.length;
      md += prefix;
      segments.push({ mdStart: prefixStart, mdEnd: md.length, syntaxOnly: true });
    }

    // Emit paragraph content (text runs).
    emitParagraphContent(para, segments, () => md.length, (text) => { md += text; });

    // Trailing newline. Every Google Docs paragraph ends with \n in the doc
    // character space. In Markdown, we use \n as the line terminator.
    // The paragraph's trailing \n is already included in the last text run's
    // content, and we handled it in emitParagraphContent by not emitting it.
    // Instead, we add our own Markdown newline here.
    md += "\n";

    let mdEnd = md.length;
    blocks.push({ mdStart, mdEnd, docStart, docEnd, segments });
    lastWasListItem = isListItem;
  }

  return {
    title: document.title,
    revisionId: document.revisionId,
    markdown: md,
    sourceMap: { blocks },
    fetchedAt: Date.now(),
    bodyEndIndex,
  };
}

/** Determine the Markdown prefix for a paragraph based on its style. */
function getParagraphPrefix(
  para: Paragraph,
  isBullet: boolean,
  isNumbered: boolean,
  nestingLevel: number,
): string {
  let style = para.paragraphStyle.namedStyleType;

  if (isBullet || isNumbered) {
    let indent = "  ".repeat(nestingLevel);
    return isNumbered ? `${indent}1. ` : `${indent}- `;
  }

  switch (style) {
    case "HEADING_1":
    case "TITLE":
      return "# ";
    case "HEADING_2":
      return "## ";
    case "HEADING_3":
      return "### ";
    case "HEADING_4":
      return "#### ";
    case "HEADING_5":
      return "##### ";
    case "HEADING_6":
      return "###### ";
    default:
      return "";
  }
}

/**
 * Emit the content of a paragraph's elements, tracking formatting transitions
 * and recording source map segments.
 *
 * We track open/close state for each formatting type (bold, italic, etc.)
 * and emit Markdown markers at transitions.
 */
function emitParagraphContent(
  para: Paragraph,
  segments: Segment[],
  getMdPos: () => number,
  emit: (text: string) => void,
): void {
  // Track which formatting is currently "open" in the Markdown output.
  let currentBold = false;
  let currentItalic = false;
  let currentStrikethrough = false;
  let currentLink: string | undefined = undefined;

  let isSubtitle = para.paragraphStyle.namedStyleType === "SUBTITLE";

  // If subtitle, open italic.
  if (isSubtitle) {
    let pos = getMdPos();
    emit("*");
    segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
  }

  for (let element of para.elements) {
    if (element.horizontalRule) {
      let pos = getMdPos();
      emit("---");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      continue;
    }

    if (!element.textRun) continue;

    let text = element.textRun.content;
    let style = element.textRun.textStyle;
    let docStart = element.startIndex;

    // Strip the trailing \n from the last element — we handle paragraph
    // termination separately.
    let isLastElement = element === para.elements[para.elements.length - 1];
    if (isLastElement && text.endsWith("\n")) {
      text = text.slice(0, -1);
    }

    if (text.length === 0) continue;

    let wantBold = !!style.bold;
    let wantItalic = !!style.italic || isSubtitle;
    let wantStrikethrough = !!style.strikethrough;
    let wantLink = style.link?.url;

    // Close formatting that is no longer wanted (reverse order of opening).
    if (currentLink && currentLink !== wantLink) {
      let pos = getMdPos();
      emit(`](${currentLink})`);
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentLink = undefined;
    }
    if (currentStrikethrough && !wantStrikethrough) {
      let pos = getMdPos();
      emit("~~");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentStrikethrough = false;
    }
    if (currentBold && !wantBold) {
      let pos = getMdPos();
      emit("**");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentBold = false;
    }
    if (currentItalic && !wantItalic) {
      let pos = getMdPos();
      emit("*");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentItalic = false;
    }

    // Open formatting that is newly wanted.
    if (wantItalic && !currentItalic) {
      let pos = getMdPos();
      emit("*");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentItalic = true;
    }
    if (wantBold && !currentBold) {
      let pos = getMdPos();
      emit("**");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentBold = true;
    }
    if (wantStrikethrough && !currentStrikethrough) {
      let pos = getMdPos();
      emit("~~");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentStrikethrough = true;
    }
    if (wantLink && !currentLink) {
      let pos = getMdPos();
      emit("[");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentLink = wantLink;
    }

    // Emit the actual text content with a content segment.
    let mdContentStart = getMdPos();
    emit(text);
    let mdContentEnd = getMdPos();
    segments.push({
      mdStart: mdContentStart,
      mdEnd: mdContentEnd,
      docStart: docStart,
      docEnd: docStart + text.length,
    });
  }

  // Close any remaining open formatting at end of paragraph.
  if (currentLink) {
    let pos = getMdPos();
    emit(`](${currentLink})`);
    segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
  }
  if (currentStrikethrough) {
    let pos = getMdPos();
    emit("~~");
    segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
  }
  if (currentBold) {
    let pos = getMdPos();
    emit("**");
    segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
  }
  if (currentItalic && !isSubtitle) {
    let pos = getMdPos();
    emit("*");
    segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
  }
  if (isSubtitle) {
    let pos = getMdPos();
    emit("*");
    segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
  }
}

// ---------------------------------------------------------------------------
// Markdown → Google Docs batchUpdate requests
// ---------------------------------------------------------------------------

/** Parsed representation of a Markdown block. */
type ParsedBlock = {
  /** Plain text content (no Markdown syntax). */
  plainText: string;
  /** Paragraph style: heading level (1-6), or null for normal text. */
  headingLevel: number | null;
  /** If this is a list item: "bullet" or "numbered". */
  listType: "bullet" | "numbered" | null;
  /** Nesting level for list items (0-based). */
  nestingLevel: number;
  /** Inline formatting spans, relative to plainText. */
  spans: FormattingSpan[];
}

type FormattingSpan = {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  link?: string;
}

/**
 * Parse a Markdown string into blocks. This is a simple parser that handles
 * the subset of Markdown we support.
 *
 * Unlike standard Markdown, we preserve blank lines as empty blocks so that
 * they produce empty paragraphs in Google Docs. This ensures that `\n\n` in
 * the input produces two paragraph breaks (i.e., a visible blank line) in
 * the document, rather than collapsing to a single paragraph break.
 */
function parseMarkdown(markdown: string): ParsedBlock[] {
  let blocks: ParsedBlock[] = [];

  let lines = markdown.split("\n");
  // Track whether we just flushed content lines, so we know when a blank
  // line follows content (= paragraph separator) vs. additional blank lines
  // (= empty paragraphs).
  let currentLines: string[] = [];
  let justFlushed = false;

  function flushBlock() {
    if (currentLines.length === 0) return;
    let blockText = currentLines.join("\n");
    currentLines = [];

    // Each line could be a heading or list item on its own, so split them.
    let sublines = blockText.split("\n");
    for (let line of sublines) {
      if (line.length === 0) continue;
      blocks.push(parseLine(line));
    }
    justFlushed = true;
  }

  for (let line of lines) {
    if (line.trim() === "") {
      flushBlock();
      if (justFlushed) {
        // First blank line after content is the normal paragraph separator
        // (already handled by the \n between blocks in the output). Reset
        // the flag so subsequent blank lines produce empty paragraphs.
        justFlushed = false;
      } else {
        // Additional blank line — emit an empty block so it becomes an
        // empty paragraph (\n) in the document.
        blocks.push({
          plainText: "",
          headingLevel: null,
          listType: null,
          nestingLevel: 0,
          spans: [],
        });
      }
    } else {
      currentLines.push(line);
      justFlushed = false;
    }
  }
  flushBlock();

  return blocks;
}

/** Parse a single line of Markdown into a ParsedBlock. */
function parseLine(line: string): ParsedBlock {
  let headingLevel: number | null = null;
  let listType: "bullet" | "numbered" | null = null;
  let nestingLevel = 0;
  let content = line;

  // Check for heading prefix.
  let headingMatch = content.match(/^(#{1,6}) /);
  if (headingMatch) {
    headingLevel = headingMatch[1].length;
    content = content.slice(headingMatch[0].length);
  }

  // Check for list item prefix (with optional indentation).
  if (headingLevel === null) {
    let bulletMatch = content.match(/^( *)- /);
    let numberedMatch = content.match(/^( *)\d+\. /);
    if (bulletMatch) {
      listType = "bullet";
      nestingLevel = Math.floor(bulletMatch[1].length / 2);
      content = content.slice(bulletMatch[0].length);
    } else if (numberedMatch) {
      listType = "numbered";
      nestingLevel = Math.floor(numberedMatch[1].length / 2);
      content = content.slice(numberedMatch[0].length);
    }
  }

  // Parse inline formatting.
  let { plainText, spans } = parseInlineFormatting(content);

  return { plainText, headingLevel, listType, nestingLevel, spans };
}

/**
 * Parse inline Markdown formatting from a string, returning the plain text
 * and an array of formatting spans.
 *
 * Handles: **bold**, *italic*, ***bold+italic***, ~~strikethrough~~, [text](url)
 */
function parseInlineFormatting(text: string): { plainText: string; spans: FormattingSpan[] } {
  let plainText = "";
  let spans: FormattingSpan[] = [];
  let i = 0;

  // Stack of open formatting contexts.
  let formatStack: { type: "bold" | "italic" | "bolditalic" | "strikethrough" | "link"; start: number; url?: string }[] = [];

  while (i < text.length) {
    // Check for link: [text](url)
    if (text[i] === "[") {
      let closeBracket = text.indexOf("]", i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        let closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          let linkText = text.slice(i + 1, closeBracket);
          let linkUrl = text.slice(closeBracket + 2, closeParen);
          let start = plainText.length;
          // Recursively parse inline formatting within the link text.
          let inner = parseInlineFormatting(linkText);
          plainText += inner.plainText;
          let end = plainText.length;
          // Add the link span covering the entire link text.
          spans.push({ start, end, link: linkUrl });
          // Add any inner formatting spans, offset by the link start.
          for (let s of inner.spans) {
            spans.push({
              ...s,
              start: start + s.start,
              end: start + s.end,
            });
          }
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Check for bold+italic: ***
    if (text.slice(i, i + 3) === "***") {
      let openIdx = formatStack.findIndex(f => f.type === "bolditalic");
      if (openIdx !== -1) {
        // Closing.
        let open = formatStack.splice(openIdx, 1)[0];
        spans.push({ start: open.start, end: plainText.length, bold: true, italic: true });
      } else {
        formatStack.push({ type: "bolditalic", start: plainText.length });
      }
      i += 3;
      continue;
    }

    // Check for bold: **
    if (text.slice(i, i + 2) === "**") {
      let openIdx = formatStack.findIndex(f => f.type === "bold");
      if (openIdx !== -1) {
        let open = formatStack.splice(openIdx, 1)[0];
        spans.push({ start: open.start, end: plainText.length, bold: true });
      } else {
        formatStack.push({ type: "bold", start: plainText.length });
      }
      i += 2;
      continue;
    }

    // Check for strikethrough: ~~
    if (text.slice(i, i + 2) === "~~") {
      let openIdx = formatStack.findIndex(f => f.type === "strikethrough");
      if (openIdx !== -1) {
        let open = formatStack.splice(openIdx, 1)[0];
        spans.push({ start: open.start, end: plainText.length, strikethrough: true });
      } else {
        formatStack.push({ type: "strikethrough", start: plainText.length });
      }
      i += 2;
      continue;
    }

    // Check for italic: *
    if (text[i] === "*") {
      let openIdx = formatStack.findIndex(f => f.type === "italic");
      if (openIdx !== -1) {
        let open = formatStack.splice(openIdx, 1)[0];
        spans.push({ start: open.start, end: plainText.length, italic: true });
      } else {
        formatStack.push({ type: "italic", start: plainText.length });
      }
      i += 1;
      continue;
    }

    // Regular character.
    plainText += text[i];
    i++;
  }

  // Any unclosed formatting markers are treated as literal text.
  // We need to re-insert them. For simplicity, we don't handle this case
  // perfectly — unclosed markers are just lost. This is acceptable because
  // the agent should be producing well-formed Markdown.

  return { plainText, spans };
}

/**
 * Convert a Markdown string into Google Docs batchUpdate request objects
 * that insert the content at the given document index.
 *
 * Returns requests in the order they should appear in the batchUpdate array.
 */
export function markdownToDocRequests(markdown: string, insertAt: number): any[] {
  let blocks = parseMarkdown(markdown);
  if (blocks.length === 0) return [];

  let requests: any[] = [];

  // First pass: compute the full plain text to insert (all blocks joined with \n).
  // No trailing \n — the document's existing structure provides paragraph
  // terminators after the insertion point.
  let fullText = blocks.map(b => b.plainText).join("\n");
  if (fullText.length === 0) {
    // `parseMarkdown()` treats whitespace-only input as blank Markdown blocks, but replacements
    // can legitimately insert whitespace inside existing text, e.g. splitting a word in two.
    return [{ insertText: { location: { index: insertAt }, text: markdown } }];
  }

  // Insert the full text in one go. This is more efficient and avoids
  // index-shifting complexity from multiple insertions.
  requests.push({
    insertText: {
      location: { index: insertAt },
      text: fullText,
    },
  });

  // Second pass: apply paragraph styles and inline formatting.
  let offset = insertAt;
  for (let block of blocks) {
    let blockStart = offset;
    let blockEnd = offset + block.plainText.length;

    // Paragraph style (headings).
    if (block.headingLevel !== null) {
      let styleType = `HEADING_${block.headingLevel}`;
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: blockStart, endIndex: blockEnd + 1 },
          paragraphStyle: { namedStyleType: styleType },
          fields: "namedStyleType",
        },
      });
    }

    // List items.
    if (block.listType) {
      let preset = block.listType === "numbered"
        ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
        : "BULLET_DISC_CIRCLE_SQUARE";
      requests.push({
        createParagraphBullets: {
          range: { startIndex: blockStart, endIndex: blockEnd + 1 },
          bulletPreset: preset,
        },
      });
    }

    // Inline formatting spans.
    for (let span of block.spans) {
      let spanStart = blockStart + span.start;
      let spanEnd = blockStart + span.end;
      if (spanStart >= spanEnd) continue;

      if (span.bold || span.italic || span.strikethrough) {
        let textStyle: any = {};
        let fields: string[] = [];
        if (span.bold) { textStyle.bold = true; fields.push("bold"); }
        if (span.italic) { textStyle.italic = true; fields.push("italic"); }
        if (span.strikethrough) { textStyle.strikethrough = true; fields.push("strikethrough"); }
        requests.push({
          updateTextStyle: {
            range: { startIndex: spanStart, endIndex: spanEnd },
            textStyle,
            fields: fields.join(","),
          },
        });
      }

      if (span.link) {
        requests.push({
          updateTextStyle: {
            range: { startIndex: spanStart, endIndex: spanEnd },
            textStyle: { link: { url: span.link } },
            fields: "link",
          },
        });
      }
    }

    // Advance past this block's text + the \n separator.
    offset += block.plainText.length + 1;
  }

  return requests;
}

// ---------------------------------------------------------------------------
// Replace operations: map a Markdown edit back to doc operations
// ---------------------------------------------------------------------------

/**
 * Given a match range in the Markdown snapshot, compute the batchUpdate
 * operations to replace that range with new Markdown content.
 *
 * Automatically trims unchanged leading/trailing text to minimize the edit.
 */
export function computeReplaceOperations(
  sourceMap: SourceMap,
  markdown: string,
  matchStart: number,
  matchEnd: number,
  newMarkdown: string,
): { requests: any[]; trimmedOld: string; trimmedNew: string } {
  let oldText = markdown.slice(matchStart, matchEnd);

  // Trim unchanged prefix.
  let prefixLen = 0;
  while (prefixLen < oldText.length && prefixLen < newMarkdown.length &&
         oldText[prefixLen] === newMarkdown[prefixLen]) {
    prefixLen++;
  }

  // Trim unchanged suffix.
  let suffixLen = 0;
  while (suffixLen < oldText.length - prefixLen &&
         suffixLen < newMarkdown.length - prefixLen &&
         oldText[oldText.length - 1 - suffixLen] === newMarkdown[newMarkdown.length - 1 - suffixLen]) {
    suffixLen++;
  }

  let trimmedMatchStart = matchStart + prefixLen;
  let trimmedMatchEnd = matchEnd - suffixLen;
  let trimmedNew = newMarkdown.slice(prefixLen, newMarkdown.length - suffixLen);
  let trimmedOld = oldText.slice(prefixLen, oldText.length - suffixLen);

  // If nothing actually changed, return empty.
  if (trimmedOld.length === 0 && trimmedNew.length === 0) {
    return { requests: [], trimmedOld: "", trimmedNew: "" };
  }

  // Map the trimmed Markdown range to a Google Docs index range.
  let docRange = mdRangeToDocRange(sourceMap, trimmedMatchStart, trimmedMatchEnd);

  if (!docRange) {
    throw new Error(
      "replaceText: could not map the Markdown range to document indices. " +
      "The match may span unsupported content.");
  }

  let requests: any[] = [];

  // Delete the old content (if any).
  if (docRange.start < docRange.end) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: docRange.start, endIndex: docRange.end },
      },
    });
  }

  // Insert the new content (if any).
  if (trimmedNew.length > 0) {
    let insertRequests = markdownToDocRequests(trimmedNew, docRange.start);
    requests.push(...insertRequests);
  }

  return { requests, trimmedOld, trimmedNew };
}

/**
 * Map a Markdown character range [mdStart, mdEnd) to a Google Docs
 * character range, using the source map.
 *
 * Content segments have 1:1 character mapping between Markdown and Doc.
 * Syntax-only segments (Markdown markers like "**", "# ") have no Doc
 * counterpart. If the range falls entirely within syntax-only segments,
 * we expand to the surrounding content boundaries.
 */
function mdRangeToDocRange(
  sourceMap: SourceMap,
  mdStart: number,
  mdEnd: number,
): { start: number; end: number } | null {
  if (mdStart === mdEnd) {
    let docIndex = mdPointToDocIndex(sourceMap, mdStart);
    return docIndex === null ? null : { start: docIndex, end: docIndex };
  }

  let docStart: number | null = null;
  let docEnd: number | null = null;

  for (let block of sourceMap.blocks) {
    // Skip blocks entirely before or after our range.
    if (block.mdEnd <= mdStart) continue;
    if (block.mdStart >= mdEnd) break;

    for (let seg of block.segments) {
      // Skip segments entirely outside our range.
      if (seg.mdEnd <= mdStart) continue;
      if (seg.mdStart >= mdEnd) break;

      if ("syntaxOnly" in seg) {
        // Syntax-only segment overlaps the range. We can't map to doc indices
        // directly, but we need to extend to the nearest content boundary.
        // Use the block's doc range as a fallback.
        if (docStart === null) docStart = block.docStart;
        docEnd = block.docEnd;
        continue;
      }

      // Content segment — compute the overlapping doc range.
      let overlapMdStart = Math.max(mdStart, seg.mdStart);
      let overlapMdEnd = Math.min(mdEnd, seg.mdEnd);

      // 1:1 character mapping within content segments.
      let segDocStart = seg.docStart + (overlapMdStart - seg.mdStart);
      let segDocEnd = seg.docStart + (overlapMdEnd - seg.mdStart);

      if (docStart === null || segDocStart < docStart) docStart = segDocStart;
      if (docEnd === null || segDocEnd > docEnd) docEnd = segDocEnd;
    }
  }

  if (docStart === null || docEnd === null) return null;
  return { start: docStart, end: docEnd };
}

function mdPointToDocIndex(sourceMap: SourceMap, mdPoint: number): number | null {
  for (let block of sourceMap.blocks) {
    if (mdPoint < block.mdStart) continue;
    if (mdPoint > block.mdEnd) continue;

    for (let seg of block.segments) {
      if (mdPoint < seg.mdStart || mdPoint > seg.mdEnd) continue;

      if ("syntaxOnly" in seg) {
        continue;
      }

      return seg.docStart + (mdPoint - seg.mdStart);
    }

    for (let seg of block.segments) {
      if ("syntaxOnly" in seg) continue;
      if (mdPoint <= seg.mdStart) return seg.docStart;
      if (mdPoint <= seg.mdEnd) return seg.docEnd;
    }

    if (mdPoint === block.mdEnd && block.docEnd > block.docStart) {
      return block.docEnd - 1;
    }

    return block.docStart;
  }

  return null;
}
