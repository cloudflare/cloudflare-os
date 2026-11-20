// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_FILE_QUOTA_BYTES,
  WORKSPACE_STORAGE_WARNING_BYTES,
  WORKSPACE_TURN_QUOTA_BYTES,
} from "@gadgets/workshop-shared/api";
import { WorkspaceStorageBanner } from "./WorkspaceStorageBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

const bannerText = (storageBytes: number): string => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(<WorkspaceStorageBanner storageBytes={storageBytes} />));
  return container.textContent ?? "";
};

describe("WorkspaceStorageBanner", () => {
  it.each([
    [WORKSPACE_STORAGE_WARNING_BYTES, "is filling up", "New files over 1 MB are stored only while the workspace stays within 8 GB."],
    [WORKSPACE_FILE_QUOTA_BYTES, "is nearly full", "New files over 1 MB, such as attachments, can't be stored."],
    [WORKSPACE_TURN_QUOTA_BYTES, "is full", "Agents can't run here"],
  ])("says what stops working at %d bytes", (storageBytes, state, consequence) => {
    const text = bannerText(storageBytes);
    expect(text).toContain(`This workspace's storage ${state}`);
    expect(text).toContain(`${(storageBytes / 1e9).toFixed(1)} of 10 GB used.`);
    expect(text).toContain(consequence);
  });
});
