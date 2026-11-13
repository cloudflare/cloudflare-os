// Finds where a PDF keeps its page images, from the file's bytes as they stream past. A scanner
// writes each page as one image, so with the place and encoding of each, a page can later be read
// from the file on its own without the PDF ever being held or parsed whole.

/**
 * How an image's bytes are encoded, in our own names: `jpeg` is a JPEG file as it stands,
 * `lossless` is deflated rows of samples that {@link PngLayout} describes, and the rest are
 * encodings recognized but not read.
 */
export type PdfImageEncoding = "jpeg" | "lossless" | "fax" | "jbig2" | "jpeg2000" | "other";

/** What a PNG wrapped around a `lossless` image's data must say of it. */
export type PngLayout = {
  /** PNG's colour type: 0 for grey, 2 for RGB. */
  colorType: 0 | 2;
  bitDepth: number;
  /** Bytes in one row of samples. */
  rowBytes: number;
  /** Whether each row already begins with a PNG filter byte, making the data a PNG's as it is. */
  filtered: boolean;
};

/** One image large enough to be a page, and where its data sits in the file. */
export type PdfPageImage = {
  offset: number;
  length: number;
  width: number;
  height: number;
  encoding: PdfImageEncoding;
  /** Present when `encoding` is `lossless`. */
  png?: PngLayout;
  /** The file did not hold the data where and as long as it said, so `length` is not reliable. */
  damaged: boolean;
};

/** What a scan found once the file has ended. */
export type PdfImages = {
  /** Page images in the order the file stores them, at most {@link MAX_PAGE_IMAGES}. */
  images: PdfPageImage[];
  /** Whether the file held more page images than were kept. */
  more: boolean;
  /** Whether the file is encrypted, which makes every stream in it unreadable as it is. */
  encrypted: boolean;
  /**
   * How a mask as large as a page is stored, when the file has one stored as fax or JBIG2. A mask
   * is no page image, but those two hold one bit a pixel, which is how a page's text is kept: as
   * the mask over a layered scan's colour layers, or as the whole of a black-and-white page.
   */
  maskEncoding?: "fax" | "jbig2";
  /** How many bytes the file had. */
  bytes: number;
  /** How many images are too small to be a page: tiles or strips of one, or a stamp on it. */
  pieces: number;
  /** How many masks are as large as a page, however they are stored. */
  pageMasks: number;
  /**
   * Present when an image that named a mask is defined again later in the file, as an update
   * does. What it named first was let go as a mask and may be a page's image now, so which of
   * the file's images are pages can no longer be told from what was kept.
   */
  masksRedefined?: true;
};

/** The most page images a scan keeps. */
export const MAX_PAGE_IMAGES = 2000;
/**
 * The most images held while the file goes by. A mask the file holds before the image that names
 * it is held as a page image until then, and an image names two at most, so this is room for
 * {@link MAX_PAGE_IMAGES} pages and their masks.
 */
const MAX_HELD_IMAGES = 3 * MAX_PAGE_IMAGES;
/** The shorter side, in pixels, below which an image is an icon, thumbnail or stamp, not a page. */
const MIN_PAGE_SIDE = 200;
/**
 * Characters of one object held while looking for its end, and the longest object that is read;
 * an image's dictionary is far smaller. A longer one is passed over without being held.
 */
const MAX_OBJECT_CHARS = 64 * 1024;
/**
 * Entries kept of each kind of small object an image can refer to, of the lengths streams waited
 * for, and of the images used as masks.
 */
const MAX_NOTED = 20_000;

const WHITESPACE = "\0\t\n\f\r ";
const DELIMITERS = "()<>[]{}/%";
/**
 * What the scan stops at between objects: the marker that ends a revision of the file, a
 * comment's start, or an object's header, "N G obj", whose number is captured. Writers put one
 * character between a header's parts; up to eight are taken, so that the longest header has a
 * known length and one cut by a chunk's end is held whole.
 */
const OBJECT_START = /%%EOF|%|(\d{1,10})[\0\t\n\f\r ]{1,8}\d{1,5}[\0\t\n\f\r ]{1,8}obj(?![A-Za-z0-9])/g;
/** What ends a revision of the file. An update may be appended straight after it. */
const REVISION_END = "%%EOF";
/**
 * The longest header {@link OBJECT_START} matches (34 characters) and the trailer's "/Encrypt",
 * however it is spelled (22 at most), both fit in this.
 */
