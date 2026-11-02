import { describe, expect, it } from "vitest";
import { applySplices, elementText, parseRaw, rawChild, rawDescendants, RawXmlError } from "../../src/content/raw-xml";

describe("parseRaw", () => {
  it("reads attributes in either quote style, with spacing around =, and > inside a value", () => {
    const root = parseRaw(`<r><a x = "1" y='2' z=">&amp;"/></r>`);
    const a = rawChild(root, "a")!;
    expect([...a.attributes]).toEqual([["x", "1"], ["y", "2"], ["z", ">&"]]);
    expect(a.closeStart).toBe(a.openEnd);
  });

  it("refuses attributes a tag cannot have", () => {
    for (const tag of ["<a x/>", "<a x=1/>", '<a x="1/>', '<a ="1"/>']) expect(() => parseRaw(tag), tag).toThrow(RawXmlError);
  });

  it("keeps offsets so a splice leaves the rest of the text byte for byte", () => {
    const text = `<?xml version="1.0"?><w:body><w:p><w:r><w:t>a<![CDATA[&]]></w:t></w:r></w:p>\n<w:p/></w:body>`;
    const root = parseRaw(text);
    const [first, second] = [...rawDescendants(root, "w:p")];
    expect(elementText(rawChild(rawChild(first, "w:r"), "w:t")!)).toBe("a&");
    expect(text.slice(first!.start, first!.end)).toBe("<w:p><w:r><w:t>a<![CDATA[&]]></w:t></w:r></w:p>");
    expect(applySplices(text, [{ start: first!.openEnd, end: first!.closeStart, text: "X" }, { start: second!.start, end: second!.end, text: "" }]))
      .toBe(`<?xml version="1.0"?><w:body><w:p>X</w:p>\n</w:body>`);
  });
});
