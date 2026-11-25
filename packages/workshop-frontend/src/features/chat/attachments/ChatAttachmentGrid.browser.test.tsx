/* eslint-disable react/react-in-jsx-scope */
// A message's attachments and their viewer, in Chromium: the previewers draw with canvas, workers
// and the platform's decompression, none of which jsdom has.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Toasty } from "@cloudflare/kumo";
import {
  buildDocx, buildPptx, buildXlsx, drawnShape, paragraph, run, slideParagraph, transform,
} from "@gadgets/office-content/test-fixtures";
import type { ChatAttachmentRef } from "@gadgets/workshop-shared/api";
import { ThemeProvider } from "../../../ThemeContext";
import { ChatAttachmentGrid } from "./ChatAttachmentGrid";
import "../../../styles.css";

const encoder = new TextEncoder();

/** A one-page PDF whose only content is `text`, with a correct cross-reference table. */
const buildPdf = (text: string, mediaBox = "0 0 612 792"): Uint8Array => {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(pdf);
};

const ref = (name: string, mimeType: string, content?: Uint8Array, size = 2048): ChatAttachmentRef =>
  ({ id: name, name, mimeType, size, ...(content ? { content } : {}) });

/** A 1×1 PNG. */
const PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg=="),
  (character) => character.charCodeAt(0));

let host: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

const mount = async (
  attachments: ChatAttachmentRef[],
  files: Record<string, Uint8Array | Error | Promise<Uint8Array>>,
) => {
  const loadContent = vi.fn<(attachment: ChatAttachmentRef, signal: AbortSignal, limit?: number) => Promise<Uint8Array>>(async (attachment, _, limit) => {
    const file = files[attachment.id];
    if (file instanceof Promise) return file;
    if (file instanceof Uint8Array && limit !== undefined) return file.subarray(0, limit);
    if (!file || file instanceof Error) throw file ?? new Error("missing");
    return file;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <ThemeProvider>
      <Toasty>
        <div className="flex flex-col items-end p-6">
          <ChatAttachmentGrid attachments={attachments} loadContent={loadContent} />
        </div>
      </Toasty>
    </ThemeProvider>,
  ));
  return loadContent;
};

it("draws a PDF's pages with selectable text", async () => {
  await mount([ref("report.pdf", "application/pdf")], { "report.pdf": buildPdf("Quarterly report") });
  await userEvent.click(page.getByRole("button", { name: "Preview report.pdf" }));

  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect.element(page.getByRole("group", { name: "Page 1" })).toBeVisible();
  await expect.element(page.getByText("Quarterly report")).toBeInTheDocument();
  const canvas = document.querySelector<HTMLCanvasElement>("[role=group] canvas")!;
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
  // The page is white paper with dark text on it: drawn, not a blank canvas.
  expect(pixels.some((value, index) => index % 4 === 0 && value < 128)).toBe(true);
});

it("draws a page of an absurd shape within what a browser's canvas can hold", async () => {
  // One unit wide and a hundred thousand tall: drawn to scale it would be ninety million pixels high.
  await mount([ref("tall.pdf", "application/pdf")], { "tall.pdf": buildPdf("x", "0 0 1 100000") });
  await userEvent.click(page.getByRole("button", { name: "Preview tall.pdf" }));

  const sheet = page.getByRole("group", { name: "Page 1" });
  await expect.poll(() => sheet.element().querySelector("canvas")?.height ?? 0).toBeGreaterThan(0);
  const canvas = sheet.element().querySelector("canvas")!;
  expect(canvas.height).toBeLessThanOrEqual(8192);
  expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_000_000);
  expect(sheet.element().getBoundingClientRect().height).toBeLessThanOrEqual(900 * 40);
});

