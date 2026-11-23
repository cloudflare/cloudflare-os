// @vitest-environment jsdom

import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Overseer } from "@gadgets/workshop-shared/api";
import { AgentAnswer, MarkdownMessage } from "./ChatInterface";

vi.mock("react-markdown", async importOriginal => {
  const original = await importOriginal<typeof import("react-markdown")>();
  return { ...original, default: vi.fn<typeof original.default>(original.default) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The text of each line an element breaks into at its <br>s.
const renderedLines = (element: Element) => {
  const lines = [""];
  for (const child of element.childNodes) {
    if (child.nodeName === "BR") lines.push("");
    else lines[lines.length - 1] += child.textContent;
  }
  return lines.map((line) => line.trim());
};

describe("MarkdownMessage line breaks", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    vi.unstubAllGlobals();
  });

  async function render(message: string, preserveLineBreaks?: boolean) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(createElement(MarkdownMessage, { message, preserveLineBreaks })));
  }

  it("renders a user's single newline as a hard break", async () => {
    await render("line one\nline two", true);

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBe(1);
    expect(renderedLines(paragraphs[0])).toEqual(["line one", "line two"]);
  });

  it("breaks Windows line endings without leaving a carriage return", async () => {
    await render("line one\r\nline two", true);

    expect(renderedLines(container.querySelector("p")!)).toEqual(["line one", "line two"]);
    expect(container.textContent).not.toContain("\r");
  });

  it("leaves a model's single newline as a soft break", async () => {
    await render("line one\nline two");

    expect(container.querySelector("br")).toBeNull();
  });

  // Breaks belong only inside text; the newlines between block elements would otherwise show as a
  // blank line between every item.
  it("adds no breaks between the items of a list", async () => {
    await render("Intro:\n- one\n- two\n\n1. three\n2. four", true);

    expect(container.querySelectorAll("li").length).toBe(4);
    expect(container.querySelector("ul br, ol br")).toBeNull();
  });

  it("keeps newlines inside fenced code", async () => {
    await render("```\na\nb\n```", true);

    expect(container.querySelector("code")?.textContent).toBe("a\nb\n");
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

  it("does not reparse a completed file reply while later text streams, but updates new pins", async () => {
    const source = "worktree://OUTPUTS/source.cpp";
    const message = `[Source](${source})`;
    const oids = { [source]: "a".repeat(40) };
    const readBlob = vi.fn<Overseer["readBlob"]>();
    const blocks = { onSendMessage: async () => {}, onHeightChange: () => {}, scrollRoot: { current: null } };
    await render("");
    vi.mocked(ReactMarkdown).mockClear();
    const update = async (text: string, pins: typeof oids | Record<string, null> = oids) => {
      await act(async () => root.render(createElement(Fragment, null,
        createElement(AgentAnswer, { message, streaming: false,
          blocks: { ...blocks, files: { oids: pins, readBlob } } }),
        createElement(MarkdownMessage, { message: text }),
      )));
    };
    const parses = () => vi.mocked(ReactMarkdown).mock.calls.filter(([props]) => props.children === message).length;
    await update("Next");
    await update("Next reply");
    expect(parses()).toBe(1);
    await update("Next reply", { [source]: null });
    expect(parses()).toBe(2);
    expect(container.textContent).toContain("Source (unavailable)");
    expect(readBlob).not.toHaveBeenCalled();
  });
});
