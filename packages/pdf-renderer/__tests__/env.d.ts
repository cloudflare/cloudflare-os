/// <reference types="@cloudflare/vitest-plugin/types" />

import type { PdfRenderer } from "../src/worker";

declare global {
  namespace Cloudflare {
    interface Env {
      /** The pool's own Worker, bound as a caller binds the renderer. */
      PDF_RENDERER: Service<typeof PdfRenderer>;
    }
  }
}
