import { afterEach, describe, expect, it, vi } from "vitest";

import { ICONS } from "../src/icons.ts";
import { colorBtn, customSelect, group, iconBtn, segBtn } from "../src/toolbar.ts";

afterEach(() => {
  document.body.replaceChildren();
});

function mousedown(target: EventTarget): MouseEvent {
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("iconBtn", () => {
  it("is a titled, labelled button showing the icon", () => {
    const onClick = vi.fn();
    const button = iconBtn(ICONS.undo, "Undo (Ctrl+Z)", onClick);
    expect(button.tagName).toBe("BUTTON");
    expect(button.className).toBe("icon-btn");
    expect(button.type).toBe("button");
    expect(button.title).toBe("Undo (Ctrl+Z)");
    expect(button.getAttribute("aria-label")).toBe("Undo (Ctrl+Z)");
    expect(button.querySelector("svg")).not.toBeNull();
    button.click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(onClick.mock.calls[0]![0]).toBeInstanceOf(MouseEvent);
  });

  it("prevents mousedown so the editor keeps its selection", () => {
    const button = iconBtn(ICONS.bold, "Bold", () => {});
    expect(mousedown(button).defaultPrevented).toBe(true);
  });

  it("shows a text label instead of an icon when given one", () => {
    const button = iconBtn(null, "Insert function", () => {}, "ƒx");
    expect(button.textContent).toBe("ƒx");
    expect(button.querySelector("svg")).toBeNull();
    const labelled = iconBtn(ICONS.bold, "Bold", () => {}, "B");
    expect(labelled.textContent).toBe("B");
  });
});

describe("segBtn", () => {
  it("is an icon button with the seg-btn class", () => {
    const onClick = vi.fn();
    const button = segBtn(ICONS.alignLeft, "Align left", onClick);
    expect(button.className).toBe("seg-btn");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(mousedown(button).defaultPrevented).toBe(true);
    button.click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("group", () => {
  it("wraps the items after a divider and carries the priority as a class", () => {
    const a = iconBtn(ICONS.undo, "Undo", () => {});
    const b = iconBtn(ICONS.redo, "Redo", () => {});
    const node = group("p2", [a, b]);
    expect(node.className).toBe("tgroup p2");
    expect(Array.from(node.children).map((child) => child.className)).toEqual(["tdiv", "icon-btn", "icon-btn"]);
    expect(node.children[1]).toBe(a);
  });

  it("omits the divider from the first group and the class from a null priority", () => {
    const node = group(null, [iconBtn(ICONS.undo, "Undo", () => {})], true);
    expect(node.className).toBe("tgroup");
    expect(node.children.length).toBe(1);
    expect(node.querySelector(".tdiv")).toBeNull();
  });
});

describe("colorBtn", () => {
  it("builds the icon, swatch and colour input, and reports picks", () => {
    const onChange = vi.fn();
    const button = colorBtn(ICONS.textcolor, "Text color", "#1d1d20", onChange);
    expect(button.className).toBe("color-btn");
    expect(button.title).toBe("Text color");
    const [iconHost, bar, input] = Array.from(button.children) as [HTMLElement, HTMLElement, HTMLInputElement];
    expect(iconHost.querySelector("svg")).not.toBeNull();
    expect(bar.className).toBe("bar");
    expect(bar.style.background).toBe("rgb(29, 29, 32)");
    expect(input.type).toBe("color");
    expect(input.value).toBe("#1d1d20");

    input.value = "#ff0000";
    input.dispatchEvent(new Event("input"));
    expect(onChange).toHaveBeenCalledWith("#ff0000");
    expect(bar.style.background).toBe("rgb(255, 0, 0)");
    expect(mousedown(button).defaultPrevented).toBe(true);
  });
});

describe("customSelect", () => {
  const options = [
    { value: "P", label: "Normal text" },
    { value: "H1", label: "Heading 1", style: "font-weight:700;" },
    { sep: true as const },
    { value: "PRE", label: "Code block", ex: "mono" },
  ];

  it("shows the current label and marks the item selected", () => {
    const select = customSelect({ className: "style-sel", title: "Paragraph style", options, value: "H1", onChange: () => {} });
    expect(select.el.tagName).toBe("BUTTON");
    expect(select.el.type).toBe("button");
    expect(select.el.className).toBe("cselect style-sel");
    expect(select.el.title).toBe("Paragraph style");
    expect(select.el.querySelector(".cs-label")!.textContent).toBe("Heading 1");
    expect(select.el.querySelector(".cs-chev svg")).not.toBeNull();
    expect(select.getValue()).toBe("H1");
  });

  it("opens a positioned menu on the body and closes it again", () => {
    const select = customSelect({ options, value: "P", onChange: () => {} });
    document.body.appendChild(select.el);
    vi.spyOn(select.el, "getBoundingClientRect").mockReturnValue({ left: 10.4, bottom: 30, width: 100.6, top: 0, right: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
    select.el.click();
    const menu = document.body.querySelector(".cmenu") as HTMLElement;
    expect(menu).not.toBeNull();
    expect(select.el.classList.contains("open")).toBe(true);
    expect(menu.style.left).toBe("10px");
    expect(menu.style.top).toBe("34px");
    expect(menu.style.minWidth).toBe("101px");

    const items = Array.from(menu.querySelectorAll(".cmenu-item"));
    expect(items.map((item) => item.textContent)).toEqual(["Normal text", "Heading 1", "Code blockmono"]);
    expect(items[0]!.classList.contains("sel")).toBe(true);
    expect((items[1] as HTMLElement).style.fontWeight).toBe("700");
    expect(items[2]!.querySelector(".ex")!.textContent).toBe("mono");
    expect(menu.querySelectorAll(".cmenu-sep").length).toBe(1);
    expect(menu.children[2]!.className).toBe("cmenu-sep");

    select.el.click();
    expect(document.body.querySelector(".cmenu")).toBeNull();
    expect(select.el.classList.contains("open")).toBe(false);
  });

  it("chooses on an item click, telling the gadget once, and keeps mousedown from stealing focus", () => {
    const onChange = vi.fn();
    const select = customSelect({ options, value: "P", onChange });
    document.body.appendChild(select.el);
    select.el.click();
    const item = document.body.querySelectorAll(".cmenu-item")[2]!;
    expect(mousedown(item).defaultPrevented).toBe(true);
    (item as HTMLElement).click();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("PRE");
    expect(select.getValue()).toBe("PRE");
    expect(select.el.querySelector(".cs-label")!.textContent).toBe("Code block");
    expect(document.body.querySelector(".cmenu")).toBeNull();
  });

  it("closes on a mousedown outside, a scroll or a resize, but not on one inside", () => {
    const select = customSelect({ options, value: "P", onChange: () => {} });
    document.body.appendChild(select.el);
    select.el.click();
    mousedown(document.body.querySelector(".cmenu-item")!);
    expect(document.body.querySelector(".cmenu")).not.toBeNull();
    mousedown(document.body);
    expect(document.body.querySelector(".cmenu")).toBeNull();

    select.el.click();
    window.dispatchEvent(new Event("scroll"));
    expect(document.body.querySelector(".cmenu")).toBeNull();

    select.el.click();
    window.dispatchEvent(new Event("resize"));
    expect(document.body.querySelector(".cmenu")).toBeNull();
  });

  it("setValue updates the label and selection without calling onChange", () => {
    const onChange = vi.fn();
    const select = customSelect({ options, value: "P", onChange });
    select.setValue("PRE");
    expect(select.getValue()).toBe("PRE");
    expect(select.el.querySelector(".cs-label")!.textContent).toBe("Code block");
    expect(onChange).not.toHaveBeenCalled();
    document.body.appendChild(select.el);
    select.el.click();
    const selected = Array.from(document.body.querySelectorAll(".cmenu-item.sel"));
    expect(selected.map((item) => (item as HTMLElement).dataset.value)).toEqual(["PRE"]);
  });

  it("matches numeric option values by their string form", () => {
    const onChange = vi.fn();
    const sizes = [11, 12, 16, 18].map((size) => ({ value: size, label: String(size) }));
    const select = customSelect({ options: sizes, value: 16, onChange });
    expect(select.el.querySelector(".cs-label")!.textContent).toBe("16");
    expect(select.getValue()).toBe("16");
    document.body.appendChild(select.el);
    select.el.click();
    const items = Array.from(document.body.querySelectorAll(".cmenu-item"));
    expect(items.filter((item) => item.classList.contains("sel")).map((item) => (item as HTMLElement).dataset.value)).toEqual(["16"]);

    (items[3] as HTMLElement).click();
    expect(onChange).toHaveBeenCalledWith("18");
    expect(select.getValue()).toBe("18");
    select.setValue(11);
    expect(select.el.querySelector(".cs-label")!.textContent).toBe("11");
    select.el.click();
    expect(Array.from(document.body.querySelectorAll(".cmenu-item.sel")).map((item) => (item as HTMLElement).dataset.value)).toEqual(["11"]);
  });

  it("shows the first choice's label for a value no option carries, selecting nothing", () => {
    const select = customSelect({ options: [{ sep: true }, ...options], value: "nope", onChange: () => {} });
    expect(select.getValue()).toBe("nope");
    expect(select.el.querySelector(".cs-label")!.textContent).toBe("Normal text");
    document.body.appendChild(select.el);
    select.el.click();
    expect(document.body.querySelectorAll(".cmenu-item.sel").length).toBe(0);
  });
});
