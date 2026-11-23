/* eslint-disable react/react-in-jsx-scope */
// The composer's cards for files that are not images, in Chromium: their thumbnails wait for the
// card to be on screen, and the viewer they open draws with APIs jsdom lacks.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Toasty } from "@cloudflare/kumo";
import { ThemeProvider } from "../../../../ThemeContext";
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
