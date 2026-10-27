import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pptxToMarkdown } from "../../src/content/pptx";
import { OpcPackage } from "../../src/content/pptx-package";
import { markdownToPptx, planSlides } from "../../src/content/pptx-write";
import { parseMarkdown } from "../../src/content/markdown-parse";
import { slideLayoutType, slideShapes, validatePptx } from "./pptx-validate";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url).pathname));
const AT = new Date("2026-10-01T09:30:00Z");

async function read(bytes: Uint8Array): Promise<string> {
  return (await pptxToMarkdown(bytes)).markdown;
}

export const SHOWCASE = `# Northwind Platform Review
Q3 2026 · Engineering leadership offsite

# Where we are

Platform reliability is **ahead of plan** and costs are *down*. Two risks need decisions today.

- Availability at **99.982%**, above the 99.95% target
- Infra spend down 14% after the [storage migration](https://example.com/storage)
  - Cold tier now holds 61% of bytes
  - Egress renegotiated with two vendors
- Incident count flat; time to mitigate down 22%

> Notes: Open with the availability number, then hand to Priya for costs.

# Roadmap

1. Finish regional failover (October)
2. Ship the self-serve quota console
   1. Read-only view first
   2. Edits behind approval
3. Retire the legacy job runner ~~in Q4~~ by January

## Decisions needed

- [x] Approve failover budget
- [ ] Choose the quota console owner

# Quarterly numbers

| Metric | Q1 | Q2 | Q3 |
|:-------|---:|---:|---:|
| Availability | 99.95% | 99.97% | 99.98% |
| Infra spend | $4.1M | $3.8M | $3.5M |
| Incidents | 14 | 12 | 12 |
| Time to mitigate | 41 min | 36 min | 32 min |

Spend excludes one-off migration costs.

# The new deploy check

\`\`\`ts
export async function verifyDeploy(release: Release): Promise<Verdict> {
  const health = await probe(release.canary, { timeoutMs: 5_000 });
  if (health.errorRate > 0.01) return { ok: false, reason: "canary errors" };
  return { ok: true };
}
\`\`\`

The check runs on every canary before traffic shifts.

# What customers told us

> "The dashboard finally answers the question I actually have." — Operations lead, retail customer

> Notes: Read the quote aloud. Then mention we interviewed 18 customers.

---

Questions go to #platform-review, or email [the team](mailto:platform@example.com).

# Thank you
`;

describe("markdownToPptx: the package", () => {
  it("writes a complete 16:9 deck that passes every structural check", async () => {
    const bytes = await markdownToPptx(SHOWCASE, { author: "Avery Chen", modifiedAt: AT });
    const { pkg, presentation, slides } = await validatePptx(bytes);
    expect(pkg.text(presentation)).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
    expect(slides.length).toBe(8);
    const layouts = pkg.names().filter(name => name.startsWith("ppt/slideLayouts/") && name.endsWith(".xml"));
    expect(layouts.map(name => /type="([^"]+)"/.exec(pkg.text(name)!)?.[1])).toEqual(["title", "obj", "secHead", "twoObj", "twoTxTwoObj", "titleOnly", "blank", "picTx"]);
    expect(pkg.text("ppt/theme/theme1.xml")).toContain('typeface="Aptos"');
    for (const part of ["ppt/presProps.xml", "ppt/viewProps.xml", "ppt/tableStyles.xml", "docProps/core.xml", "docProps/app.xml", "ppt/notesMasters/notesMaster1.xml"]) {
      expect(pkg.has(part), part).toBe(true);
    }
    expect(pkg.text("docProps/core.xml")).toContain("<dc:title>Northwind Platform Review</dc:title>");
    expect(pkg.text("docProps/core.xml")).toContain("<dc:creator>Avery Chen</dc:creator>");
    expect(pkg.text("docProps/core.xml")).toContain("2026-10-01T09:30:00Z");
    expect(pkg.text("docProps/app.xml")).toContain("<Slides>8</Slides><Notes>2</Notes>");
  });

  it("is deterministic for the same input and time", async () => {
    const first = await markdownToPptx(SHOWCASE, { modifiedAt: AT });
    const second = await markdownToPptx(SHOWCASE, { modifiedAt: AT });
    expect(first).toEqual(second);
  });

  it("writes no notes master when no slide has notes, and no slide list for an empty deck", async () => {
    const { pkg, slides } = await validatePptx(await markdownToPptx("# Only\n\n- one"));
    expect(slides).toHaveLength(1);
    expect(pkg.names().some(name => name.includes("notesMaster"))).toBe(false);
    const empty = await validatePptx(await markdownToPptx(""));
    expect(empty.slides).toEqual([]);
    expect(empty.pkg.text(empty.presentation)).not.toContain("sldIdLst");
  });

  it("uses the option title over the first heading", async () => {
    const { pkg } = await validatePptx(await markdownToPptx("# Heading\n\ntext", { title: "Board <update> & plan" }));
    expect(pkg.text("docProps/core.xml")).toContain("<dc:title>Board &lt;update&gt; &amp; plan</dc:title>");
  });

  it("drops characters XML can't carry rather than writing a broken part", async () => {
    const { pkg, slides } = await validatePptx(await markdownToPptx("# Bad\u0001 title\n\n- a\u0008b \uD800 c"));
    expect(slideShapes(pkg, slides[0]!)).toEqual(["title: Bad title", "obj: ab  c", "sldNum: ‹#›"]);
  });
});

