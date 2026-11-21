import { describe, expect, it } from "vitest";
import { RENDER_LIMITS } from "../../src/api";
import { instantiatePdfium, type PdfiumInstance } from "../../src/pdfium-loader";
import { pdfiumModules } from "../../src/pdfium-module";
import { pdfRenderer } from "../../src/renderer";
import {
  faxPdf, jbig2Pdf, jpxPdf, PATTERN_HEIGHT, PATTERN_MARKS, PATTERN_SHADED, PATTERN_WIDTH, unembeddedFontPdf,
} from "../pdf-render-fixture";

// The unit tests hold the renderer to its limits in Node, over modules compiled from the files'
// bytes. This shows the same code over the modules as the Worker imports them, in workerd, which
// compiles none from bytes and has no file system to fall back on.
describe("the PDF renderer in the pool", () => {
  it("renders fax, JBIG2 and JPEG 2000 to the pattern, every pixel, and asks nothing of a file system for them", async () => {
    let instances: PdfiumInstance[] = [];
    let renderer = pdfRenderer(await pdfiumModules(), { ...RENDER_LIMITS, dpi: 72 }, (module, maxBytes) => {
      let instance = instantiatePdfium(module, maxBytes);
      instances.push(instance);
      return instance;
    });
    let stored: [string, Uint8Array, Uint8Array][] = [
      ["fax", faxPdf(), PATTERN_MARKS], ["JBIG2", jbig2Pdf(), PATTERN_MARKS], ["JPEG 2000", jpxPdf(), PATTERN_SHADED],
    ];
    for (let [encoding, pdf, pattern] of stored) {
      let hold = renderer.hold(pdf.byteLength);
      let file = hold.file;
      hold.fill(pdf, 0);
      expect(hold.countPages(), encoding).toBe(1);
      let page = hold.renderPage(0, { bands: 1 });
      expect([page.width, page.height, page.blank], encoding).toEqual([PATTERN_WIDTH, PATTERN_HEIGHT, false]);
      expect(page.bands, encoding).toHaveLength(1);
      hold.release();
      // The pool's runtime gives a buffer back when it is made smaller, as the Worker's does,
      // and the page's pixels are a copy that outlasts it.
      expect(file.byteLength, encoding).toBe(0);
      expect([...page.bands[0]!.pixels!], encoding).toEqual([...pattern]);
    }
    expect(instances).toHaveLength(1);
    expect(instances[0]!.host).toMatchObject({ fileCalls: 0, refusedGrowths: 0, aborted: false });
    // The control for that count: for a font the file names and does not embed, the build asks
    // for a file system, is refused, and draws the page with a font of its own.
    let pdf = unembeddedFontPdf();
    let hold = renderer.hold(pdf.byteLength);
    hold.fill(pdf, 0);
    expect(hold.renderPage(0, { bands: 1 })).toMatchObject({ blank: false, images: 0 });
    hold.release();
    expect(instances[0]!.host.fileCalls).toBeGreaterThan(0);
    expect(instances[0]!.host).toMatchObject({ refusedGrowths: 0, aborted: false });
  });
});
