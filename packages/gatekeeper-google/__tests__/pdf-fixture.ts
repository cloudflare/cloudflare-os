// Builds small PDFs whose pages are each one image, the way a scanner writes them, for the tests
// of what readPdf() does with a PDF that has no text of its own.

/** One page's image, as it is stored in the file. */
export type PdfImage = {
  /** The image stream's bytes, already encoded as `filter` says. */
  data: Uint8Array;
  width: number;
  height: number;
  /** The `/Filter` value as written, `/DCTDecode` (a JPEG) unless given; `""` for none. */
  filter?: string;
  /** The `/ColorSpace` value as written, `/DeviceRGB` unless given. */
  colorSpace?: string;
  bitsPerComponent?: number;
  /** Further dictionary entries, as written, such as `/ImageMask true`. */
  extra?: string;
  /** Writes `/Length` as a reference to an object that follows the stream. */
  indirectLength?: boolean;
  /** Writes this `/Length` instead of the true one. */
  declaredLength?: number;
};

/** A built PDF, and where each image's stream data sits in it, in page order. */
export type BuiltPdf = { bytes: Uint8Array; images: { offset: number; length: number }[] };

/**
 * The number of page `i`'s first object. Objects 1 and 2 are the catalog and page tree; each page
 * then takes four: the page, its content, its image, and the image's length (used only when that
 * is indirect).
 */
function pageId(i: number): number {
  return 3 + i * 4;
}

/**
 * A PDF of one US Letter page per image, each drawn across its whole page. Page `i`'s image is
 * object `5 + 4i`. `objects` are written after the pages, as given, numbered on from the last
 * page's (`3 + 4 * pages.length` is the first), and `trailer` adds entries to the trailer
 * dictionary as written, such as an `/Encrypt` reference.
 */
export function imagePdf(
  pages: PdfImage[], options: { objects?: string[]; trailer?: string } = {},
): BuiltPdf {
  let encoder = new TextEncoder();
  let parts: Uint8Array[] = [];
  let size = 0;
  let push = (part: string | Uint8Array) => {
    let bytes = typeof part === "string" ? encoder.encode(part) : part;
    parts.push(bytes);
    size += bytes.byteLength;
  };
  let offsets: number[] = [];
  let object = (id: number, write: () => void) => {
    offsets[id] = size;
    push(`${id} 0 obj\n`);
    write();
    push("\nendobj\n");
  };
  let images: BuiltPdf["images"] = [];

  push("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
  object(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  object(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${
    pages.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] >>`));
  pages.forEach((image, i) => {
    let id = pageId(i);
    object(id, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${
      id + 1} 0 R /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> >>`));
    let content = "q 612 0 0 792 0 0 cm /Im0 Do Q";
    object(id + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    object(id + 2, () => {
      let filter = image.filter ?? "/DCTDecode";
      let length = image.indirectLength ? `${id + 3} 0 R`
        : String(image.declaredLength ?? image.data.byteLength);
      push(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height
        } /ColorSpace ${image.colorSpace ?? "/DeviceRGB"} /BitsPerComponent ${
        image.bitsPerComponent ?? 8}${filter ? ` /Filter ${filter}` : ""}${
        image.extra ? ` ${image.extra}` : ""} /Length ${length} >>\nstream\n`);
      images.push({ offset: size, length: image.data.byteLength });
      push(image.data);
      push("\nendstream");
    });
    object(id + 3, () => push(String(image.data.byteLength)));
  });

  let objects = options.objects ?? [];
  objects.forEach((body, i) => object(pageId(pages.length) + i, () => push(body)));

  let count = pageId(pages.length) + objects.length;
  let xref = size;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R${options.trailer ? ` ${options.trailer}` : ""
    } >>\nstartxref\n${xref}\n%%EOF\n`);

  let bytes = new Uint8Array(size);
  let at = 0;
  for (let part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return { bytes, images };
}

/**
 * A page image as large as a scanned page's, said to be a JPEG unless `overrides` say otherwise:
 * `700 + seed` bytes of data that are no image's, which tell one page's from another's. What
 * sends a page image as it is stored never decodes it.
 */
export function scanPage(seed: number, overrides: Partial<PdfImage> = {}): PdfImage {
  let data = Uint8Array.from({ length: 700 + seed }, (_, i) => (i * 7 + seed) % 256);
  return { data, width: 1275, height: 1650, ...overrides };
}

/**
 * A page image of black marks on white, 96 x 64 pixels, as Group 4 fax data: a corner mark, three
 * bars, an upright and a diagonal, so that every quarter of the page it is drawn across has
 * marks. It is too small to be taken for a page image, and fax is not read as stored, so a PDF
 * of it is one whose pages have to be rendered.
 */
export function faxMarks(): PdfImage {
  let data = atob(
    "JqH//8c7EPzUB4b//x///Ihe/fb7fb7fNQHhv//Ji7fb7fb7fb7fb7fb7fb5qA8N//5Lbt9vt9vt9vt9vt9vtjbmoDw3/jwAQAQ=");
  return {
    data: Uint8Array.from(data, ch => ch.charCodeAt(0)), width: 96, height: 64,
    filter: "/CCITTFaxDecode", colorSpace: "/DeviceGray", bitsPerComponent: 1,
    extra: "/DecodeParms << /K -1 /Columns 96 /Rows 64 >>",
  };
}