describe("markdownToPptx: the outline", () => {
  it("reads back through pptxToMarkdown with titles, nesting, formatting, tables, code and notes", async () => {
    const markdown = await read(await markdownToPptx(SHOWCASE));
    expect(markdown).toContain("## Slide 1: Northwind Platform Review\n\nQ3 2026 · Engineering leadership offsite");
    expect(markdown).toContain("## Slide 2: Where we are\n\nPlatform reliability is **ahead of plan** and costs are *down*.");
    expect(markdown).toContain("- Availability at **99.982%**, above the 99.95% target");
    expect(markdown).toContain("- Infra spend down 14% after the [storage migration](https://example.com/storage)\n  - Cold tier now holds 61% of bytes");
    expect(markdown).toContain("### Notes\n\nOpen with the availability number, then hand to Priya for costs.");
    expect(markdown).toContain("- Finish regional failover (October)\n- Ship the self-serve quota console\n  - Read-only view first");
    expect(markdown).toContain("~~in Q4~~");
    expect(markdown).toContain("**Decisions needed**");
    expect(markdown).toContain("☑ Approve failover budget");
    expect(markdown).toContain("| Metric | Q1 | Q2 | Q3 |");
    expect(markdown).toContain("| Infra spend | $4.1M | $3.8M | $3.5M |");
    expect(markdown).toContain("export async function verifyDeploy(release: Release): Promise\\<Verdict> {");
    expect(markdown).toContain("*\"The dashboard finally answers the question I actually have.\" — Operations lead, retail customer*");
    expect(markdown).toContain("[the team](mailto:platform@example.com)");
    expect(markdown).toMatch(/## Slide 7\n\nQuestions go to/);
    expect(markdown).toContain("## Slide 8: Thank you");
  });

  it("makes an opening heading with a short paragraph a title slide, on the title layout", async () => {
    const { pkg, slides } = await validatePptx(await markdownToPptx("# Launch plan\nMarketing, 2026\n\n# Goals\n\n- Grow"));
    expect(slideLayoutType(pkg, slides[0]!)).toBe("title");
    expect(slideShapes(pkg, slides[0]!)).toEqual(["ctrTitle: Launch plan", "subTitle: Marketing, 2026"]);
    expect(slideLayoutType(pkg, slides[1]!)).toBe("obj");
  });

  it("treats a lone top heading over deeper ones as the deck title, with slides at the next level", () => {
    const plans = planSlides(parseMarkdown("# Deck\nSubtitle\n\n## One\n\ntext\n\n### Detail\n\nmore\n\n## Two\n\n- x"));
    expect(plans.map(plan => [plan.kind, plan.title && plan.title.map(inline => inline.kind === "text" ? inline.text : "").join("")])).toEqual([
      ["title", "Deck"], ["content", "One"], ["content", "Two"],
    ]);
    expect(plans[1]!.body.map(block => block.kind)).toEqual(["paragraph", "heading", "paragraph"]);
  });

  it("starts slides at every heading of the top level when there are several", () => {
    const plans = planSlides(parseMarkdown("## A\n\n- a\n\n## B\n\n### sub\n\ntext"));
    expect(plans.map(plan => plan.kind)).toEqual(["content", "content"]);
  });

  it("splits on --- too, and gives a slide with no heading no title", async () => {
    const { pkg, slides } = await validatePptx(await markdownToPptx("First slide text\n\n---\n\n# Second\n\n- b\n\n---\n\nThird text"));
    expect(slides.map(slide => slideShapes(pkg, slide).filter(line => !line.startsWith("sldNum")))).toEqual([
      ["box: First slide text"], ["title: Second", "obj: b"], ["box: Third text"],
    ]);
    expect(slides.map(slide => slideLayoutType(pkg, slide))).toEqual(["blank", "obj", "blank"]);
  });

  it("puts a heading with no content on the Section Header layout", async () => {
    const { pkg, slides } = await validatePptx(await markdownToPptx("# Agenda\n\n- a\n\n# Break"));
    expect(slideLayoutType(pkg, slides[1]!)).toBe("secHead");
  });

  it("writes plain paragraphs unbulleted and list items with their levels", async () => {
    const { pkg, slides } = await validatePptx(await markdownToPptx("# S\n\nIntro\n\n- one\n  - two\n    - three"));
    const xml = pkg.text(slides[0]!)!;
    expect(xml).toContain('<a:pPr marL="0" indent="0"><a:buNone/></a:pPr><a:r><a:rPr lang="en-US" dirty="0"/><a:t>Intro</a:t>');
    expect(xml).toContain('<a:pPr lvl="1"/><a:r><a:rPr lang="en-US" dirty="0"/><a:t>two</a:t>');
    expect(xml).toContain('<a:pPr lvl="2"/>');
  });

  it("numbers ordered lists from where they start", async () => {
    const { pkg, slides } = await validatePptx(await markdownToPptx("# S\n\n3. c\n4. d"));
    expect(pkg.text(slides[0]!)).toContain('<a:buAutoNum type="arabicPeriod" startAt="3"/>');
    expect(pkg.text(slides[0]!)).toContain('<a:buAutoNum type="arabicPeriod" startAt="4"/>');
  });

  it("keeps an ordered list's start inside the 1..32767 that ST_TextBulletStartAtNum allows", async () => {
    const zero = await validatePptx(await markdownToPptx("# S\n\n0. a"));
    expect(zero.pkg.text(zero.slides[0]!)).toContain('<a:buAutoNum type="arabicPeriod"/>');
    const huge = await validatePptx(await markdownToPptx("# S\n\n40000. a"));
    expect(huge.pkg.text(huge.slides[0]!)).toContain('<a:buAutoNum type="arabicPeriod" startAt="32767"/>');
  });

  it("links through external hyperlink relationships, one per target", async () => {
    const { pkg, slides } = await validatePptx(await markdownToPptx("# S\n\n[a](https://example.com/x) and [b](https://example.com/x) and [c](javascript:alert(1))"));
    const links = pkg.relationships(slides[0]!).filter(relationship => relationship.type.endsWith("/hyperlink"));
    expect(links).toEqual([expect.objectContaining({ target: "https://example.com/x", external: true })]);
    expect(pkg.text(slides[0]!)!.match(/<a:hlinkClick /g)).toHaveLength(2);
  });

  it("writes code in a monospace box and tables as tables with a styled header row", async () => {
    const { pkg, slides } = await validatePptx(await markdownToPptx("# S\n\n```\nif (a) {\n  b();\n}\n```\n\n| A | B |\n|---|:-:|\n| 1 | 2 |"));
    const xml = pkg.text(slides[0]!)!;
    expect(xml).toContain('typeface="Consolas"');
    expect(xml).toContain("<a:t>  b();</a:t>");
    expect(xml).toContain('<a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId>');
    expect(xml).toContain('<a:pPr algn="ctr"/>');
    const widths = [...xml.matchAll(/<a:gridCol w="(\d+)"\/>/g)].map(match => Number(match[1]));
    const frame = /<p:graphicFrame>[\s\S]*?<a:ext cx="(\d+)"/.exec(xml);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(Number(frame![1]));
  });

  it("keeps speaker notes from a > Notes: quote, and nothing else", async () => {
    const bytes = await markdownToPptx("# S\n\n- a\n\n> Notes: say **this**\n>\n> - and this\n\n> A real quote");
    const { pkg, slides } = await validatePptx(bytes);
    const notes = pkg.relationships(slides[0]!).find(relationship => relationship.type.endsWith("/notesSlide"))!;
    const notesXml = pkg.text(pkg.target(slides[0]!, notes))!;
    expect(notesXml).toContain("<a:t>say </a:t>");
    expect(notesXml).toContain('b="1"');
    expect(notesXml).not.toContain("Notes:");
    expect(await read(bytes)).toContain("A real quote");
  });
});

describe("markdownToPptx: fitting content", () => {
  it("shrinks text that slightly overflows with autofit", async () => {
    const bullets = Array.from({ length: 9 }, (_, index) => `- Point number ${index + 1} explains one more consideration in some detail`).join("\n");
    const { pkg, slides } = await validatePptx(await markdownToPptx(`# Dense\n\n${bullets}`));
    expect(slides).toHaveLength(1);
    expect(pkg.text(slides[0]!)).toMatch(/<a:normAutofit fontScale="\d+"/);
  });

  it("continues long text on further slides", async () => {
    const bullets = Array.from({ length: 40 }, (_, index) => `- Item ${index + 1} with enough words to take most of a line on the slide`).join("\n");
    const bytes = await markdownToPptx(`# Long\n\n${bullets}`);
    const { pkg, slides } = await validatePptx(bytes);
    expect(slides.length).toBeGreaterThan(2);
    expect(slideShapes(pkg, slides[1]!)[0]).toBe("title: Long (continued)");
    const markdown = await read(bytes);
    for (let index = 1; index <= 40; index++) expect(markdown).toContain(`- Item ${index} with`);
  });

  it("splits a long table across slides, repeating its header", async () => {
    const rows = Array.from({ length: 30 }, (_, index) => `| Row ${index + 1} | ${index * 10} |`).join("\n");
    const bytes = await markdownToPptx(`# Table\n\n| Name | Value |\n|---|---|\n${rows}`);
    const { slides } = await validatePptx(bytes);
    expect(slides.length).toBeGreaterThan(1);
    const markdown = await read(bytes);
    expect(markdown.match(/\| Name \| Value \|/g)!.length).toBe(slides.length);
    expect(markdown).toContain("| Row 30 | 290 |");
  });

  it("splits long code across slides by lines", async () => {
    const code = Array.from({ length: 60 }, (_, index) => `line_${index + 1} = compute(${index})`).join("\n");
    const bytes = await markdownToPptx(`# Code\n\n\`\`\`py\n${code}\n\`\`\``);
    const { slides } = await validatePptx(bytes);
    expect(slides.length).toBeGreaterThan(1);
    const markdown = await read(bytes);
    expect(markdown).toContain("line_1 = compute(0)");
    expect(markdown).toContain("line_60 = compute(59)");
  });

  it("stacks mixed content without overlap", async () => {
    const { pkg, slides } = await validatePptx(await markdownToPptx("# Mixed\n\nIntro line\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter the table"));
    const xml = pkg.text(slides[0]!)!;
    const boxes = [...xml.matchAll(/<a:off x="\d+" y="(\d+)"\/><a:ext cx="\d+" cy="(\d+)"\/>/g)].map(match => [Number(match[1]), Number(match[2])] as const).filter(([, height]) => height > 0);
    expect(boxes.length).toBe(3);
    for (let index = 1; index < boxes.length; index++) expect(boxes[index]![0]).toBeGreaterThanOrEqual(boxes[index - 1]![0] + boxes[index - 1]![1]);
    expect(boxes.at(-1)![0] + boxes.at(-1)![1]).toBeLessThanOrEqual(1825625 + 4351338);
  });
});

describe("markdownToPptx with a template", () => {
  it("uses a PowerPoint-authored .potx's design and drops its slides, notes and media", async () => {
    const template = fixture("python-pptx-template.potx");
    const bytes = await markdownToPptx("# Plan\nFY27\n\n# Goals\n\n- Grow\n\n> Notes: remember\n\n# Close", { template, modifiedAt: AT });
    const { pkg, presentation, slides } = await validatePptx(bytes);
    expect(slides).toHaveLength(3);
    expect(pkg.contentType(presentation)).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml");
    expect(pkg.names().filter(name => name.startsWith("ppt/media/"))).toEqual([]);
    expect(pkg.names().filter(name => name.startsWith("ppt/notesSlides/") && name.endsWith(".xml"))).toHaveLength(1);
    const markdown = await read(bytes);
    expect(markdown).not.toContain("Template sample slide");
    expect(markdown).not.toContain("Template speaker notes");
    expect(markdown).toContain("## Slide 2: Goals\n\n- Grow\n\n### Notes\n\nremember");
    // The template's own layouts and its 4:3 size.
    expect(slides.map(slide => slideLayoutType(pkg, slide))).toEqual(["title", "obj", "secHead"]);
    expect(pkg.text(presentation)).toContain('<p:sldSz cx="9144000" cy="6858000"');
    expect(pkg.names().filter(name => name.startsWith("ppt/slideLayouts/") && name.endsWith(".xml"))).toHaveLength(11);
    expect(pkg.names().filter(name => name.startsWith("ppt/theme/"))).toHaveLength(2);
    expect(pkg.text(slides[1]!)).not.toContain("<p:spPr><a:xfrm>");
  });

  it("uses a deck as a template, keeping none of its charts, images or animations", async () => {
    const bytes = await markdownToPptx("# One\n\n- a", { template: fixture("python-pptx-deck.pptx") });
    const { pkg, slides } = await validatePptx(bytes);
    expect(slides).toHaveLength(1);
    expect(pkg.names().filter(name => /chart|media|embeddings|notesSlide/.test(name))).toEqual([]);
    expect(pkg.has("docProps/thumbnail.jpeg")).toBe(false);
  });

  it("refuses bytes that aren't a presentation", async () => {
    const workbook = fixture("openpyxl-rich.xlsx");
    await expect(markdownToPptx("# x", { template: workbook })).rejects.toThrow(/isn't a PowerPoint presentation/);
  });

  it("keeps a template's sections and custom shows from pointing at dropped slides", async () => {
    const pkg = await OpcPackage.open(fixture("python-pptx-template.potx"));
    const xml = pkg.text("ppt/presentation.xml")!;
    pkg.set("ppt/presentation.xml", xml.replace("</p:presentation>",
      '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">' +
      '<p14:section name="Intro" id="{11111111-2222-3333-4444-555555555555}"><p14:sldIdLst><p14:sldId id="256"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst></p:presentation>'));
    const { pkg: written, presentation } = await validatePptx(await markdownToPptx("# A\n\n- b", { template: await pkg.toBytes() }));
    expect(written.text(presentation)).not.toContain("sectionLst");
  });
});