const SCAN_TAIL = 40;
/**
 * What comes between the `stream` keyword and its data: a line end, with up to eight blanks
 * before it. The format has "\r\n" or "\n" follow the keyword at once; files are found with "\r"
 * alone, and with blanks left before the line end, and readers take both.
 */
const DATA_START = /[\0\t\f ]{0,8}(?:\r\n|\n|\r)/y;
/** The longest {@link DATA_START} match. */
const MAX_DATA_START = 10;
/** A character of a name spelled as "#" and its code in two hex digits, as any may be. */
const NAME_ESCAPE = /#([0-9A-Fa-f]{2})/g;
/** Inside an object, outside any token: characters that begin none the scan must follow. */
const PLAIN_RUN = /[^%(</A-Za-z]*/y;
/** Inside a string: characters that neither nest it, close it nor escape the next. */
const STRING_RUN = /[^()\\]*/y;
/** The rest of a name. */
const NAME_RUN = /[^\0\t\n\f\r ()<>[\]{}/%]*/y;
const LETTER_RUN = /[A-Za-z]*/y;
const LINE_END = /[\n\r]/g;
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)/y;
const REFERENCE_REST = /[\0\t\n\f\r ]+\d{1,5}[\0\t\n\f\r ]+R(?![A-Za-z0-9])/y;
const KEYWORD = /[A-Za-z]+/y;

/**
 * A PDF value as far as the scan needs it: numbers, booleans, names (kept with their slash),
 * references, arrays and dictionaries. Strings and `null` are `undefined`.
 */
type PdfValue = number | boolean | string | { ref: number } | PdfValue[] | PdfDict | undefined;
type PdfDict = Map<string, PdfValue>;

/**
 * What a colour space comes to: its number of components when it is grey (1) or RGB (3), or the
 * colour profile stream whose dictionary says how many.
 */
type ColorSpace = 1 | 3 | { profile: number };

/** What a deflated image's dictionary says of its rows, short of what its colour space comes to. */
type Rows = {
  /** The colour space, or the object that holds it. */
  space: ColorSpace | { ref: number } | undefined;
  bitDepth: number;
  /** When each row begins with a PNG filter byte: the components the filters were worked over. */
  filterColors?: number;
};

/**
 * An image as its dictionary described it, before what it refers to is known. Nothing of the
 * dictionary itself is kept, nor of the text it was read from.
 */
type Candidate = {
  offset: number;
  width: number;
  height: number;
  /** How the dictionary says the data is encoded; `lossless` only if `rows` prove to be a PNG's. */
  encoding: PdfImageEncoding;
  /** Present when the data is deflated rows a PNG may hold. */
  rows?: Rows;
  /** The length the dictionary gave, or the object it named for it. */
  declared: number | { ref: number } | undefined;
  /**
   * When the length was unknown: bytes from the data's start to the `endstream` found by
   * searching, and how many of the last of them are a line end.
   */
  searched?: { bytes: number; lineEnd: number };
  /** The data's length once it is settled. */
  length?: number;
  damaged: boolean;
};

/**
 * Reads a PDF fed to it in order, in chunks cut anywhere, and reports its page images at the end.
 * It walks the file's objects from the front rather than from its cross-reference table, which
 * sits at the end, and holds only the object it is reading, up to {@link MAX_OBJECT_CHARS} of it
 * (stream data is skipped, never kept), and a few numbers of each image and of each small object
 * an image may refer to: lengths, colour spaces and colour profiles' sizes. Each byte of the file
 * is looked at a bounded number of times, whatever the file holds. Objects kept inside compressed
 * object streams are not seen, so a length stored in one is found by looking for the end of the
 * data instead.
 *
 * An image is taken for a page when both its sides are at least {@link MIN_PAGE_SIDE} pixels and it is
 * neither a mask nor another image's mask. A smaller one is only counted
 * ({@link PdfImages.pieces}), and so is a mask that large ({@link PdfImages.pageMasks}), with how
 * it is stored when that is as fax or JBIG2 ({@link PdfImages.maskEncoding}). Both counts are made
 * as the file goes by, so an image defined again is counted again. Nothing here follows the page
 * tree, so the order is the file's, which is page order for scanner output but is not guaranteed,
 * and an image that no page shows is reported like any other. An object defined again later in
 * the file, as an incremental update does, replaces the earlier one and takes its place in the
 * order.
 */
