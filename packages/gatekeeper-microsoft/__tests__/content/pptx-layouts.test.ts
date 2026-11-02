import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pptxToMarkdown } from "../../src/content/pptx";
import { describePptx, editPptx } from "../../src/content/pptx-edit";
import { imageRefs, imageSize, prepareMarkdown, type PptxImage } from "../../src/content/pptx-images";
import { markdownToPptx, SlideContentError } from "../../src/content/pptx-write";
import { chartPng, gifHeader, jpegHeader, photoPng } from "./pptx-test-images";
import { slideLayoutType, slideShapes, validatePptx } from "./pptx-validate";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url).pathname));
const png = (bytes: Uint8Array): PptxImage => ({ bytes, mimeType: "image/png" });

describe("layouts", () => {
  it("uses the layout a directive names, by the deck's own name or PowerPoint's", async () => {
    const markdown = "# Intro\n\n- a\n\n<!-- layout: title only -->\n# Just a title\n\n# Section\n<!-- layout: Section Header -->\n\nWhat comes next\n\n<!-- layout: twoObj -->\n# Columns\n\n- left\n\n+++\n\n- right";
    const { pkg, slides } = await validatePptx(await markdownToPptx(markdown));
    expect(slides.map(slide => slideLayoutType(pkg, slide))).toEqual(["obj", "titleOnly", "secHead", "twoObj"]);
    expect(slideShapes(pkg, slides[2]!)).toEqual(["title: Section", "body: What comes next"]);
  });

  it("lists the deck's layouts when a directive names one it doesn't have", async () => {
    await expect(markdownToPptx("<!-- layout: Agenda Grid -->\n# A")).rejects.toThrow(new SlideContentError(
      'There\'s no "Agenda Grid" layout in this deck. Its layouts are: Title Slide, Title and Content, Section Header, Two Content, Comparison, Title Only, Blank, Picture with Caption.'));
  });

  it("infers Two Content from +++ and Comparison when each column opens with a heading", async () => {
    const bytes = await markdownToPptx("# Plan\n\n- a\n\n# Split\n\n- left\n\n+++\n\n- right\n\n# Versus\n\n### Build\n- cheap\n\n+++\n\n### Buy\n- fast");
    const { pkg, slides } = await validatePptx(bytes);
    expect(slides.map(slide => slideLayoutType(pkg, slide))).toEqual(["obj", "twoObj", "twoTxTwoObj"]);
    expect(slideShapes(pkg, slides[1]!).filter(line => !line.startsWith("sldNum"))).toEqual(["title: Split", "obj: left", "obj: right"]);
    expect(slideShapes(pkg, slides[2]!).filter(line => !line.startsWith("sldNum"))).toEqual(["title: Versus", "body: Build", "body: Buy", "obj: cheap", "obj: fast"]);
    const markdown = (await pptxToMarkdown(bytes)).markdown;
    expect(markdown).toMatch(/## Slide 3: Versus\n\nBuild\n\nBuy\n\n- cheap\n+- fast/);
  });

  it("refuses more columns than a named layout has, and folds extra ones when it chose the layout itself", async () => {
    await expect(markdownToPptx("<!-- layout: Two Content -->\n# A\n\n- 1\n\n+++\n\n- 2\n\n+++\n\n- 3")).rejects.toThrow(
      /The slide "A" has 3 columns separated by \+\+\+, but the "Two Content" layout has room for 2\./);
    const { pkg, slides } = await validatePptx(await markdownToPptx("# A\n\n- 1\n\n+++\n\n- 2\n\n+++\n\n- 3"));
    expect(slideShapes(pkg, slides[0]!).filter(line => !line.startsWith("sldNum"))).toEqual(["title: A", "obj: 1", "obj: 2 / 3"]);
  });

  it("keeps a lone +++ deck title from swallowing column headings as slides", async () => {
    const { pkg, slides } = await validatePptx(await markdownToPptx("# Choice\n\n### Build\n- a\n\n+++\n\n### Buy\n- b"));
    expect(slides).toHaveLength(1);
    expect(slideLayoutType(pkg, slides[0]!)).toBe("twoTxTwoObj");
  });

  it("finds a template's layouts by name and falls back by type", async () => {
    const template = fixture("python-pptx-template.potx");
    const { pkg, slides } = await validatePptx(await markdownToPptx(
      "<!-- layout: Content with Caption -->\n# Caption\n\ntext\n\n<!-- layout: Comparison -->\n# Compare\n\n### A\n- x\n\n+++\n\n### B\n- y", { template }));
    expect(slides.map(slide => slideLayoutType(pkg, slide))).toEqual(["objTx", "twoTxTwoObj"]);
    const described = await describePptx(await markdownToPptx("<!-- layout: Comparison -->\n# Compare\n\n### A\n- x\n\n+++\n\n### B\n- y", { template }));
    expect(described[0]!.placeholders.map(placeholder => placeholder.markdown)).toEqual(["Compare", "A", "B", "- x", "- y"]);
  });
});

describe("images", () => {
  const images = new Map([["charts/q3.png", png(chartPng(400, 200))], ["photo.png", png(photoPng(300, 400))]]);

  it("lists image lines' references once, ignoring code blocks and inline images", () => {
    expect(imageRefs("# A\n\n![Chart](charts/q3.png)\n\n```\n![not](code.png)\n```\n\nSee ![inline](x.png) here\n\n![Again](charts/q3.png \"title\")\n\n![](<Shared Documents/a b.png>)"))
      .toEqual(["charts/q3.png", "Shared Documents/a b.png"]);
    expect(prepareMarkdown("![a](x.png)").images).toEqual([{ alt: "a", ref: "x.png" }]);
  });

  it("reads pixel sizes from PNG, JPEG and GIF headers, and refuses bytes that aren't the type claimed", () => {
    expect(imageSize(png(chartPng(320, 180)), "a")).toEqual({ width: 320, height: 180 });
    expect(imageSize({ bytes: jpegHeader(1024, 768), mimeType: "image/jpeg" }, "b")).toEqual({ width: 1024, height: 768 });
    expect(imageSize({ bytes: gifHeader(64, 48), mimeType: "image/gif" }, "c")).toEqual({ width: 64, height: 48 });
    expect(() => imageSize({ bytes: gifHeader(1, 1), mimeType: "image/png" }, "d.png")).toThrow('The image "d.png" isn\'t a valid PNG file.');
  });

  it("centers a picture alone on a slide in the content area, keeping its aspect ratio, with its description", async () => {
    const { pkg, slides } = await validatePptx(await markdownToPptx("# Q3\n\n![Revenue by quarter](charts/q3.png)", { images }));
    const xml = pkg.text(slides[0]!)!;
    expect(xml).toContain('descr="Revenue by quarter"');
    const [, x, y, cx, cy] = /<p:pic>.*?<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xml)!.map(Number);
    expect(cx! / cy!).toBeCloseTo(2, 2);
    // The content area: x 838200, width 10515600, from y 1825625, height 4351338.
    expect(x! + cx! / 2).toBeCloseTo(838200 + 10515600 / 2, -2);
    expect(y! + cy! / 2).toBeCloseTo(1825625 + 4351338 / 2, -2);
    expect(cy).toBeLessThanOrEqual(4351338);
  });

  it("fills a picture placeholder, cropped to its shape, and stores an image used twice once", async () => {
    const bytes = await markdownToPptx("<!-- layout: Picture with Caption -->\n# Office\n\n![Lisbon](photo.png)\n\nOpened in September.\n\n# Again\n\n![Lisbon](photo.png)", { images });
    const { pkg, slides } = await validatePptx(bytes);
    const xml = pkg.text(slides[0]!)!;
    expect(xml).toMatch(/<p:ph type="pic" idx="1"\/>.*<a:srcRect t="\d+" b="\d+"\/>/);
    expect(slideShapes(pkg, slides[0]!)).toContain("body: Opened in September.");
    expect(pkg.names().filter(name => name.startsWith("ppt/media/"))).toEqual(["ppt/media/image1.png"]);
    expect((await describePptx(bytes))[0]!.images).toEqual([{ name: "Picture 2", description: "Lisbon" }]);
  });

  it("puts pictures beside text in two columns and below text when they share a column", async () => {
    const { pkg, slides } = await validatePptx(await markdownToPptx("# Mixed\n\n- point\n\n![Chart](charts/q3.png)", { images }));
    const xml = pkg.text(slides[0]!)!;
    const text = /<p:sp>.*?<a:off x="\d+" y="(\d+)"\/><a:ext cx="\d+" cy="(\d+)"\/>/.exec(xml)!;
    const picture = /<p:pic>.*?<a:off x="\d+" y="(\d+)"\/>/.exec(xml)!;
    expect(Number(picture[1])).toBeGreaterThanOrEqual(Number(text[1]) + Number(text[2]));
  });

  it("refuses an image that wasn't provided, and a type slides don't take", async () => {
    await expect(markdownToPptx("# A\n\n![Missing](nope.png)", { images })).rejects.toThrow(
      'The image "nope.png" wasn\'t provided. Every image line (![description](reference)) needs its file.');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    await expect(markdownToPptx("# A\n\n![Logo](logo.svg)", { images: new Map([["logo.svg", { bytes: svg, mimeType: "image/svg+xml" as never }]]) }))
      .rejects.toThrow(/slides take PNG, JPEG or GIF/);
  });

  it("adds slides with pictures to an existing deck", async () => {
    const result = await editPptx(fixture("python-pptx-deck.pptx"), [{ addSlides: "# Chart\n\n![Revenue](charts/q3.png)" }], { images });
    const { pkg, slides } = await validatePptx(result.bytes);
    expect(pkg.text(slides.at(-1)!)).toContain('descr="Revenue"');
    await expect(editPptx(fixture("python-pptx-deck.pptx"), [{ addSlides: "# Chart\n\n![Revenue](other.png)" }], { images }))
      .rejects.toThrow(/The image "other\.png" wasn't provided/);
  });
});
