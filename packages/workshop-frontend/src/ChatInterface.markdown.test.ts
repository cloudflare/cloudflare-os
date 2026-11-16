// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownMessage } from "./ChatInterface";

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
});

// Loading an image would send its address to whoever runs the server it names, so a message's
// images must never become requests: a web address is a link, anything else just its alt text.
describe("MarkdownMessage images", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
  });

  async function render(message: string, preserveLineBreaks?: boolean) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(createElement(MarkdownMessage, { message, preserveLineBreaks })));
  }

  it("links a web image rather than loading it", async () => {
    await render("Status: ![the chart](https://example.com/c.png?d=secret)");

    expect(container.querySelector("img")).toBeNull();
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/c.png?d=secret");
    expect(link?.textContent).toBe("the chart");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("labels a web image with no alt text by its address", async () => {
    await render("![](https://example.com/pixel.gif)");

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")?.textContent).toBe("https://example.com/pixel.gif");
  });

  it("leaves an image that isn't on the web as its alt text", async () => {
    await render([
      "![relative](/gatekeeper/github/connect)",
      "![protocol-relative](//example.com/x.png)",
      "![script](javascript:alert(1))",
      "![](//example.com/no-alt.png)",
    ].join("\n\n"));

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect([...container.querySelectorAll("p")].map((p) => p.textContent))
      .toEqual(["relative", "protocol-relative", "script", ""]);
  });

  it("treats a person's message the same way", async () => {
    await render("look ![x](https://example.com/x.png)", true);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/x.png");
  });
});
