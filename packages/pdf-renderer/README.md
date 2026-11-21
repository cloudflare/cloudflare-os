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
- Every call on one document is part of the invocation that opened it, and counts against the
  CPU time an invocation may use: five minutes, which is what this Worker's config asks for
  (`limits.cpuMs`) and the most a Worker may have, where the default is 30 seconds. What uses
  it up is the drawing, not the number of pages: measured, the heaviest page that is still
  drawn within the limits below takes 3 to 5 seconds, so about a hundred such pages use it up,
  where ten used up the default; a fax page at 300 dpi takes 0.16 to 0.3 seconds, so a scan of
  557 such pages (32 MiB) used 88 to 135 seconds, and the default ran out every 130 to 155
  pages of it; a 26-page JPEG 2000 scan uses 12 seconds. The call
  that runs out fails in the caller with the runtime's own error, and nothing in this Worker
  runs to clear up after it. So the next thing asked of the renderer, by anyone, first puts the
  instance back and lets that document's room go (`cut-off` in the log): a caller that opens
  the PDF again finds room for it and goes on from the page it was at.

## Limits

Every limit is a size or a count, none a time: a call into WebAssembly cannot be interrupted, so
the build counts its own work and ends a call that has done too much (see the vendored build's
[README](vendor/pdfium/README.md)). They are `RENDER_LIMITS` in `src/api.ts`.

| Limit | Value |
|---|---|
| PDFium's memory | 64 MiB |
| A PDF | 32 MiB, 2,000 pages |
| The PDFs open at once | 40 MiB between them, each charged its file, one page's pixels and 16,000 bytes |
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

## Metrics

A deployment that records subservice calls (see the
[observability README](../observability/README.md#subservice-calls)) gets one point from this
Worker for each document that was opened, written where `pdf-renderer.released` is logged: event
type `release`, source and service `pdf-renderer`, operation `document`, and as its reason the
word that log line carries. A PDF that was refused at `open` held nothing and writes none.

| Reason | Outcome | The document's room was given back |
|---|---|---|
| `disposed` | `success` | by its caller, disposing it or going away |
| `idle` | `refused` | to another PDF that needed it, after two minutes without a call |
| `cut-off` | `error` | by the renderer, on finding that a call for it was cut off |

The point is written only when this Worker has the `METRICS` binding and `SUBSERVICE_METRICS` set
to `true`. Neither is in its config: a deployment adds both. The opens and page renders
themselves are counted by the caller, which for the Google gatekeeper is described in
[its README](../gatekeeper-google/README.md).

A call that runs out of the invocation's CPU time is cut off, so `cut-off` counts the documents
lost that way, less some: nothing runs when a call is cut off, so the point is written when the
isolate is next asked for anything, with that moment as its time, and never when the isolate
goes away first. Measured against a renderer held to 150 ms of CPU, seven of nine such documents
were counted. The caller sees the call throw every time, and counts it as a `render-page` that
failed with the reason `call`, and the PDF it then downloads and opens again as a `reopen` with
the cause `call`, as it does when the isolate went away. The Worker has all the CPU time there
is to give, so those counts say how often a PDF still outruns it, each time at the cost of
downloading the file again.

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
