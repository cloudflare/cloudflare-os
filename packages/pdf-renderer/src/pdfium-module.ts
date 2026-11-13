// The PDFium build and what goes with it, as modules. workerd compiles WebAssembly only from a
// module import, never from bytes at run time, so these imports are the one way the renderer
// gets its code; each is a relative import of a file in this package, which is what the build
// copies. They are asked for when the first PDF is opened, so no instance is made until one is.
// The build itself is compiled when the isolate starts, as every WebAssembly module of a Worker
// is.

/** The compiled modules the renderer runs. */
export type PdfiumModules = {
  /** PDFium itself, with its work counter: `vendor/pdfium/pdfium-metered.wasm`. */
  pdfium: WebAssembly.Module;
  /**
   * Two functions PDFium calls back through, `r` to read the file and `p` to ask whether to
   * pause: 50 bytes that import each from JavaScript and export it again, which is how a
   * JavaScript function becomes an entry of PDFium's function table without compiling anything.
   */
  thunks: WebAssembly.Module;
};

/** Imports both modules. */
export async function pdfiumModules(): Promise<PdfiumModules> {
  return {
    pdfium: (await import("../vendor/pdfium/pdfium-metered.wasm")).default,
    thunks: (await import("./pdfium-thunks.wasm")).default,
  };
}
