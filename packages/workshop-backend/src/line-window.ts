// The readFile tool's line windows: the exact text the model sees for a read of a file, rendered
// alike from session text or from a stored blob. A blob is read forward from the window's first
// line, decoding only what the window shows (BlobReader finds the line through its chunk index),
// so a window of a file of any size costs about the window's size.
//
// Both sources go through one renderer over a small "lines" abstraction, so that the same bytes
// render byte-identically either way: replay re-renders recorded reads, sometimes from the other
// source than the live read used, and must reproduce them exactly. Two rules apply to blobs only,
// since session text never needed them and its recorded reads must replay unchanged: binary data
// (a NUL byte) in the shown lines is an error, and a first line too long to show is cut.

import type { BlobReader } from "./git-chunked-blob";
import { UnreadableContentError } from "./git-cache";

/** The source a readFile window is rendered from: session text, or a stored blob. */
export type LineSource =
  | { kind: "text", text: string }
  | { kind: "blob", reader: BlobReader };

/** The line window a readFile call asked for (see AiToolCall's readFile input). */
export type ReadFileWindow = { startLine?: number, lineCount?: number };

/**
 * Renders a readFile result as the exact text the model sees, for both the live tool and history
 * replay; `path` names the file in errors. A read with no window returns the file verbatim when
 * it fits `maxChars`; otherwise, and for any windowed read, the result is the selected lines, a
 * blank line, and `[lines A-B of N; next startLine: B+1]` (without the continuation when B is the
 * last line). `lineCount` is an upper bound: a window ends where the next whole line would push
 * the result past the cap, so the note always says where to continue. Lines are 1-based; a final
 * newline does not start a line. The tool schema already requires positive integers.
 *
 * Lines are never cut from session text, so a single line longer than the cap is the one result
 * that exceeds it. From a blob, such a line is cut to fit, with a note saying so, since it may be
 * a whole file of any size with no newline; and a blob's shown lines must not contain a NUL byte
 * (UnreadableContentError), though bytes outside them are never examined. Invalid UTF-8 in a
 * blob reads as U+FFFD.
 */
export function readFileWindow(source: LineSource, { startLine, lineCount }: ReadFileWindow,
                               path: string, maxChars: number): string {
  let reader = source.kind === "blob" ? source.reader : undefined;
  let lines = source.kind === "text" ? textLines(source.text) : blobLines(source.reader);
  let total = lines.count;
  let checkBinary = (text: string, first: number, last: number) => {
    if (reader !== undefined && text.includes("\0")) {
      throw new UnreadableContentError(`${path} contains binary data in ` +
          (first === last ? `line ${first}` : `lines ${first}-${last}`) +
          ", which readFile cannot show as text.");
    }
  };

  if (startLine === undefined && lineCount === undefined) {
    let whole = lines.whole(maxChars);
    if (whole !== undefined) {
      checkBinary(whole, 1, total);
      return whole;
    }
  }
  let first = startLine ?? 1;
  if (first > total) {
    throw new Error(`startLine ${first} is past the end of the file, which has ` +
        `${total} line${total === 1 ? "" : "s"}.`);
  }
  let note = (last: number) => `[lines ${first}-${last} of ${total}` +
      (last < total ? `; next startLine: ${last + 1}]` : "]");
  // Whole lines, at least one, while they fit under the cap with the longest note this file can
  // produce.
  let limit = lineCount === undefined ? total : Math.min(total, first - 1 + lineCount);
  let budget = maxChars - note(total - 1).length - 2;
  let cursor = lines.from(first - 1);
  let shown = [cursor.next(budget)];
  let chars = shown[0].length;
  if (reader !== undefined && chars > budget) {
    return cutLine(shown[0], lineByteLength(reader, first - 1), first, total, maxChars,
                   checkBinary);
  }
  let last = first;
  while (last < limit) {
    let next = cursor.next(budget - chars - 1);
    if (chars + 1 + next.length > budget) break;
    shown.push(next);
    chars += 1 + next.length;
    ++last;
  }
  let text = shown.join("\n");
  checkBinary(text, first, last);
  return `${text}\n\n${note(last)}`;
}

