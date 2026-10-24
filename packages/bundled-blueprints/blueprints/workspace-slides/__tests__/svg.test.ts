// The inline SVG sanitizer: deck SVG is untrusted (pasted, or written by an agent or a collaborator).
import { describe, expect, it } from "vitest";
import { parseSvgMarkup, scopeSvgIds, svgArtworkSize } from "../files/lib/svg.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const svg = (body: string, attrs = "") => parseSvgMarkup(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${body}</svg>`)!;

describe("parseSvgMarkup", () => {
  it("returns null without an <svg>", () => {
    expect(parseSvgMarkup("<p>not svg</p>")).toBeNull();
  });

  it("drops scripts, and frames inside foreignObject", () => {
    const node = svg('<script>alert(1)</script><foreignObject><iframe srcdoc="<script>alert(2)</script>"></iframe><p>text</p></foreignObject>');
    expect(node.querySelector("script, iframe")).toBeNull();
    expect(node.querySelector("foreignObject p")?.textContent).toBe("text");
    expect(node.outerHTML).not.toMatch(/alert/);
  });

  it("drops event handler attributes", () => {
    const node = svg('<rect onclick="alert(1)" onmouseover="alert(2)" width="5"/>', ' onload="alert(3)"');
    const rect = node.querySelector("rect")!;
    expect(rect.getAttribute("width")).toBe("5");
    expect([node, rect].flatMap((n) => n.getAttributeNames()).filter((name) => name.startsWith("on"))).toEqual([]);
  });

  it("drops script and outside links, and animations that would write a link", () => {
    const node = svg(
      '<a href="javascript:alert(1)"><text>a</text></a><a xlink:href=" javascript:alert(2)"><text>b</text></a>' +
      '<a href="#top"><animate attributeName="href" values="javascript:alert(3)"/><set attributeName="xlink:href" to="javascript:alert(4)"/><text>c</text></a>' +
      '<image href="https://tracker.test/p.png"/><image src="https://tracker.test/q.png"/><use href="https://x.test/s.svg#a"/>',
      ' xmlns:xlink="http://www.w3.org/1999/xlink"',
    );
    const links = Array.from(node.querySelectorAll("a"));
    expect(links[0].hasAttribute("href")).toBe(false);
    expect(links[1].getAttributeNames()).toEqual([]);
    expect(links[2].getAttribute("href")).toBe("#top");
    expect(node.querySelector("animate, set")).toBeNull();
    for (const n of node.querySelectorAll("image, use")) expect(n.getAttributeNames()).toEqual([]);
    expect(node.outerHTML).not.toMatch(/javascript|tracker|x\.test/);
  });

  it("keeps fragment references and image data", () => {
    const node = svg(
      '<defs><linearGradient id="g"><stop offset="0"/></linearGradient><path id="p" d="M0 0h1"/></defs>' +
      `<rect fill="url(#g)" style="fill: url('#g')" width="10" height="10"/><use href="#p"/><image href="${PNG}"/>`,
    );
    const rect = node.querySelector("rect")!;
    expect(rect.getAttribute("fill")).toBe("url(#g)");
    expect(rect.getAttribute("style")).toBe("fill: url('#g')");
    expect(node.querySelector("use")!.getAttribute("href")).toBe("#p");
    expect(node.querySelector("image")!.getAttribute("href")).toBe(PNG);
  });
});

const art = () => svg(
  '<defs><linearGradient id="sky"><stop/></linearGradient><clipPath id="c"><rect/></clipPath></defs>' +
  '<style>#sun { fill: url(#sky) } .dot { fill: #fff }</style>' +
  '<circle id="sun"/><rect fill="url(#sky)" style="clip-path: url(\'#c\')"/><use href="#sun"/><path fill="url(#elsewhere)"/>',
);

const idsOf = (n: SVGSVGElement) => Array.from(n.querySelectorAll("[id]"), (e) => e.id);

describe("scopeSvgIds", () => {
  it("gives each copy its own ids and keeps every reference pointing inside that copy", () => {
    const a = art(), b = art();
    scopeSvgIds(a);
    scopeSvgIds(b);
    expect(idsOf(a).filter((id) => idsOf(b).includes(id))).toEqual([]);
    const sky = a.querySelector("linearGradient")!.id, sun = a.querySelector("circle")!.id, clip = a.querySelector("clipPath")!.id;
    expect(sky).toMatch(/-sky$/);
    const rect = a.querySelector("rect[fill]")!;
    expect(rect.getAttribute("fill")).toBe(`url(#${sky})`);
    expect(rect.getAttribute("style")).toBe(`clip-path: url('#${clip}')`);
    expect(a.querySelector("use")!.getAttribute("href")).toBe(`#${sun}`);
    expect(a.querySelector("style")!.textContent).toBe(`#${sun} { fill: url(#${sky}) } .dot { fill: #fff }`);
  });

  it("leaves references to ids the SVG doesn't define alone", () => {
    const node = art();
    scopeSvgIds(node);
    expect(node.querySelector("path")!.getAttribute("fill")).toBe("url(#elsewhere)");
  });
});

// Drawn at another size (in its block, or rasterized for PowerPoint), artwork must scale with it.
describe("svgArtworkSize", () => {
  const bare = (attrs: string) => parseSvgMarkup(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="100" height="100"/></svg>`)!;

  it("gives an SVG with only a width and height the viewBox they imply", () => {
    const node = bare('width="100" height="50px"');
    expect(svgArtworkSize(node)).toEqual({ w: 100, h: 50 });
    expect(node.getAttribute("viewBox")).toBe("0 0 100 50");
  });

  it("keeps a viewBox it already has", () => {
    const node = bare('viewBox="0 0 40 20" width="400" height="200"');
    expect(svgArtworkSize(node)).toEqual({ w: 40, h: 20 });
    expect(node.getAttribute("viewBox")).toBe("0 0 40 20");
  });

  // A relative size says nothing about the artwork's own units.
  it("leaves one sized in percentages alone", () => {
    const node = bare('width="100%" height="100%"');
    expect(svgArtworkSize(node)).toEqual({ w: 300, h: 150 });
    expect(node.hasAttribute("viewBox")).toBe(false);
  });
});
