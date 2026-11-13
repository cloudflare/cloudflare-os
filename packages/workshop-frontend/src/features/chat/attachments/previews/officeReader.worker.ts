// Runs the Office readers off the page's thread. A crafted file can still cost a reader time, and
// here that time stalls only this worker, which the page can stop (officeReader.ts).

import { OFFICE_READS, type OfficeReadRequest, type OfficeReadResponse } from "./officeReads";

const run = (request: OfficeReadRequest): Promise<unknown> => {
  switch (request.read) {
    case "document":
      return OFFICE_READS.document(request.bytes, request.options as Parameters<typeof OFFICE_READS.document>[1]);
    case "slides":
      return OFFICE_READS.slides(request.bytes, request.options as Parameters<typeof OFFICE_READS.slides>[1]);
    case "workbook":
      return OFFICE_READS.workbook(request.bytes, request.options as Parameters<typeof OFFICE_READS.workbook>[1]);
  }
};

self.addEventListener("message", (event: MessageEvent<OfficeReadRequest>) => {
  const { id } = event.data;
  // A worker's postMessage goes to the page that started it, and takes no target origin.
  // eslint-disable-next-line unicorn/require-post-message-target-origin
  const answer = (response: OfficeReadResponse) => self.postMessage(response);
  run(event.data).then(
    (result) => answer({ id, result }),
    (error: unknown) => answer({ id, error: error instanceof Error ? error.message : String(error) }),
  );
});
