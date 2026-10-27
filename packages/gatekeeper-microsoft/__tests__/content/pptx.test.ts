import { describe, expect, it } from "vitest";
import { pptxToMarkdown } from "../../src/content/pptx";
import { buildPptx, shape, slideParagraph, type SlideFixture } from "./test-fixtures";

async function markdownOf(slides: readonly SlideFixture[], order?: readonly number[]): Promise<string> {
  return (await pptxToMarkdown(await buildPptx(slides, order))).markdown;
}

const title = (text: string) => shape('<p:ph type="title"/>', slideParagraph(text));
const body = (paragraphs: string) => shape('<p:ph idx="1"/>', paragraphs);

describe("pptxToMarkdown", () => {
  it("renders slides in presentation order, not part-name order", async () => {
    const markdown = await markdownOf([
      { shapes: title("Written first") },
      { shapes: title("Written second") },
      { shapes: title("Written third") },
    ], [2, 0, 1]);
    expect(markdown).toBe("## Slide 1: Written third\n\n## Slide 2: Written first\n\n## Slide 3: Written second");
  });

  it("renders a slide once however many times the slide list names it", async () => {
    const markdown = await markdownOf([{ shapes: title("Once") }], Array<number>(50).fill(0));
    expect(markdown).toBe("## Slide 1: Once");
  });

  it("renders body placeholders as bullets nested by paragraph level", async () => {
    const markdown = await markdownOf([{
      shapes: title("Plan") + body(
        slideParagraph("Goals") + slideParagraph("Ship it", 'lvl="1"') + slideParagraph("Deep", 'lvl="3"') + slideParagraph("Budget"),
      ),
    }]);
    expect(markdown).toBe("## Slide 1: Plan\n\n- Goals\n  - Ship it\n    - Deep\n- Budget");
  });

  it("renders text boxes as paragraphs unless a paragraph asks for a bullet", async () => {
    const markdown = await markdownOf([{
      shapes: shape("", slideParagraph("Free text") + '<a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>Bulleted</a:t></a:r></a:p>')
        + body('<a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>Unbulleted body</a:t></a:r></a:p>'),
    }]);
    expect(markdown).toBe("## Slide 1\n\nFree text\n\n- Bulleted\n\nUnbulleted body");
  });

  it("uses the centred title and subtitle, and skips date, footer and slide number placeholders", async () => {
    const markdown = await markdownOf([{
      shapes: shape('<p:ph type="ctrTitle"/>', slideParagraph("Quarterly") + slideParagraph("Review"))
        + shape('<p:ph type="subTitle" idx="1"/>', slideParagraph("October"))
        + shape('<p:ph type="dt" idx="10"/>', slideParagraph("10/17/2026"))
        + shape('<p:ph type="ftr" idx="11"/>', slideParagraph("Confidential"))
        + shape('<p:ph type="sldNum" idx="12"/>', slideParagraph("1")),
    }]);
    expect(markdown).toBe("## Slide 1: Quarterly Review\n\nOctober");
  });

  it("adds speaker notes under a Notes heading", async () => {
    const markdown = await markdownOf([
      { shapes: title("With notes"), notes: slideParagraph("Mention the budget.") + slideParagraph("Then pause.") },
      { shapes: title("Without") },
    ]);
    expect(markdown).toBe("## Slide 1: With notes\n\n### Notes\n\nMention the budget.\n\nThen pause.\n\n## Slide 2: Without");
  });

  it("marks hidden slides", async () => {
    expect(await markdownOf([{ shapes: title("Backup"), hidden: true }])).toBe("## Slide 1: Backup (hidden)");
  });

  it("renders formatting and external hyperlinks", async () => {
    const markdown = await markdownOf([{
      relationships: [{ id: "rIdLink", type: "hyperlink", target: "https://example.com/", external: true }],
      shapes: shape("", '<a:p><a:r><a:rPr b="1"/><a:t>Bold</a:t></a:r><a:r><a:rPr/><a:t> and </a:t></a:r>'
        + '<a:r><a:rPr i="1"><a:hlinkClick r:id="rIdLink"/></a:rPr><a:t>a link</a:t></a:r><a:br/><a:r><a:t>next line</a:t></a:r></a:p>'),
    }]);
    expect(markdown).toBe("## Slide 1\n\n**Bold** and [*a link*](https://example.com/)\nnext line");
  });

  it("renders tables, with merged positions left empty", async () => {
    const cell = (text: string, attributes = "") => `<a:tc ${attributes}><a:txBody><a:bodyPr/>${slideParagraph(text)}</a:txBody></a:tc>`;
    const table = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/></p:nvGraphicFramePr><a:graphic>'
      + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>'
      + `<a:tr>${cell("Metric", 'gridSpan="2"')}${cell("", 'hMerge="1"')}</a:tr>`
      + `<a:tr>${cell("Revenue")}${cell("1 | 2")}</a:tr>`
      + "</a:tbl></a:graphicData></a:graphic></p:graphicFrame>";
    expect(await markdownOf([{ shapes: table }])).toBe("## Slide 1\n\n| Metric |  |\n| --- | --- |\n| Revenue | 1 \\| 2 |");
  });

  it("renders pictures inside groups as image placeholders", async () => {
    const picture = '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group"/></p:nvGrpSpPr>'
      + '<p:pic><p:nvPicPr><p:cNvPr id="6" name="Picture" descr="Team photo"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill></p:pic></p:grpSp>';
    const markdown = await markdownOf([{ shapes: picture, relationships: [{ id: "rIdImg", type: "image", target: "../media/image1.jpeg" }] }]);
    expect(markdown).toBe("## Slide 1\n\n![Team photo](ppt/media/image1.jpeg)");
  });

  it("stops at the output budget", async () => {
    const slides = Array.from({ length: 200 }, (_, index) => ({ shapes: title(`Slide title ${index}`) }));
    const result = await pptxToMarkdown(await buildPptx(slides), { maxChars: 300 });
    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThan(400);
  });
});
