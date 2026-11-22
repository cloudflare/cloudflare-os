// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMode } from "@gadgets/workshop-shared/api";
import { ComposerModeSelector } from "./ComposerModeSelector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(props: { mode: ChatMode; restricted?: boolean; onModeChange?: (mode: ChatMode) => void }) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(
    <ComposerModeSelector mode={props.mode} restricted={props.restricted ?? false}
      onModeChange={props.onModeChange} />,
  ));
  return container;
}

async function openMenu() {
  const trigger = container!.querySelector<HTMLButtonElement>("button")!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    trigger.click();
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

describe("ComposerModeSelector", () => {
  it("names the mode on its trigger", () => {
    expect(render({ mode: "review", onModeChange: () => {} }).textContent).toBe("Review");
  });

  it("offers each mode with what it does, and changes to the one chosen", async () => {
    const onModeChange = vi.fn<(mode: ChatMode) => void>();
    render({ mode: "auto", onModeChange });
    const items = await openMenu();

    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Applies the agent's changes when its turn ends"),
      expect.stringContaining("Holds the agent's changes until you accept them."),
      expect.stringContaining("Holds every change, including your own in gadgets"),
    ]);
    await act(async () => items[2].click());
    expect(onModeChange).toHaveBeenCalledExactlyOnceWith("fork");
  });

  it("greys out Auto, saying why, where the workspace has read restricted data", async () => {
    const onModeChange = vi.fn<(mode: ChatMode) => void>();
    render({ mode: "review", restricted: true, onModeChange });
    const [auto] = await openMenu();

    expect(auto.textContent).toContain("this workspace has read sensitive data");
    expect(auto.getAttribute("aria-disabled")).toBe("true");
    await act(async () => auto.click());
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("shows the mode read-only to a user who may not change it", () => {
    const shown = render({ mode: "fork" });

    expect(shown.textContent).toBe("Fork");
    expect(shown.querySelector("button")).toBeNull();
  });
});
