// The Office readers run in a worker, in Chromium: jsdom has no workers.
import { expect, it } from "vitest";
import { buildDocx, paragraph, run } from "@gadgets/office-content/test-fixtures";
import { readOffice } from "./officeReader";

const docx = (text: string) => buildDocx({ body: paragraph(run(text)) });
const firstText = (document: Awaited<ReturnType<typeof readOffice<"document">>>) => {
  const [block] = document.body;
  const [inline] = block?.kind === "paragraph" ? block.inlines : [];
  return inline?.kind === "text" ? inline.text : undefined;
};

it("reads a file in the worker and answers with its model", async () => {
  expect(firstText(await readOffice("document", await docx("Hello"), {}))).toBe("Hello");
});

it("reports a file the reader rejects", async () => {
  await expect(readOffice("document", new Uint8Array([1, 2, 3]), {})).rejects.toThrow(/./);
});

it("drops a read still waiting its turn when it is aborted", async () => {
  const bytes = await docx("First");
  const abort = new AbortController();
  const first = readOffice("document", bytes, {});
  const second = readOffice("document", bytes, {}, { signal: abort.signal });
  abort.abort();
  await expect(second).rejects.toMatchObject({ name: "AbortError" });
  expect(firstText(await first)).toBe("First");
});

it("reads a file someone opened in a worker of its own, which a stopped card read leaves alone", async () => {
  const [card, opened] = await Promise.all([docx("Card"), docx("Opened")]);
  const abort = new AbortController();
  const cardRead = readOffice("document", card, {}, { signal: abort.signal });
  const viewerRead = readOffice("document", opened, {}, { lane: "viewer" });
  abort.abort();
  await expect(cardRead).rejects.toMatchObject({ name: "AbortError" });
  expect(firstText(await viewerRead)).toBe("Opened");
});

it("stops an opened file's read when another file is opened", async () => {
  // Both built first, so the second opens while the first is still being read.
  const [one, two] = await Promise.all([docx("First"), docx("Second")]);
  const first = readOffice("document", one, {}, { lane: "viewer" });
  const second = readOffice("document", two, {}, { lane: "viewer" });
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  expect(firstText(await second)).toBe("Second");
});

it("stops the worker for a read aborted while running, and reads the next file in a new one", async () => {
  const abort = new AbortController();
  const running = readOffice("document", await docx("Gone"), {}, { signal: abort.signal });
  abort.abort();
  await expect(running).rejects.toMatchObject({ name: "AbortError" });
  expect(firstText(await readOffice("document", await docx("Next"), {}))).toBe("Next");
});
