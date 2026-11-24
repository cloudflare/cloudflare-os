/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { WORKSPACE_FILE_QUOTA_BYTES } from "@gadgets/workshop-shared/api";
import { WorkspaceStorageBanner } from "./WorkspaceStorageBanner";
import { WorkspaceStorageIndicator } from "./WorkspaceStorageIndicator";
import "../../styles.css";

let host: HTMLDivElement | undefined, root: Root | undefined;
let previousViewport: { width: number, height: number } | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  if (previousViewport) {
    await page.viewport(previousViewport.width, previousViewport.height);
    previousViewport = undefined;
  }
});

// Both, as the workspace places them: the indicator in the top bar, the banner below it.
const render = async (width: number, height: number) => {
  previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, height);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(
    <>
      <div data-testid="top-bar"><WorkspaceStorageIndicator storageBytes={WORKSPACE_FILE_QUOTA_BYTES} /></div>
      <div data-testid="body"><WorkspaceStorageBanner storageBytes={WORKSPACE_FILE_QUOTA_BYTES} /></div>
    </>,
  ));
};

it("moves into the top bar on a phone with its keyboard open, with its details a tap away", async () => {
  // At this height the composer and the bars above it fill the workspace, in a pane that clips
  // its overflow: a banner of any height pushed Send off screen.
  await render(375, 320);
  await expect.element(page.getByTestId("body")).toBeEmptyDOMElement();

  const warning = page.getByRole("button", { name: "This workspace's storage is nearly full" });
  await act(async () => { await userEvent.click(warning); });
  await expect.element(page.getByRole("dialog")).toMatchTextContent(
    "New files over 1 MB, such as attachments, can't be stored.");
});

it("says it all below the top bar where there is room", async () => {
  await render(375, 700);
  await expect.element(page.getByTestId("top-bar")).toBeEmptyDOMElement();
  const banner = page.getByTestId("body");
  await expect.element(banner).toMatchTextContent("This workspace's storage is nearly full");
  await expect.element(banner).toMatchTextContent("New files over 1 MB, such as attachments, can't be stored.");
});

// Opening it on a phone can close the keyboard, which makes the window tall again.
it("stays open while the window grows, then gives way to the banner", async () => {
  await render(375, 320);
  await act(async () => {
    await userEvent.click(page.getByRole("button", { name: "This workspace's storage is nearly full" }));
  });
  const dialog = page.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await page.viewport(375, 700);
  await expect.element(dialog).toBeVisible();
  // Closing it returns focus to its button, which stays until focus moves on.
  await act(async () => { await userEvent.keyboard("{Escape}"); });
  const warning = page.getByRole("button", { name: "This workspace's storage is nearly full" });
  await expect.element(warning).toHaveFocus();
  await expect.element(page.getByTestId("body")).toMatchTextContent("This workspace's storage is nearly full");
  await act(async () => { warning.element().blur(); });
  await expect.element(page.getByTestId("top-bar")).toBeEmptyDOMElement();
});