export class PdfImageScan {
  /** Bytes read but not yet passed, as one character each. */
  #pending = "";
  /** How many bytes came before `#pending`. */
  #passed = 0;
  #state: "scan" | "object" | "data" | "afterData" | "search" = "scan";
  /** The object being read: its number, and how much of `#pending` has been read for its end. */
  #object = 0;
  #searched = 0;
  /** Where that reading stands: between tokens, or inside one that can run on past a chunk's end. */
  #within: "value" | "string" | "hex" | "comment" | "name" | "word" = "value";
  /** How deep in nested parentheses, inside a string. */
  #nesting = 0;
  /** Whether the object has proved too long to be read, so that its text is no longer held. */
  #oversized = false;
  /** Bytes of the stream being skipped that are still to come. */
  #remaining = 0;
  /** The image whose data is being passed, if it is one. */
  #image: Candidate | undefined;
  #ended = false;

  /**
   * The images found that are not known to be masks, by object number, in the file's order, at
   * most {@link MAX_HELD_IMAGES}. One whose object is defined again as an image keeps its place.
   */
  #candidates = new Map<number, Candidate>();
  /** Whether an image was let go for want of room. */
  #more = false;
  #encrypted = false;
  /**
   * How each mask as large as a page is stored, by object number, when that is as fax or JBIG2;
   * at most {@link MAX_NOTED}.
   */
  #pageMasks = new Map<number, "fax" | "jbig2">();
  /** Objects that are a whole number, by number: a stream's length is often one. */
  #integers = new Map<number, number>();
  /**
   * Length objects a stream named before the file had defined them, as a writer that keeps each
   * length after its stream leaves them; at most {@link MAX_NOTED}. When a later stream names
   * one, as in an incremental update that defines both again, what is known of it is the
   * earlier stream's length, and the stream's own is still to come.
   */
  #awaited = new Set<number>();
  /** Objects that are a grey or RGB colour space, by number. */
  #spaces = new Map<number, ColorSpace>();
  /** Component counts of colour profile streams, by number. */
  #profiles = new Map<number, number>();
  /** Images other images use as their mask, at most {@link MAX_NOTED}. */
  #masks = new Set<number>();
  /** How many image dictionaries read so far were too small to be a page's. */
  #pieces = 0;
  /** How many masks as large as a page were read so far, however stored. */
  #pageMaskCount = 0;
  /** Images that named a mask, at most {@link MAX_NOTED}, and whether one was defined again. */
  #masked = new Set<number>();
  #masksRedefined = false;

