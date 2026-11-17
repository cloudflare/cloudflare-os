// Project-specific Env augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    // The AI Gateway Drive PDF conversion goes through, when set. It is not in the config, because
    // previews upload a backend secret under this name.
    CF_AI_GATEWAY?: string;
    // `false` to have readPdf() call no vision model on the pages of a PDF that have no text. Not
    // in the config: unset, which is the default, they are read.
    PDF_OCR?: string | boolean;
    // How many calls to the vision model readPdf() may have in flight for one text: a whole
    // number of at least 1. Not in the config: unset, which is the default, the number in the
    // code (`READ_AHEAD.calls`).
    PDF_OCR_CALLS?: string | number;
  }
}
