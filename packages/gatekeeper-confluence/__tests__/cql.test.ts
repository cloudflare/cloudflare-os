import { describe, expect, it } from "vite-plus/test";
import { ConfluenceApiError, attachmentBelongsToContent, buildCql } from "../src/confluence-api";

describe("buildCql", () => {
  it("returns a raw cql query verbatim (takes precedence over text)", () => {
    expect(buildCql({ cql: "label = urgent", text: "ignored" })).toBe("label = urgent");
  });

  it("builds a text search clause with the ~ operator and quoting", () => {
    expect(buildCql({ text: "release notes" })).toBe('text ~ "release notes"');
  });

  it("escapes embedded quotes and backslashes in text", () => {
    expect(buildCql({ text: 'say "hi"\\bye' })).toBe('text ~ "say \\"hi\\"\\\\bye"');
  });

  it("ANDs a type filter", () => {
    expect(buildCql({ text: "foo", type: "blogpost" }))
      .toBe('type = blogpost AND text ~ "foo"');
  });

  it("ANDs a space filter with quoting", () => {
    expect(buildCql({ text: "foo", spaceKey: "ENG" }))
      .toBe('space = "ENG" AND text ~ "foo"');
  });

  it("combines type + space + text", () => {
    expect(buildCql({ text: "foo", type: "page", spaceKey: "ENG" }))
      .toBe('type = page AND space = "ENG" AND text ~ "foo"');
  });

  it("falls back to a default browse query when nothing is specified", () => {
    expect(buildCql({})).toBe("type in (page, blogpost) order by lastmodified desc");
  });

  it("rejects raw cql on a space-scoped query (cannot be safely constrained to the space)", () => {
    expect(() => buildCql({ cql: "type = page", spaceKey: "ENG" })).toThrow(ConfluenceApiError);
  });

  it("always constrains a space-scoped text/type query to the space", () => {
    expect(buildCql({ text: "foo", spaceKey: "ENG" })).toBe('space = "ENG" AND text ~ "foo"');
    expect(buildCql({ spaceKey: "ENG" })).toBe('space = "ENG"');
  });
});

describe("attachmentBelongsToContent", () => {
  it("is true only when the attachment's container id matches the content id", () => {
    expect(attachmentBelongsToContent({ id: "a", title: "f", pageId: "123" }, "123")).toBe(true);
    expect(attachmentBelongsToContent({ id: "a", title: "f", blogPostId: "123" }, "123")).toBe(true);
    expect(attachmentBelongsToContent({ id: "a", title: "f", pageId: "999" }, "123")).toBe(false);
    expect(attachmentBelongsToContent({ id: "a", title: "f" }, "123")).toBe(false);
  });
});
