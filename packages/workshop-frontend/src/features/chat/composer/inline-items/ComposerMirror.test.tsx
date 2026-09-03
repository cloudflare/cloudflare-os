// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerMirror, type ComposerMirrorHandle } from "./ComposerMirror";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ComposerMirror geometry", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  const renderMirror = async () => {
    const mirrorRef = createRef<ComposerMirrorHandle>();
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(
      <ComposerMirror
        ref={mirrorRef}
        value="/cmd https://example.com"
        tokens={[{ kind: "command", start: 0, length: 4 }]}
        disabled={false}
      />,
    ));
    return mirrorRef;
  };

  it("maps pointer hits to the nearest token edge", async () => {
    const mirrorRef = await renderMirror();
    const token = container!.querySelector<HTMLElement>("[data-token-start]")!;
    token.getClientRects = () => [{
      left: 10, right: 30, top: 0, bottom: 10, width: 20,
    }] as unknown as DOMRectList;

    expect(mirrorRef.current!.tokenAtPoint(12, 5)).toEqual({ start: 0, edge: 0 });
    expect(mirrorRef.current!.tokenAtPoint(28, 5)).toEqual({ start: 0, edge: 4 });
    expect(mirrorRef.current!.tokenAtPoint(40, 5)).toBeNull();
  });

  it("measures offsets in plain text segments", async () => {
    const mirrorRef = await renderMirror();
    let measuredOffset: number | undefined;
    vi.spyOn(document, "createRange").mockReturnValue({
      setStart: (_node: Node, offset: number) => { measuredOffset = offset; },
      setEnd: vi.fn<(node: Node, offset: number) => void>(),
      getBoundingClientRect: () => ({ top: 42 }),
    } as unknown as Range);

    expect(mirrorRef.current!.textOffsetTop(6)).toBe(42);
    expect(measuredOffset).toBe(2);
  });

  it("accepts image logo URLs and rejects unsafe CSS schemes", async () => {
    const mirrorRef = createRef<ComposerMirrorHandle>();
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(
      <ComposerMirror
        ref={mirrorRef}
        value="Plan"
        tokens={[{
          kind: "capsule",
          start: 0,
          length: 4,
          logoUrl: "javascript:alert(1)",
        }]}
        disabled={false}
      />,
    ));
    expect(container.querySelector<HTMLElement>("[data-token-start]")!.style.backgroundImage)
      .toBe("");

    await act(async () => root!.render(
      <ComposerMirror
        ref={mirrorRef}
        value="Plan"
        tokens={[{
          kind: "capsule",
          start: 0,
          length: 4,
          logoUrl: "https://example.com/logo.svg",
        }]}
        disabled={false}
      />,
    ));
    expect(container.querySelector<HTMLElement>("[data-token-start]")!.style.backgroundImage)
      .toContain("https://example.com/logo.svg");
  });
});