  /** Reads the next bytes of the file. */
  feed(chunk: Uint8Array): void {
    for (;;) {
      if (this.#state === "data") {
        // Stream data is counted past without being decoded or kept.
        let held = Math.min(this.#remaining, this.#pending.length);
        this.#drop(held);
        this.#remaining -= held;
        let skipped = Math.min(this.#remaining, chunk.byteLength);
        chunk = chunk.subarray(skipped);
        this.#passed += skipped;
        this.#remaining -= skipped;
        if (this.#remaining > 0) return;
        this.#state = "afterData";
      }
      if (chunk.byteLength > 0) {
        this.#pending += latin1(chunk);
        chunk = chunk.subarray(chunk.byteLength);
      }
      if (!this.#step()) return;
    }
  }

  /** Reads the end of the file and reports what was found. Call once, after the last `feed`. */
  end(): PdfImages {
    this.#ended = true;
    this.feed(new Uint8Array(0));
    // Data the file ended inside was not all there.
    if (this.#image && this.#state !== "scan") this.#image.damaged = true;
    let images: PdfPageImage[] = [];
    for (let candidate of this.#candidates.values()) {
      if (images.length === MAX_PAGE_IMAGES) break;
      let { offset, width, height, rows } = candidate;
      let length = this.#settledLength(candidate);
      let png = rows && this.#pngLayout(rows, width);
      images.push({
        offset, length: length ?? 0, width, height, ...(png ? { png } : {}),
        encoding: rows && !png ? "other" : candidate.encoding,
        damaged: candidate.damaged || length === undefined || length === 0,
      });
    }
    let [maskEncoding] = this.#pageMasks.values();
    return {
      images, more: this.#more || this.#candidates.size > MAX_PAGE_IMAGES,
      encrypted: this.#encrypted, bytes: this.#passed + this.#pending.length,
      ...(maskEncoding ? { maskEncoding } : {}),
      pieces: this.#pieces, pageMasks: this.#pageMaskCount,
      ...(this.#masksRedefined ? { masksRedefined: true as const } : {}),
    };
  }

  #drop(count: number): void {
    this.#pending = this.#pending.slice(count);
    this.#passed += count;
  }

  /** Advances through `#pending` once. False when it can go no further without more bytes. */
  #step(): boolean {
    switch (this.#state) {
      case "scan": return this.#findObject();
      case "object": return this.#readObject();
      case "afterData": return this.#endData();
      case "search": return this.#findDataEnd();
      case "data": return true;
    }
  }

  /**
   * Between objects: looks for the next one, and for a trailer that names an encryption. A
   * header inside a comment is no object's. A trailer's `/Encrypt` is looked for there all the
   * same, since a `%` in one of the trailer's strings reads as a comment's start.
   */
  #findObject(): boolean {
    let text = this.#pending;
    /** How far `text` has been read: to where the last comment in it began, or ended. */
    let from = 0;
    let header: RegExpExecArray | undefined;
    while (!header) {
      if (this.#within === "comment") {
        LINE_END.lastIndex = from;
        let lineEnd = LINE_END.exec(text);
        if (!lineEnd) break;
        from = lineEnd.index;
        this.#within = "value";
      }
      OBJECT_START.lastIndex = from;
      let match = OBJECT_START.exec(text);
      if (!match) break;
      if (match[1] !== undefined) {
        header = match;
      } else if (match[0] === REVISION_END) {
        // A comment in form, but one that ends with itself: a file may end without a line
        // end, and what an update appends after it is then on the same line.
        from = match.index + REVISION_END.length;
      } else if (REVISION_END.startsWith(text.slice(match.index)) && !this.#ended) {
        // What may be that marker, cut off by the chunk's end.
        from = match.index;
        break;
      } else {
        this.#within = "comment";
        from = match.index + 1;
      }
    }
    let between = header ? text.slice(0, header.index) : text;
    if (unescaped(between).includes("/Encrypt")) this.#encrypted = true;
    if (!header) {
      // What is kept may hold a header or an "/Encrypt" cut off by the chunk's end. Nothing is
      // kept from before `from`, where it would be read again without the comment it stands by.
      this.#drop(Math.max(from, text.length - SCAN_TAIL));
      return false;
    }
    this.#object = Number(header[1]);
    // The masks an earlier definition of this object named were let go as masks, and are not
    // taken up again as images: that is said, whatever the object is defined as now, since one
    // of them may be a page's image in the file as it stands.
    if (this.#masked.has(this.#object)) this.#masksRedefined = true;
    this.#drop(header.index + header[0].length);
    this.#searched = 0;
    this.#within = "value";
    this.#oversized = false;
    this.#state = "object";
    return true;
  }

  /**
   * Inside an object: reads on to the `endobj` or `stream` that ends it, then reads what came
   * before as one value. An object longer than {@link MAX_OBJECT_CHARS}, or that is not one
   * value, is passed over to its end without being read: it is not an image's dictionary.
   */
  #readObject(): boolean {
    let end = this.#objectEnd();
    if (!end) {
      if (this.#searched > MAX_OBJECT_CHARS) this.#oversized = true;
      if (this.#oversized) {
        // Only where the reading stands is kept of an object this long, not its text.
        this.#drop(this.#searched);
        this.#searched = 0;
      }
      return false;
    }
    let value: PdfValue | typeof UNREAD = UNREAD;
    if (!this.#oversized && end.at <= MAX_OBJECT_CHARS) {
      try {
        value = parseValue(this.#pending.slice(0, end.at));
      } catch {
        // Not one value.
      }
    }
    this.#drop(end.after);
    // Whatever the object is, it replaces all that an earlier definition of it was noted as,
    // short of a page image, which one defined again as a page image keeps the place of.
    for (let noted of [this.#integers, this.#spaces, this.#profiles, this.#pageMasks]) {
      noted.delete(this.#object);
    }
    if (!end.stream) {
      if (value === UNREAD) this.#candidates.delete(this.#object);
      else this.#noteObject(value);
      this.#state = "scan";
    } else if (value instanceof Map) {
      this.#beginStream(value);
    } else {
      // A stream whose dictionary cannot be read: its data is passed over to its end.
      this.#candidates.delete(this.#object);
      this.#image = undefined;
      this.#state = "search";
    }
    return true;
  }

  /**
   * Reads `#pending` on from `#searched`, once, for the keyword that ends the object: `endobj`,
   * or `stream` with the line end that stream data follows. A keyword inside a string, a comment
   * or a name is not one, so where the reading stands is kept from one chunk to the next rather
   * than worked out again. `at` is where the keyword begins and `after` where what follows it
   * does; `undefined` when more of the file is needed.
   */
  #objectEnd(): { at: number; after: number; stream: boolean } | undefined {
    let text = this.#pending;
    let at = this.#searched;
    let run = (pattern: RegExp) => {
      pattern.lastIndex = at;
      return pattern.exec(text)![0].length;
    };
    try {
      while (at < text.length) {
        switch (this.#within) {
          case "comment": {
            LINE_END.lastIndex = at;
            let lineEnd = LINE_END.exec(text);
            at = lineEnd ? lineEnd.index : text.length;
            if (lineEnd) this.#within = "value";
            break;
          }
          case "string": {
            at += run(STRING_RUN);
            let ch = text[at];
            if (ch === "\\") {
              // The character escaped may not have arrived yet.
              if (at + 1 === text.length && !this.#ended) return undefined;
              at += 2;
            } else if (ch === "(") {
              this.#nesting++;
              at++;
            } else if (ch === ")") {
              if (--this.#nesting === 0) this.#within = "value";
              at++;
            }
            break;
          }
          case "hex": {
            let close = text.indexOf(">", at);
            at = close < 0 ? text.length : close + 1;
            if (close >= 0) this.#within = "value";
            break;
          }
          case "name":
          case "word":
            at += run(this.#within === "name" ? NAME_RUN : LETTER_RUN);
            if (at < text.length) this.#within = "value";
            break;
          case "value": {
            at += run(PLAIN_RUN);
            let ch = text[at];
            if (ch === undefined) break;
            if (ch === "%") {
              this.#within = "comment";
            } else if (ch === "(") {
              this.#within = "string";
              this.#nesting = 1;
            } else if (ch === "/") {
              this.#within = "name";
            } else if (ch === "<") {
              // "<<" opens a dictionary and "<" a string of hex digits; the second may not be here yet.
              if (at + 1 === text.length && !this.#ended) return undefined;
              if (text[at + 1] === "<") at++;
              else this.#within = "hex";
            } else {
              let word = text.slice(at, at + run(LETTER_RUN));
              let after = at + word.length;
              let cutOff = after === text.length && !this.#ended;
              if (word.length > "endobj".length) {
                at = after;
                if (cutOff) this.#within = "word";
                break;
              }
              // A word this short may be a keyword whose end, or whose line end, is yet to come.
              if (cutOff) return undefined;
              if (word === "endobj") return { at, after, stream: false };
              if (word === "stream") {
                if (after + MAX_DATA_START > text.length && !this.#ended) return undefined;
                DATA_START.lastIndex = after;
                let start = DATA_START.exec(text);
                if (start) return { at, after: after + start[0].length, stream: true };
              }
              at = after;
              break;
            }
            at++;
            break;
          }
        }
      }
      return undefined;
    } finally {
      this.#searched = Math.min(at, text.length);
    }
  }

  /**
   * Keeps what an image may refer to of an object that is no stream: a length, or a colour
   * space. Whatever it is, it replaces an image an earlier definition of the object gave.
   */
  #noteObject(value: PdfValue): void {
    this.#candidates.delete(this.#object);
    let space = colorSpace(value);
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      if (this.#integers.size < MAX_NOTED) this.#integers.set(this.#object, value);
    } else if (space !== undefined) {
      if (this.#spaces.size < MAX_NOTED) this.#spaces.set(this.#object, space);
    }
  }

  /** Notes what a stream's dictionary says, with `#pending` at the first byte of its data. */
  #beginStream(dict: PdfDict): void {
    let type = dict.get("/Type");
    // A cross-reference stream carries the trailer's entries.
    if (type === "/XRef" && dict.has("/Encrypt")) this.#encrypted = true;
    let declared = dict.get("/Length");
    let length = typeof declared === "number" ? declared : undefined;
    if (isRef(declared)) {
      // What is known of a length object that a stream has waited for may be another stream's
      // length, so the data is not counted past by it: its end is looked for, and the length
      // is settled once the file has been read.
      if (!this.#awaited.has(declared.ref)) length = this.#integers.get(declared.ref);
      if (length === undefined && this.#awaited.size < MAX_NOTED) this.#awaited.add(declared.ref);
    }
    this.#image = undefined;
    if (dict.get("/Subtype") === "/Image") {
      this.#image = this.#candidate(dict);
    } else if (type !== "/XRef" && type !== "/ObjStm") {
      let components = dict.get("/N");
      if (typeof components === "number" && this.#profiles.size < MAX_NOTED) {
        this.#profiles.set(this.#object, components);
      }
    }
    // Anything but a page image replaces the one an earlier definition of the object gave.
    if (!this.#image) this.#candidates.delete(this.#object);
    if (length !== undefined && Number.isSafeInteger(length) && length >= 0) {
      this.#remaining = length;
      this.#state = "data";
    } else {
      this.#state = "search";
    }
  }

  /** The image a dictionary describes, kept if it could be a page. */
  #candidate(dict: PdfDict): Candidate | undefined {
    for (let key of ["/SMask", "/Mask"]) {
      let mask = dict.get(key);
      if (!isRef(mask)) continue;
      // An image that cannot be noted is taken for one defined again: it may be, unseen.
      if (this.#masked.size < MAX_NOTED) this.#masked.add(this.#object);
      else this.#masksRedefined = true;
      // A mask is no page, whether the file holds it before the image it masks or after, so
      // it is let go as soon as it is known for one and never counts towards the most kept.
      this.#noteMask(mask.ref, this.#candidates.get(mask.ref)?.encoding);
      if (this.#candidates.delete(mask.ref)) this.#pageMaskCount++;
      if (this.#masks.size < MAX_NOTED) this.#masks.add(mask.ref);
    }
    let width = dict.get("/Width"), height = dict.get("/Height");
    if (typeof width !== "number" || typeof height !== "number" ||
        !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        Math.min(width, height) < MIN_PAGE_SIDE) {
      this.#pieces++;
      return undefined;
    }
    let stored = encoding(dict, width);
    if (dict.get("/ImageMask") === true || this.#masks.has(this.#object)) {
      this.#noteMask(this.#object, stored.encoding);
      this.#pageMaskCount++;
      return undefined;
    }
    if (!this.#candidates.has(this.#object) && this.#candidates.size >= MAX_HELD_IMAGES) {
      this.#more = true;
      return undefined;
    }
    let declared = dict.get("/Length");
    let candidate: Candidate = {
      offset: this.#passed, width, height, damaged: false, ...stored,
      declared: typeof declared === "number" || isRef(declared) ? declared : undefined,
    };
    this.#candidates.set(this.#object, candidate);
    return candidate;
  }

  /** Notes how `mask`, a mask as large as a page, is stored, when that is as fax or JBIG2. */
  #noteMask(mask: number, stored: PdfImageEncoding | undefined): void {
    if ((stored === "fax" || stored === "jbig2") && this.#pageMasks.size < MAX_NOTED) {
      this.#pageMasks.set(mask, stored);
    }
  }

  /** After a stream's data: the file must say `endstream` here, or the length was wrong. */
  #endData(): boolean {
    let text = this.#pending;
    if (text.length < "\r\nendstream".length && !this.#ended) return false;
    let end = /^(?:\r\n|\n|\r)?endstream/.exec(text);
    if (end) {
      this.#drop(end[0].length);
      if (this.#image) this.#image.length = this.#passed - end[0].length - this.#image.offset;
    } else if (this.#image) {
      this.#image.damaged = true;
    }
    this.#image = undefined;
    this.#state = "scan";
    return true;
  }

  /** In stream data of unknown length: looks for the `endstream` that closes it. */
  #findDataEnd(): boolean {
    let text = this.#pending;
    let end = text.indexOf("endstream");
    if (end < 0) {
      // Keeps a cut-off keyword and the line end that may come before it.
      this.#drop(Math.max(0, text.length - 10));
      return false;
    }
    if (this.#image) {
      let before = text.slice(Math.max(0, end - 2), end);
      this.#image.searched = {
        bytes: this.#passed + end - this.#image.offset,
        lineEnd: before.endsWith("\r\n") ? 2 : /[\r\n]$/.test(before) ? 1 : 0,
      };
    }
    this.#drop(end + "endstream".length);
    this.#image = undefined;
    this.#state = "scan";
    return true;
  }

  /**
   * How long an image's data is: what the file said when that proved right, or else the distance
   * to the `endstream` found, less the line end before it. A length object read after the data
   * is believed over that when the two agree to within a line end, since data can itself end in
   * one. One that says the data is longer leaves the length unsettled: the `endstream` found
   * was inside the data, which may hold the word. One that says it is shorter by more than a
   * line end is not believed: what was found is where the data ends, as when a writer counts a
   * JPEG and then adds to it.
   */
  #settledLength(candidate: Candidate): number | undefined {
    if (candidate.length !== undefined) return candidate.length;
    let { searched, declared } = candidate;
    if (searched === undefined) return undefined;
    let named = isRef(declared) ? this.#integers.get(declared.ref) : undefined;
    if (named === undefined || searched.bytes - named > 2) {
      return Math.max(0, searched.bytes - searched.lineEnd);
    }
    return named <= searched.bytes ? named : undefined;
  }

  /**
   * How a deflated image's rows map onto a PNG's, or `undefined` when they do not: PNG holds grey
   * and RGB samples only, so a palette, CMYK or a colour space that cannot be resolved is left
   * unread.
   */
  #pngLayout({ space, bitDepth, filterColors }: Rows, width: number): PngLayout | undefined {
    if (typeof space === "object" && "ref" in space) space = this.#spaces.get(space.ref);
    let components = typeof space === "object" ? this.#profiles.get(space.profile) : space;
    if ((components !== 1 && components !== 3) ||
        !(components === 1 ? [1, 2, 4, 8, 16] : [8, 16]).includes(bitDepth) ||
        (filterColors !== undefined && filterColors !== components)) {
      return undefined;
    }
    return {
      colorType: components === 1 ? 0 : 2, bitDepth, filtered: filterColors !== undefined,
      rowBytes: Math.ceil(width * components * bitDepth / 8),
    };
  }
}

/** A value that could not be read. */
const UNREAD = Symbol("unread");

/** What a colour space, written as a name or an array, comes to when it is grey or RGB. */
function colorSpace(space: PdfValue): ColorSpace | undefined {
  let family = Array.isArray(space) ? space[0] : space;
  if (family === "/DeviceGray" || family === "/CalGray") return 1;
  if (family === "/DeviceRGB" || family === "/CalRGB") return 3;
  if (family === "/ICCBased" && Array.isArray(space) && isRef(space[1])) {
    return { profile: space[1].ref };
  }
  return undefined;
}

/** How an image's dictionary says its data is encoded: all that is kept of the dictionary. */
function encoding(dict: PdfDict, width: number): Pick<Candidate, "encoding" | "rows"> {
  let filter = dict.get("/Filter");
  let filters = Array.isArray(filter) ? filter : filter === undefined ? [] : [filter];
  if (filters.length !== 1) return { encoding: "other" };
  switch (filters[0]) {
    case "/DCTDecode": return { encoding: "jpeg" };
    case "/CCITTFaxDecode": return { encoding: "fax" };
    case "/JBIG2Decode": return { encoding: "jbig2" };
    case "/JPXDecode": return { encoding: "jpeg2000" };
    case "/FlateDecode": {
      let rows = deflatedRows(dict, width);
      return rows ? { encoding: "lossless", rows } : { encoding: "other" };
    }
    default: return { encoding: "other" };
  }
}

/**
 * What a deflated image's dictionary says of its rows, or `undefined` when they are not ones a
 * PNG holds: plain rows, or rows with PNG's own filter bytes. A TIFF predictor is left unread,
 * and so are parameters kept in an object of their own, which may name one. A `/Decode` array
 * that inverts the samples is not applied, so such an image reads as a negative.
 */
function deflatedRows(dict: PdfDict, width: number): Rows | undefined {
  let bitDepth = dict.get("/BitsPerComponent");
  if (typeof bitDepth !== "number") return undefined;
  let parms = dict.get("/DecodeParms");
  if (Array.isArray(parms)) parms = parms[0];
  if (parms !== undefined && !(parms instanceof Map)) return undefined;
  let space = dict.get("/ColorSpace");
  let rows: Rows = { space: isRef(space) ? space : colorSpace(space), bitDepth };
  let predictor = parms?.get("/Predictor") ?? 1;
  if (predictor === 1) return rows;
  let filterColors = parms!.get("/Colors") ?? 1;
  if (typeof predictor !== "number" || predictor < 10 || predictor > 15 ||
      typeof filterColors !== "number" || (parms!.get("/Columns") ?? 1) !== width ||
      (parms!.get("/BitsPerComponent") ?? 8) !== bitDepth) {
    return undefined;
  }
  return { ...rows, filterColors };
}

function isRef(value: PdfValue): value is { ref: number } {
  return typeof value === "object" && !Array.isArray(value) && !(value instanceof Map);
}

/**
 * `text` with every character that is spelled as a name may spell it, "#" and two hex digits,
 * written as itself: "/Im#61ge" is the name "/Image".
 */
function unescaped(text: string): string {
  return text.replace(NAME_ESCAPE, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

/** `bytes` as a string of one character per byte, so that indexes into it are byte offsets. */
function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.byteLength; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return text;
}

function fail(): never {
  throw new Error("not one PDF value");
}

/** The one value that `text` holds, with nothing but whitespace around it. Throws when it is not that. */
function parseValue(text: string): PdfValue {
  let at = 0;
  let skip = () => {
    for (; at < text.length; at++) {
      if (text[at] === "%") {
        while (at < text.length && text[at] !== "\n" && text[at] !== "\r") at++;
      } else if (!WHITESPACE.includes(text[at]!)) {
        return;
      }
    }
  };
  let value = (depth: number): PdfValue => {
    if (depth > 32) fail();
    skip();
    let ch = text[at];
    if (ch === undefined) return fail();
    if (text.startsWith("<<", at)) {
      at += 2;
      let dict: PdfDict = new Map();
      for (;;) {
        skip();
        if (text.startsWith(">>", at)) {
          at += 2;
          return dict;
        }
        let key = value(depth + 1);
        if (typeof key !== "string") return fail();
        dict.set(key, value(depth + 1));
      }
    }
    if (ch === "<") {
      at = text.indexOf(">", at) + 1;
      return at === 0 ? fail() : undefined;
    }
    if (ch === "(") {
      for (let open = 0; at < text.length; at++) {
        if (text[at] === "\\") at++;
        else if (text[at] === "(") open++;
        else if (text[at] === ")" && --open === 0) {
          at++;
          return undefined;
        }
      }
      return fail();
    }
    if (ch === "[") {
      at++;
      let items: PdfValue[] = [];
      for (;;) {
        skip();
        if (text[at] === "]") {
          at++;
          return items;
        }
        items.push(value(depth + 1));
      }
    }
    if (ch === "/") {
      let start = at++;
      while (at < text.length && !WHITESPACE.includes(text[at]!) && !DELIMITERS.includes(text[at]!)) at++;
      return unescaped(text.slice(start, at));
    }
    NUMBER.lastIndex = at;
    let number = NUMBER.exec(text);
    if (number) {
      at += number[0].length;
      REFERENCE_REST.lastIndex = at;
      let rest = /^\d+$/.test(number[0]) ? REFERENCE_REST.exec(text) : null;
      if (!rest) return Number(number[0]);
      at += rest[0].length;
      return { ref: Number(number[0]) };
    }
    KEYWORD.lastIndex = at;
    let keyword = KEYWORD.exec(text)?.[0];
    at += keyword?.length ?? 0;
    if (keyword === "true" || keyword === "false") return keyword === "true";
    return keyword === "null" ? undefined : fail();
  };
  let result = value(0);
  skip();
  return at === text.length ? result : fail();
}