it("shows a glimpse of a file's content on its card", async () => {
  await mount(
    [
      ref("report.pdf", "application/pdf"),
      ref("people.csv", "text/csv"),
      ref("plan.docx", "application/octet-stream"),
      ref("deck.pptx", "application/octet-stream"),
      ref("budget.xlsx", "application/octet-stream"),
    ],
    {
      "report.pdf": buildPdf("Quarterly report"),
      "people.csv": encoder.encode("name,team\nJane,Platform\n"),
      "plan.docx": await buildDocx({ body: paragraph(run("Launch plan")) }),
      // A shape needs a position to be drawn on its slide.
      "deck.pptx": await buildPptx([{
        shapes: drawnShape({ properties: transform(0, 0, 3_000_000, 1_000_000), body: slideParagraph("Kickoff") }),
      }]),
      "budget.xlsx": await buildXlsx({
        sheets: [{ name: "Revenue", rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>North</t></is></c><c r="B1"><v>1200</v></c></row>' }],
      }),
    },
  );
  // Thumbnails are decoration to assistive tech, so they are read from the DOM, not by role.
  const card = (name: string) => page.getByRole("button", { name: `Preview ${name}` }).element().parentElement!;
  await expect.poll(() => card("people.csv").textContent).toContain("Jane,Platform");
  await expect.poll(() => card("plan.docx").textContent).toContain("Launch plan");
  await expect.poll(() => card("deck.pptx").textContent).toContain("Kickoff");
  await expect.poll(() => card("budget.xlsx").textContent).toContain("North");
  // The PDF's first page, drawn to a picture.
  await expect.poll(() => card("report.pdf").querySelector("img")?.naturalWidth).toBeGreaterThan(0);
});

it("shimmers a card while its thumbnail is made, and shows the file's name if none can be", async () => {
  const { promise, reject } = Promise.withResolvers<Uint8Array>();
  const loadContent = await mount([ref("plan.docx", "application/octet-stream")], { "plan.docx": promise });
  const card = () => page.getByRole("button", { name: "Preview plan.docx" }).element().parentElement!;
  await expect.poll(() => loadContent.mock.calls.length).toBe(1);
  expect(card().textContent).not.toContain("plan.docx");
  await act(async () => reject(new Error("offline")));
  await expect.poll(() => card().textContent).toContain("plan.docx");
});

it("steps through a message's attachments with the arrow keys and closes on Escape", async () => {
  const docx = await buildDocx({
    body: paragraph(run("Launch plan"), '<w:pStyle w:val="Heading1"/>') + paragraph(run("Ship it.")),
    styles: '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>',
  });
  const xlsx = await buildXlsx({
    sheets: [
      { name: "Revenue", rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>North</t></is></c><c r="B1"><v>1200</v></c></row>' },
      { name: "Costs", rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>Rent</t></is></c></row>' },
    ],
  });
  await mount(
    [
      ref("people.csv", "text/csv"),
      ref("plan.docx", "application/octet-stream"),
      ref("budget.xlsx", "application/octet-stream"),
    ],
    { "people.csv": encoder.encode('name,team\n"Doe, Jane",Platform\n'), "plan.docx": docx, "budget.xlsx": xlsx },
  );
  const card = page.getByRole("button", { name: "Preview people.csv" });
  await userEvent.click(card);
  await expect.element(page.getByRole("cell", { name: "Doe, Jane" })).toBeVisible();
  await expect.element(page.getByText("1 of 3")).toBeVisible();

  // Alt+Right is the browser's forward, not the next attachment.
  await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
  await expect.element(page.getByText("1 of 3")).toBeVisible();

  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("heading", { name: "Launch plan" })).toBeVisible();

  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("cell", { name: "1200" })).toBeVisible();
  await userEvent.click(page.getByRole("tab", { name: "Costs" }));
  await expect.element(page.getByRole("cell", { name: "Rent" })).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(card).toHaveFocus();
});

it("shows an SVG from a data URL, which has no origin to run its script as if opened on its own", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
  await mount([ref("logo.svg", "image/svg+xml")], { "logo.svg": encoder.encode(svg) });
  // Its card's thumbnail too.
  await expect.poll(() => host!.querySelector("img")?.getAttribute("src") ?? "").toMatch(/^data:image\/svg\+xml;base64,/);
  await userEvent.click(page.getByRole("button", { name: "Preview logo.svg" }));
  const image = page.getByRole("dialog").getByRole("img", { name: "logo.svg" });
  await expect.poll(() => image.element().getAttribute("src") ?? "").toMatch(/^data:image\/svg\+xml;base64,/);
});

it("keeps focus in the viewer when its next button reaches the last attachment", async () => {
  await mount(
    [ref("a.txt", "text/plain"), ref("b.txt", "text/plain")],
    { "a.txt": encoder.encode("first"), "b.txt": encoder.encode("second") },
  );
  await userEvent.click(page.getByRole("button", { name: "Preview a.txt" }));
  await userEvent.click(page.getByRole("button", { name: "Next attachment" }));
  await expect.element(page.getByText("second")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Previous attachment" })).toHaveFocus();
});

it("offers a download, without fetching the file, when its type has no preview", async () => {
  const loadContent = await mount([ref("bundle.zip", "application/zip")], {});
  await userEvent.click(page.getByRole("button", { name: "Preview bundle.zip" }));

  await expect.element(page.getByText("There’s no preview for this kind of file.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Download" }).first()).toBeVisible();
  expect(loadContent).not.toHaveBeenCalled();
});

it("shows an untyped file as text when that is what it holds", async () => {
  await mount(
    [ref("Dockerfile", "application/octet-stream")],
    { Dockerfile: encoder.encode("FROM node:22\nRUN npm ci\n") },
  );
  await userEvent.click(page.getByRole("button", { name: "Preview Dockerfile" }));
  await expect.element(page.getByText("FROM node:22")).toBeVisible();
});

it("says so when a file cannot be loaded or read, and retries on reopening", async () => {
  const files: Record<string, Uint8Array | Error> = { "notes.md": new Error("offline") };
  const loadContent = await mount(
    [ref("notes.md", "text/markdown"), ref("broken.docx", "application/octet-stream")],
    Object.assign(files, { "broken.docx": encoder.encode("not a package") }),
  );
  await userEvent.click(page.getByRole("button", { name: "Preview notes.md" }));
  await expect.element(page.getByText("This file couldn’t be previewed.")).toBeVisible();

  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByText("This file couldn’t be previewed.")).toBeVisible();
  await expect.element(page.getByText("2 of 2")).toBeVisible();

  files["notes.md"] = encoder.encode("# Recovered\n");
  await userEvent.keyboard("{Escape}");
  await userEvent.click(page.getByRole("button", { name: "Preview notes.md" }));
  await expect.element(page.getByRole("heading", { name: "Recovered" })).toBeVisible();
  // Each card's thumbnail, each opening, and the retry: a card keeps no bytes once its thumbnail
  // is made, so the viewer reads the second file again.
  expect(loadContent).toHaveBeenCalledTimes(5);
});