// A blob's first window line that is too long to show whole: as much of it as fits, and a note.
function cutLine(prefix: string, byteLength: number, line: number, total: number,
                 maxChars: number, checkBinary: (text: string, a: number, b: number) => void)
    : string {
  let note = (shown: number) => `[line ${line} of ${total} is ${byteLength} bytes; showing the ` +
      `first ${shown} characters. Use readBytes for byte ranges.]`;
  let shown = Math.max(0, Math.min(prefix.length, maxChars - 2 - note(maxChars).length));
  // Never split a surrogate pair.
  let code = prefix.charCodeAt(shown - 1);
  if (code >= 0xd800 && code <= 0xdbff) --shown;
  let text = prefix.slice(0, shown);
  checkBinary(text, line, line);
  return `${text}\n\n${note(shown)}`;
}

// A source's lines, as the renderer reads them.
interface Lines {
  /** How many lines there are: a final newline does not start one. */
  readonly count: number;
  /**
   * The whole text, if it is at most `maxChars` long, else undefined (decided without decoding
   * a source that cannot fit).
   */
  whole(maxChars: number): string | undefined;
  /** Reads lines forward from 0-based line `index`. */
  from(index: number): LineCursor;
}

interface LineCursor {
  /**
   * The next line. A source may stop decoding a line once it is longer than `maxChars`, and
   * return just a prefix that is longer than `maxChars`.
   */
  next(maxChars: number): string;
}

function textLines(text: string): Lines {
  let lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return {
    count: lines.length,
    whole: maxChars => text.length <= maxChars ? text : undefined,
    from: index => ({ next: () => lines[index++] }),
  };
}

const NEWLINE = 0x0a;

// Blob text is decoded as session text was: UTF-8 with a leading BOM kept, but not fatally, so
// that invalid bytes read as U+FFFD.
const newDecoder = () => new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

function blobLines(reader: BlobReader): Lines {
  let size = reader.size;
  return {
    count: reader.newlines + (size > 0 && reader.read(size - 1, 1)[0] !== NEWLINE ? 1 : 0),
    whole: maxChars => {
      // Decoding yields at least one UTF-16 code unit per 3 bytes -- a 3-byte sequence gives one,
      // a 4-byte sequence two, and an invalid sequence of at most 3 bytes one U+FFFD -- so a blob
      // larger than this cannot fit, and is never decoded whole.
      if (size > 3 * maxChars) return undefined;
      let text = newDecoder().decode(reader.read(0, size));
      return text.length <= maxChars ? text : undefined;
    },
    from: index => new BlobLineCursor(reader, index),
  };
}

// The byte length of a blob's 0-based line `index`, without its newline, found from the chunk
// index rather than by reading the line.
function lineByteLength(reader: BlobReader, index: number): number {
  let end = index < reader.newlines ? reader.lineStart(index + 1) - 1 : reader.size;
  return end - reader.lineStart(index);
}

class BlobLineCursor implements LineCursor {
  readonly #pieces: Iterator<Uint8Array>;
  #piece: Uint8Array = new Uint8Array();
  #pos = 0;

  constructor(reader: BlobReader, index: number) {
    let start = reader.lineStart(index);
    this.#pieces = reader.pieces({ offset: start, length: reader.size - start })[Symbol.iterator]();
  }

  next(maxChars: number): string {
    let decoder = newDecoder();
    let text = "";
    for (;;) {
      if (this.#pos === this.#piece.length) {
        let next = this.#pieces.next();
        if (next.done) return text + decoder.decode();  // the last line, with no newline
        this.#piece = next.value;
        this.#pos = 0;
      }
      let end = this.#piece.indexOf(NEWLINE, this.#pos);
      if (end >= 0) {
        text += decoder.decode(this.#piece.subarray(this.#pos, end));
        this.#pos = end + 1;
        return text;
      }
      text += decoder.decode(this.#piece.subarray(this.#pos), { stream: true });
      this.#pos = this.#piece.length;
      if (text.length > maxChars) return text;
    }
  }
}
