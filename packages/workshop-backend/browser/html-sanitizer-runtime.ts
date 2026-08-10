import createDOMPurify from "dompurify";

// This code runs in the isolated realm prior to HTML export. It provides an
// HTML sanitizer API to functions called by page.evaluate(). Ideally these
// functions could use the [HTML Sanitizer
// API](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Sanitizer_API) and
// we wouldn't need this file or dompurify as a dependency at all, but Browser
// Run uses an older version of Chromium that doesn't support the HTML Sanitizer
// API. When Browser Run eventually updates Chromium to a supported version, we
// can get rid of this file and dompurify.

declare global {
  /** Sanitizes a complete HTML document inside Puppeteer's isolated realm. */
  var __workshopExportSanitizeHtml: (html: string) => HTMLHtmlElement;
}

const purifier = createDOMPurify(window);
globalThis.__workshopExportSanitizeHtml = html => purifier.sanitize(html, {
  WHOLE_DOCUMENT: true,
  RETURN_DOM: true,
}) as HTMLHtmlElement;