// A message carries only small images' bytes; the card of a larger one fetches it to draw.
it("fetches the image of a card whose message doesn't carry it", async () => {
  const loadContent = await mount([ref("photo.png", "image/png", undefined, 6 * 1024 * 1024)],
    { "photo.png": PNG });
  await expect.poll(() => host!.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);
  expect(loadContent).toHaveBeenCalledOnce();
});

it("offers a file over 25 MB for download instead of fetching it to preview", async () => {
  const loadContent = await mount([ref("forecast.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", undefined, 80 * 1024 * 1024)], {});
  await userEvent.click(page.getByRole("button", { name: "Preview forecast.xlsx" }));
  await expect.element(page.getByText("This file is too large to preview.")).toBeVisible();
  expect(loadContent).not.toHaveBeenCalled();
});

// A card shows a few lines of a text file, so it reads no more of it than that.
it("reads only the start of a text file for its card, and all of a PDF", async () => {
  const loadContent = await mount(
    [ref("rows.csv", "text/csv", undefined, 20 * 1024 * 1024), ref("report.pdf", "application/pdf")],
    { "rows.csv": encoder.encode("name,team\n".repeat(1000)), "report.pdf": buildPdf("Quarterly report") },
  );
  await expect.poll(() => loadContent.mock.calls.length).toBe(2);
  const limits = Object.fromEntries(loadContent.mock.calls.map(([attachment, , limit]) => [attachment.id, limit]));
  expect(limits).toEqual({ "rows.csv": 4096, "report.pdf": undefined });
});

