import { describe, expect, it } from "vite-plus/test";
import {
  classifyConfluenceUrl,
  parseConfluenceContentId,
  parseSpaceKeyOrId,
  ConfluenceApiError,
} from "../src/confluence-api";

describe("classifyConfluenceUrl", () => {
  it("classifies a page URL with space + numeric id", () => {
    expect(classifyConfluenceUrl("https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/Page+Title"))
      .toEqual({ kind: "content", host: "acme.atlassian.net", contentId: "12345", spaceKey: "ENG" });
  });

  it("classifies a page URL without a trailing slug", () => {
    expect(classifyConfluenceUrl("https://acme.atlassian.net/wiki/spaces/ENG/pages/98765"))
      .toEqual({ kind: "content", host: "acme.atlassian.net", contentId: "98765", spaceKey: "ENG" });
  });

  it("classifies a blog post URL (id is the last numeric path segment)", () => {
    expect(classifyConfluenceUrl("https://acme.atlassian.net/wiki/spaces/NEWS/blog/2024/01/02/55667/Hello-World"))
      .toEqual({ kind: "content", host: "acme.atlassian.net", contentId: "55667", spaceKey: "NEWS" });
  });

  it("classifies a legacy viewpage.action?pageId= URL", () => {
    expect(classifyConfluenceUrl("https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=424242"))
      .toEqual({ kind: "content", host: "acme.atlassian.net", contentId: "424242" });
  });

  it("classifies a space URL", () => {
    expect(classifyConfluenceUrl("https://acme.atlassian.net/wiki/spaces/ENG"))
      .toEqual({ kind: "space", host: "acme.atlassian.net", spaceKey: "ENG" });
  });

  it("classifies a space overview URL as a space", () => {
    expect(classifyConfluenceUrl("https://acme.atlassian.net/wiki/spaces/ENG/overview"))
      .toEqual({ kind: "space", host: "acme.atlassian.net", spaceKey: "ENG" });
  });

  it("classifies the site root and /wiki as a site", () => {
    expect(classifyConfluenceUrl("https://acme.atlassian.net/wiki"))
      .toEqual({ kind: "site", host: "acme.atlassian.net" });
    expect(classifyConfluenceUrl("https://acme.atlassian.net"))
      .toEqual({ kind: "site", host: "acme.atlassian.net" });
    expect(classifyConfluenceUrl("https://acme.atlassian.net/wiki/home"))
      .toEqual({ kind: "site", host: "acme.atlassian.net" });
  });

  it("throws on a non-URL", () => {
    expect(() => classifyConfluenceUrl("not a url")).toThrow();
  });
});

describe("parseConfluenceContentId", () => {
  it("returns a bare numeric id unchanged", () => {
    expect(parseConfluenceContentId("12345")).toBe("12345");
  });

  it("extracts the id from a page URL", () => {
    expect(parseConfluenceContentId("https://acme.atlassian.net/wiki/spaces/ENG/pages/777/Title"))
      .toBe("777");
  });

  it("throws when a URL has no content id", () => {
    expect(() => parseConfluenceContentId("https://acme.atlassian.net/wiki/spaces/ENG"))
      .toThrow(ConfluenceApiError);
  });
});

describe("parseSpaceKeyOrId", () => {
  it("returns a bare key as { key }", () => {
    expect(parseSpaceKeyOrId("ENG")).toEqual({ key: "ENG" });
  });

  it("returns a bare numeric id as { id }", () => {
    expect(parseSpaceKeyOrId("262145")).toEqual({ id: "262145" });
  });

  it("extracts the key from a space URL", () => {
    expect(parseSpaceKeyOrId("https://acme.atlassian.net/wiki/spaces/ENG/overview"))
      .toEqual({ key: "ENG" });
  });
});
