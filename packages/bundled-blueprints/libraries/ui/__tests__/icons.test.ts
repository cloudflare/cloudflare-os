import { describe, expect, it } from "vitest";

import { el, icon } from "../src/dom.ts";
import { ICONS } from "../src/icons.ts";

describe("ICONS", () => {
  it("holds path markup that draws as an svg for every name", () => {
    expect(Object.keys(ICONS).length).toBeGreaterThan(0);
    for (const [name, paths] of Object.entries(ICONS)) {
      const host = el("span", { html: icon(paths) });
      const svg = host.querySelector("svg");
      expect(svg, name).not.toBeNull();
      expect(svg!.children.length, name).toBeGreaterThan(0);
      for (const shape of Array.from(svg!.children)) {
        expect(["path", "line", "circle", "rect", "polyline"], `${name} draws a ${shape.tagName}`).toContain(shape.tagName.toLowerCase());
      }
    }
  });

  it("names the toolbar icons the document gadgets share", () => {
    for (const name of ["undo", "redo", "bold", "italic", "underline", "strike", "link", "ul", "ol", "image", "alignLeft", "alignCenter", "alignRight", "textcolor", "clear"]) {
      expect(ICONS).toHaveProperty(name);
    }
  });
});
