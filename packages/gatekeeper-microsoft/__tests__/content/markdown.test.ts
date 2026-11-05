import { describe, expect, it } from "vitest";
import { MarkdownWriter, escapeMarkdownText, renderTable, safeLinkTarget } from "../../src/content/markdown";

describe("escapeMarkdownText", () => {
  it.each([
    ["snake_case_name", "snake_case_name"],
    ["_leading and trailing_", "\\_leading and trailing\\_"],
    ["2 * 3 = 6", "2 * 3 = 6"],
    ["*emphasis*", "\\*emphasis\\*"],
    ["C:\\Users\\me", "C:\\Users\\me"],
    ["escape \\* sequence", "escape \\\\\\* sequence"],
    ["a < b and <div>", "a < b and \\<div>"],
    ["AT&T &amp; co", "AT&T \\&amp; co"],
    ["~5 minutes, ~~struck~~", "~5 minutes, \\~\\~struck\\~\\~"],
    ["[link](x)", "\\[link\\](x)"],
  ])("escapes %j as %j", (input, expected) => {
    expect(escapeMarkdownText(input)).toBe(expected);
  });
});

describe("safeLinkTarget", () => {
  it("keeps web and mail links, encoding characters that would end the destination", () => {
    expect(safeLinkTarget("https://example.com/a (b)")).toBe("https://example.com/a%20%28b%29");
    expect(safeLinkTarget("mailto:someone@example.com")).toBe("mailto:someone@example.com");
  });

  it.each(["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "vbscript:x", "not a url"])(
    "drops %j",
    target => {
      expect(safeLinkTarget(target)).toBeUndefined();
    },
  );
});

describe("renderTable", () => {
  it("pads short rows to the widest", () => {
    expect(renderTable([["a"], ["b", "c"]])).toBe("| a |  |\n| --- | --- |\n| b | c |");
  });

  it("caps the column count", () => {
    const header = renderTable([Array.from({ length: 1000 }, () => "x")]).split("\n")[0]!;
    expect(header.split(" | ")).toHaveLength(64);
  });

  it("stops adding rows past its budget", () => {
    const rows = Array.from({ length: 1000 }, (_, index) => [`row ${index}`]);
    expect(renderTable(rows, 100).split("\n").length).toBeLessThan(20);
  });
});

describe("MarkdownWriter", () => {
  it("joins list items tightly and other blocks with a blank line", () => {
    const writer = new MarkdownWriter();
    writer.push({ kind: "other", markdown: "Intro" });
    writer.push({ kind: "list-item", markdown: "- a" });
    writer.push({ kind: "list-item", markdown: "- b" });
    writer.push({ kind: "other", markdown: "Outro" });
    expect(writer.toString()).toBe("Intro\n\n- a\n- b\n\nOutro");
  });
});
