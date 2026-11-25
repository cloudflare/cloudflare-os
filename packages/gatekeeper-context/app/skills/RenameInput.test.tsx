// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenameInput } from "./RenameInput";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("RenameInput", () => {
  let container: HTMLDivElement | undefined;
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
  });

  it("edits a humanized title and commits a valid metadata name", () => {
    const onCommit = vi.fn<(value: string) => void>();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(
      <RenameInput
        initialValue="incident-response"
        format="skill"
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    ));

    const input = container.querySelector("input")!;
    expect(input.value).toBe("Incident Response");

    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "Security / Audit!");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("Security Audit ");

    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(onCommit).toHaveBeenCalledWith("security-audit");
  });

  const keyDown = (input: HTMLInputElement, key: string, composing?: "isComposing" | "keyCode") => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      isComposing: composing === "isComposing",
    });
    if (composing === "keyCode") Object.defineProperty(event, "keyCode", { value: 229 });
    act(() => input.dispatchEvent(event));
  };

  const renderRename = () => {
    const onCommit = vi.fn<(value: string) => void>();
    const onCancel = vi.fn<() => void>();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(
      <RenameInput initialValue="notes" format="collection" onCommit={onCommit} onCancel={onCancel} />,
    ));
    const input = container.querySelector("input")!;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "회의록");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return { input, onCommit, onCancel };
  };

  it.each(["isComposing", "keyCode"] as const)(
    "leaves Enter and Escape to an IME that is still composing (%s)",
    (composing) => {
      const { input, onCommit, onCancel } = renderRename();

      keyDown(input, "Enter", composing);
      keyDown(input, "Escape", composing);

      expect(onCommit).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    },
  );

  it("commits on Enter outside a composition", () => {
    const { input, onCommit } = renderRename();

    keyDown(input, "Enter");

    expect(onCommit).toHaveBeenCalledWith("회의록");
  });

  it("cancels on Escape outside a composition", () => {
    const { input, onCommit, onCancel } = renderRename();

    keyDown(input, "Escape");

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
