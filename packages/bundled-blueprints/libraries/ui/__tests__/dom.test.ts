import { describe, expect, it, vi } from "vitest";

import { el, icon } from "../src/dom.ts";

describe("el", () => {
  it("creates the tag with attributes set verbatim", () => {
    const input = el("input", { type: "text", "aria-label": "Title", tabindex: 0 });
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("type")).toBe("text");
    expect(input.getAttribute("aria-label")).toBe("Title");
    expect(input.getAttribute("tabindex")).toBe("0");
  });

  it("treats class, html and a style object as conveniences", () => {
    const node = el("div", { class: "a b", html: "<b>x</b>", style: { color: "red", display: "flex" } });
    expect(node.className).toBe("a b");
    expect(node.innerHTML).toBe("<b>x</b>");
    expect(node.style.color).toBe("red");
    expect(node.style.display).toBe("flex");
    expect(node.hasAttribute("class")).toBe(true);
    expect(node.hasAttribute("html")).toBe(false);
  });

  it("sets text as textContent, before the children", () => {
    expect(el("span", { text: "Advanced" }).textContent).toBe("Advanced");
    expect(el("span", { text: "Advanced" }).hasAttribute("text")).toBe(false);
    expect(el("span", { text: 3 }).textContent).toBe("3");
    expect(el("span", { text: "a" }, ["b"]).textContent).toBe("ab");
  });

  it("keeps a style string as the attribute", () => {
    expect(el("div", { style: "color: red" }).getAttribute("style")).toBe("color: red");
  });

  it("skips null, undefined and false, and writes true as an empty attribute", () => {
    const node = el("div", { hidden: true, title: null, lang: undefined, draggable: false });
    expect(node.getAttribute("hidden")).toBe("");
    expect(node.hasAttribute("title")).toBe(false);
    expect(node.hasAttribute("lang")).toBe(false);
    expect(node.hasAttribute("draggable")).toBe(false);
  });

  it("attaches on* functions as listeners for the lower-cased event", () => {
    const onClick = vi.fn();
    const onMouseDown = vi.fn();
    const button = el("button", { onclick: onClick, onMouseDown: onMouseDown });
    button.dispatchEvent(new MouseEvent("click"));
    button.dispatchEvent(new MouseEvent("mousedown"));
    expect(onClick).toHaveBeenCalledOnce();
    expect(onMouseDown).toHaveBeenCalledOnce();
    expect(button.hasAttribute("onclick")).toBe(false);
  });

  it("sets an on* prop that is not a function as an attribute", () => {
    expect(el("div", { one: "1" }).getAttribute("one")).toBe("1");
  });

  it("appends nodes, strings and numbers, skipping nothing-values", () => {
    const child = el("span");
    const node = el("div", {}, [child, "text", 3, null, undefined, false]);
    expect(node.childNodes.length).toBe(3);
    expect(node.firstChild).toBe(child);
    expect(node.childNodes[1]!.nodeType).toBe(Node.TEXT_NODE);
    expect(node.textContent).toBe("text3");
  });

  it("accepts a single child without an array", () => {
    expect(el("span", {}, "Saved").textContent).toBe("Saved");
    const child = el("b");
    expect(el("span", {}, child).firstChild).toBe(child);
    expect(el("span", {}, null).childNodes.length).toBe(0);
  });

  it("returns the element typed by tag", () => {
    const anchor = el("a", { href: "https://example.com" });
    expect(anchor.href).toBe("https://example.com/");
  });
});

describe("icon", () => {
  it("wraps the paths in a stroked, hidden 24-unit svg", () => {
    const svg = icon('<path d="M4 4"/>');
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('<path d="M4 4"/></svg>');
    const host = el("span", { html: svg });
    expect(host.querySelector("svg path")?.getAttribute("d")).toBe("M4 4");
  });
});
