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
});
