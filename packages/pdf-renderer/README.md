# PDF renderer

A Worker that draws the pages of a PDF with [PDFium](https://pdfium.googlesource.com/pdfium/),
compiled to WebAssembly, and gives each back as rows of 8-bit grey, cut into bands. Other Workers
reach it through a service binding to its `PdfRenderer` entrypoint. It is not a gatekeeper: it
has no route, no storage and no bindings of its own, and anything but a call of its entrypoint is
answered with a 404. A Worker that binds it is deployed after it: an upload whose service binding
names a Worker that does not exist is refused, so a deploy by hand begins with
`pnpm --filter @gadgets/pdf-renderer run deploy`.

It is a Worker of its own so that PDFium's memory, and the PDFs it is given, are in an isolate
that holds nothing else: a file that makes PDFium use all the memory it may costs no other
Worker any of theirs.

## What a caller does

The types, and the limits as numbers, are in [`src/api.ts`](src/api.ts), which imports nothing:
a caller takes them from `@gadgets/pdf-renderer/api` without taking the renderer.

```ts
let opened = await env.PDF_RENDERER.open(stream, size);
if ("refused" in opened) return opened.refused;       // a word: "room", "encrypted", ...
let page = await opened.document.renderPage(0, { bands: 4 });
if (!("refused" in page)) for (let band of page.bands) use(band.pixels);
opened.document[Symbol.dispose]();
```

- `open` reads the stream to its end into this isolate's memory and opens the PDF once, to count
  its pages. The file does not go back to the caller: what it holds is a stub to the document.
- `renderPage` draws one page as a reader shows it, its annotations with it (a stamp, writing in
  ink, a form field's value), upright, at 150 pixels an inch or fewer, and cuts it at its least
  inked rows near where even cuts would fall. A band with nothing on it comes without pixels. A
  cut that would part the columns of a page set in columns is not made, so such a page has fewer
  bands than were asked for. With `denseLines`, a band that holds more lines of writing than
  that is cut once more.
- Whatever a PDF, or one page of it, is not rendered for is answered as a value,
  `{ refused, ofPage, heapBytes, work }`, since an error's fields do not cross a binding. A
  refusal that is `ofPage` leaves the other pages to be rendered; any other is of the whole PDF,
  as every refusal of `open` is, whatever its word. Only a failure of the caller's own stream is
  thrown, and a page index or a number of bands that is out of range, as a `RangeError`.
- Disposing the document gives back everything held for it. So does the caller going away. A
  document that goes two minutes without a call can lose its room to another PDF that needs it:
  its next call is answered `released`, and the caller opens the PDF again.

## Limits

Every limit is a size or a count, none a time: a call into WebAssembly cannot be interrupted, so
the build counts its own work and ends a call that has done too much (see the vendored build's
[README](vendor/pdfium/README.md)). They are `RENDER_LIMITS` in `src/api.ts`.

| Limit | Value |
|---|---|
| PDFium's memory | 64 MiB |
| A PDF | 16 MiB, 2,000 pages |
| The PDFs open at once | 24 MiB between them, each charged its file, one page's pixels and 16,000 bytes |
| A page | 3,000,000 pixels, 4,000 a side, drawn in strips of at most 1 MiB |
| A page's images | 40,000,000 pixels each as declared, 80,000,000 together |
| Bands | 1 to 8 as asked, and no more than one for every 400 rows the page has |
| Work | 400,000,000 for a call; 20,000,000,000 for a PDF's calls that leave nothing to read |

A page that runs out of memory while it is painted is tried once more at half the resolution, and
says so (`reduced`).

One PDFium instance serves every PDF in the isolate, one call at a time. Each call opens the
document, does its one thing, and puts the instance's memory back to what it was before any
document, so nothing of one PDF is there for the next call to find.

## Logs

Component `pdf-renderer`, events `pdf-renderer.opened`, `pdf-renderer.refused`,
`pdf-renderer.page_rendered` and `pdf-renderer.released`. They carry sizes, counts and reason
words, and nothing of a document.

## The vendored build

`vendor/pdfium/pdfium-metered.wasm` is a release of
[pdfium-binaries](https://github.com/bblanchon/pdfium-binaries) with a work counter added by
`scripts/meter-pdfium.ts`. [`vendor/pdfium/README.md`](vendor/pdfium/README.md) says which
release, how its provenance is verified, what the counter is, which licences the build is under,
and, under "Updating", when and how to take a later release. The licence notices ship in the
Worker's bundle: `src/worker.ts` imports `vendor/pdfium/NOTICES.txt` for that alone.

## Tests

`pnpm --filter @gadgets/pdf-renderer test:run` runs two suites. The Node suite
(`vitest.config.ts`) holds the renderer to its limits over modules compiled from the vendored
files' bytes, and the vendored files to their hashes. The workerd suite
(`vitest.worker.config.ts`) imports the build as the Worker does and calls the entrypoint over a
service binding. Every PDF in them is generated by `__tests__/pdf-render-fixture.ts`.