it("lets a download finish when the chat is left, and saves it once on coming back", async () => {
  let resolve!: (bytes: Uint8Array) => void;
  const workbook = [ref("forecast.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    undefined, 80 * 1024 * 1024)];
  const loadContent = await mount(workbook,
    { "forecast.xlsx": new Promise<Uint8Array>((settle) => { resolve = settle; }) });
  const saves = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  try {
    await userEvent.click(page.getByRole("button", { name: "Preview forecast.xlsx" }));
    await userEvent.click(page.getByRole("button", { name: "Download" }).last());
    await act(async () => root!.unmount());
    host!.remove();
    expect(loadContent.mock.calls[0][1].aborted).toBe(false);

    // Back in the chat, its grid made anew, the download is still under way.
    const again = await mount(workbook, { "forecast.xlsx": new Promise<Uint8Array>(() => {}) });
    await userEvent.click(page.getByRole("button", { name: "Preview forecast.xlsx" }));
    const header = page.getByRole("button", { name: "Download" }).first();
    await expect.element(header).toHaveAttribute("aria-busy", "true");
    await userEvent.click(header, { force: true });
    expect(again).not.toHaveBeenCalled();

    resolve(encoder.encode("workbook"));
    await expect.poll(() => saves.mock.calls.length).toBe(1);
    await expect.element(header).toHaveAttribute("aria-busy", "false");
  } finally {
    saves.mockRestore();
  }
});

// Only the download outlives the chat: a preview opened after coming back still stops on leaving.
it("lets only a download's read finish when the chat is left", async () => {
  let resolve!: (bytes: Uint8Array) => void;
  // Over 25 MB, so only the viewer reads it, and an image, so the viewer does.
  const photo = [ref("photo.png", "image/png", undefined, 40 * 1024 * 1024)];
  const first = await mount(photo, { "photo.png": new Promise<Uint8Array>((settle) => { resolve = settle; }) });
  const saves = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  try {
    await userEvent.click(page.getByRole("button", { name: "Preview photo.png" }));
    await userEvent.click(page.getByRole("button", { name: "Download" }));
    await act(async () => root!.unmount());
    host!.remove();
    // The download shares the viewer's read, which goes on.
    expect(first).toHaveBeenCalledOnce();
    expect(first.mock.calls[0][1].aborted).toBe(false);

    const again = await mount(photo, { "photo.png": new Promise<Uint8Array>(() => {}) });
    await userEvent.click(page.getByRole("button", { name: "Preview photo.png" }));
    await expect.poll(() => again.mock.calls.length).toBe(1);
    await act(async () => root!.unmount());
    root = undefined;
    expect(again.mock.calls[0][1].aborted).toBe(true);
    expect(first.mock.calls[0][1].aborted).toBe(false);

    resolve(PNG);
    await expect.poll(() => saves.mock.calls.length).toBe(1);
  } finally {
    saves.mockRestore();
  }
});

it("aborts its fetches when it goes", async () => {
  const loadContent = await mount([ref("notes.txt", "text/plain")], { "notes.txt": new Promise(() => {}) });
  await expect.poll(() => loadContent.mock.calls.length).toBe(1);
  const [, signal] = loadContent.mock.calls[0];
  expect(signal.aborted).toBe(false);
  await act(async () => root!.unmount());
  root = undefined;
  expect(signal.aborted).toBe(true);
});

it("stops reading a file the viewer moves on from or closes on", async () => {
  // Over 25 MB, so no card reads them for a thumbnail: only the viewer does, while it shows them.
  const size = 40 * 1024 * 1024;
  const loadContent = await mount(
    [ref("a.png", "image/png", undefined, size), ref("b.png", "image/png", undefined, size)],
    { "a.png": new Promise(() => {}), "b.png": new Promise(() => {}) },
  );
  await userEvent.click(page.getByRole("button", { name: "Preview a.png" }));
  await expect.poll(() => loadContent.mock.calls.length).toBe(1);
  const [, first] = loadContent.mock.calls[0];

  await userEvent.keyboard("{ArrowRight}");
  await expect.poll(() => loadContent.mock.calls.length).toBe(2);
  await expect.poll(() => first.aborted).toBe(true);
  const [, second] = loadContent.mock.calls[1];
  expect(second.aborted).toBe(false);

  await userEvent.keyboard("{Escape}");
  await expect.poll(() => second.aborted).toBe(true);
});

it("saves a file once however often Download is pressed while it loads, even after reopening", async () => {
  let resolve!: (bytes: Uint8Array) => void;
  const loadContent = await mount(
    [ref("forecast.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      undefined, 80 * 1024 * 1024)],
    { "forecast.xlsx": new Promise<Uint8Array>((settle) => { resolve = settle; }) },
  );
  const saves = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  try {
    await userEvent.click(page.getByRole("button", { name: "Preview forecast.xlsx" }));
    const header = page.getByRole("button", { name: "Download" }).first();
    const body = page.getByRole("button", { name: "Download" }).last();
    await userEvent.click(body);
    // Both say it is under way, and pressing either again saves nothing more.
    await expect.element(header).toHaveAttribute("aria-busy", "true");
    await expect.element(body).toHaveAttribute("aria-busy", "true");
    await userEvent.click(header, { force: true });
    await userEvent.click(body, { force: true });

    // Closing the viewer leaves the download to finish, and reopened, it still shows it.
    await userEvent.keyboard("{Escape}");
    expect(loadContent.mock.calls[0][1].aborted).toBe(false);
    await userEvent.click(page.getByRole("button", { name: "Preview forecast.xlsx" }));
    await expect.element(header).toHaveAttribute("aria-busy", "true");
    await userEvent.click(body, { force: true });
    expect(loadContent).toHaveBeenCalledOnce();

    resolve(encoder.encode("workbook"));
    await expect.poll(() => saves.mock.calls.length).toBe(1);
    await expect.element(header).toHaveAttribute("aria-busy", "false");
    // Saved, so pressing Download again downloads it again.
    await userEvent.click(header);
    await expect.poll(() => saves.mock.calls.length).toBe(2);
  } finally {
    saves.mockRestore();
  }
});
