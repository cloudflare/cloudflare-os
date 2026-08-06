import { describe, expect, it } from "vite-plus/test";
import {
  contentToMetadata,
  contentToSummary,
  cursorFromNext,
  spaceKeyFromWebui,
  type ContentResponse,
} from "../src/confluence-api";

const WEB_BASE = "https://acme.atlassian.net/wiki";

describe("spaceKeyFromWebui", () => {
  it("extracts the space key from a v2 webui link", () => {
    expect(spaceKeyFromWebui("/spaces/ENG/pages/123/Title")).toBe("ENG");
  });

  it("returns undefined when there is no space segment", () => {
    expect(spaceKeyFromWebui("/pages/123")).toBeUndefined();
    expect(spaceKeyFromWebui(undefined)).toBeUndefined();
  });
});

describe("cursorFromNext", () => {
  it("extracts the opaque cursor from a v2 _links.next relative URL", () => {
    expect(cursorFromNext("/wiki/api/v2/pages?limit=25&cursor=abc123")).toBe("abc123");
  });

  it("returns undefined when there is no next link or cursor", () => {
    expect(cursorFromNext(undefined)).toBeUndefined();
    expect(cursorFromNext("/wiki/api/v2/pages?limit=25")).toBeUndefined();
  });
});

describe("contentToSummary (v2 shape)", () => {
  const page: ContentResponse = {
    id: "123",
    type: "page",
    status: "current",
    title: "Release Notes",
    spaceId: "9001",
    authorId: "acc-1",
    createdAt: "2024-01-02T03:04:05Z",
    version: { number: 4, createdAt: "2024-02-02T03:04:05Z", authorId: "acc-2" },
    _links: { webui: "/spaces/ENG/pages/123/Release-Notes" },
  };

  it("maps id/type/title/status and derives the space key + public URL from webui", () => {
    const s = contentToSummary(page, WEB_BASE);
    expect(s).toMatchObject({ id: "123", type: "page", title: "Release Notes", status: "current", spaceKey: "ENG" });
    expect(s.url).toBe("https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Release-Notes");
    expect(s.createdAt).toEqual(new Date("2024-01-02T03:04:05Z"));
    expect(s.lastUpdatedAt).toEqual(new Date("2024-02-02T03:04:05Z"));
  });

  it("omits timestamps when the response has none", () => {
    const s = contentToSummary({ id: "1", type: "page", title: "T", _links: {} }, WEB_BASE);
    expect(s.createdAt).toBeUndefined();
    expect(s.lastUpdatedAt).toBeUndefined();
  });

  it("exposes version and account-id-only author refs in metadata", () => {
    const m = contentToMetadata(page, WEB_BASE);
    expect(m.version).toBe(4);
    expect(m.author).toEqual({ accountId: "acc-1" });
    expect(m.lastUpdatedBy).toEqual({ accountId: "acc-2" });
    expect(m.createdAt).toEqual(new Date("2024-01-02T03:04:05Z"));
  });
});
