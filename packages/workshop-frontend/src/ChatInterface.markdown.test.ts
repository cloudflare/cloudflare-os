// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownMessage } from "./ChatInterface";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MarkdownMessage line breaks", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    vi.unstubAllGlobals();
  });

  async function render(message: string) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(MarkdownMessage, { message })));
  }

  // The user-message fix relies on Markdown preserving a single newline as a literal "\n"
  // in the DOM, so the `whitespace-pre-wrap` wrapper renders it as a hard line break. If a
  // dependency upgrade (react-markdown / remark-gfm) ever collapsed it to a space, the
  // visual fix would silently break; this test guards that invariant.
  it("preserves a single newline within a paragraph as a literal newline", async () => {
    await render("line one\nline two");

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBe(1);
    expect(paragraphs[0].textContent).toBe("line one\nline two");
  });

  it("still renders a blank line as a paragraph break (two <p>)", async () => {
    await render("para one\n\npara two");

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBe(2);
    expect(paragraphs[0].textContent).toBe("para one");
    expect(paragraphs[1].textContent).toBe("para two");
  });

  it("copies fenced code without the Markdown trailing newline", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await render("```ts\nconst answer = 42;\n```");

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy code"]',
    );
    expect(button?.title).toBe("Copy code");

    await act(async () => button?.click());

    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
  });
});
