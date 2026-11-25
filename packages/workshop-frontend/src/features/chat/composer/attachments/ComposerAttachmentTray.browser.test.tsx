/* eslint-disable react/react-in-jsx-scope */
// The composer's cards for files that are not images, in Chromium: their thumbnails wait for the
// card to be on screen, and the viewer they open draws with APIs jsdom lacks.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Toasty } from "@cloudflare/kumo";
import { ThemeProvider } from "../../../../ThemeContext";
import { MAX_PREVIEW_BYTES } from "../../attachments/previewFormat";
import { ComposerAttachmentTray } from "./ComposerAttachmentTray";
import type { ComposerAttachment } from "./useComposerAttachments";
import "../../../../styles.css";

let host: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

const file = (name: string, mimeType: string, text: string, uploadState: ComposerAttachment["uploadState"]) =>
  ({ id: name, name, mimeType, blob: new Blob([text], { type: mimeType }), uploadState }) satisfies ComposerAttachment;

it("shows the start of a dropped text file on its card and opens the whole file", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <ThemeProvider>
      <Toasty>
        <ComposerAttachmentTray
          attachments={[
            file("notes.md", "text/markdown", "# Roadmap\n\nShip previews first.\n", "ready"),
            file("failed.csv", "text/csv", "name,team\nJane,Platform\n", "error"),
          ]}
          onRemove={() => {}}
        />
      </Toasty>
    </ThemeProvider>,
  ));

  // The thumbnail is decoration to assistive tech, so it is read from the DOM, not by role.
  const card = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Preview notes.md" }) });
  await expect.poll(() => card.element().textContent).toContain("# Roadmap");

  await userEvent.click(page.getByRole("button", { name: "Preview notes.md" }));
  await expect.element(page.getByRole("heading", { name: "Roadmap" })).toBeVisible();

  // A file whose upload failed is still on this device, so it still opens.
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("cell", { name: "Platform" })).toBeVisible();
});

it("reads no file too large to preview for its card's thumbnail", async () => {
  // A thumbnail reads and parses the whole file in the page, as the sent message's card would.
  let reads = 0;
  const large = file("forecast.csv", "text/csv", "", "ready");
  const blob = new Blob([new Uint8Array(MAX_PREVIEW_BYTES + 1)], { type: "text/csv" });
  blob.arrayBuffer = () => {
    reads++;
    return Blob.prototype.arrayBuffer.call(blob);
  };
  // A card that read only the start of it would slice it first.
  blob.slice = (...args) => {
    reads++;
    return Blob.prototype.slice.apply(blob, args);
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <ThemeProvider>
      <Toasty>
        <ComposerAttachmentTray
          attachments={[{ ...large, blob }, file("team.csv", "text/csv", "name,team\nJane,Platform\n", "ready")]}
          onRemove={() => {}}
        />
      </Toasty>
    </ThemeProvider>,
  ));

  // Both cards are on screen, so the small one's thumbnail drawing shows the large one's was due.
  const small = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Preview team.csv" }) });
  await expect.poll(() => small.element().textContent).toContain("Platform");
  expect(reads).toBe(0);

  await userEvent.click(page.getByRole("button", { name: "Preview forecast.csv" }));
  await expect.element(page.getByText("This file is too large to preview.")).toBeVisible();
  expect(reads).toBe(0);
});
