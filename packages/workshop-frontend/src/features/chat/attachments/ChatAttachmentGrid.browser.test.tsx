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

const ref = (name: string, mimeType: string, content?: Uint8Array): ChatAttachmentRef =>
  ({ id: name, name, mimeType, size: 2048, ...(content ? { content } : {}) });

let host: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

const mount = async (
  attachments: ChatAttachmentRef[],
  files: Record<string, Uint8Array | Error>,
) => {
  const loadContent = vi.fn<(attachment: ChatAttachmentRef) => Promise<Uint8Array>>(async (attachment) => {
    const file = files[attachment.id];
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
  await expect.element(page.getByRole("img", { name: "Page 1" })).toBeVisible();
  await expect.element(page.getByText("Quarterly report")).toBeInTheDocument();
  const canvas = document.querySelector<HTMLCanvasElement>("[role=img] canvas")!;
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
  // The page is white paper with dark text on it: drawn, not a blank canvas.
  expect(pixels.some((value, index) => index % 4 === 0 && value < 128)).toBe(true);
});

it("draws a page of an absurd shape within what a browser's canvas can hold", async () => {
  // One unit wide and a hundred thousand tall: drawn to scale it would be ninety million pixels high.
  await mount([ref("tall.pdf", "application/pdf")], { "tall.pdf": buildPdf("x", "0 0 1 100000") });
  await userEvent.click(page.getByRole("button", { name: "Preview tall.pdf" }));

  const sheet = page.getByRole("img", { name: "Page 1" });
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
  // Each card's thumbnail, the first opening, and the retry; the second file's is shared.
  expect(loadContent).toHaveBeenCalledTimes(4);
});
