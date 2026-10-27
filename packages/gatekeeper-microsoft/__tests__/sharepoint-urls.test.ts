import { describe, expect, it } from "vitest";
import {
  allUrl, isAllUrl, isSitePagesUrl, isSiteRootPath, normalizeForShares, parseSharePointHost, parseSharePointUrl, shareIdFor,
  sitePathCandidates,
} from "../src/sharepoint-urls";

const url = (raw: string) => new URL(raw);

describe("parseSharePointHost", () => {
  it.each([
    ["contoso.sharepoint.com", { tenant: "contoso", personal: false }],
    ["CONTOSO.SharePoint.com", { tenant: "contoso", personal: false }],
    ["contoso-my.sharepoint.com", { tenant: "contoso", personal: true }],
    // A greedy tenant match would swallow "-my" and read OneDrive links as another tenant.
    ["gatekeeperinc-my.sharepoint.com", { tenant: "gatekeeperinc", personal: true }],
    ["a.sharepoint.com", { tenant: "a", personal: false }],
  ])("reads %s", (host, expected) => {
    expect(parseSharePointHost(host)).toEqual(expected);
  });

  it("keeps a hyphenated host that isn't the OneDrive host as its own tenant", () => {
    expect(parseSharePointHost("contoso-admin.sharepoint.com")).toEqual({ tenant: "contoso-admin", personal: false });
  });

  it.each([
    "sharepoint.com",
    "contoso.sharepoint.com.evil.example",
    "contoso.sharepoint.cn",
    "contoso.sharepoint-df.com",
    "sites.contoso.sharepoint.com",
    "-contoso.sharepoint.com",
    "contoso-.sharepoint.com",
    "-my.sharepoint.com",
    "graph.microsoft.com",
  ])("refuses %s", host => {
    expect(parseSharePointHost(host)).toBeNull();
  });
});

describe("parseSharePointUrl", () => {
  it("accepts a SharePoint link, trimming it and dropping the fragment", () => {
    const parsed = parseSharePointUrl("  https://contoso.sharepoint.com/sites/Eng/Shared%20Documents?web=1#top  ");
    expect(parsed?.href).toBe("https://contoso.sharepoint.com/sites/Eng/Shared%20Documents?web=1");
  });

  it("accepts the explicit default port", () => {
    expect(parseSharePointUrl("https://contoso.sharepoint.com:443/sites/Eng")).not.toBeNull();
  });

  it.each([
    "http://contoso.sharepoint.com/sites/Eng",
    "https://user:pass@contoso.sharepoint.com/sites/Eng",
    "https://user@contoso.sharepoint.com/sites/Eng",
    "https://contoso.sharepoint.com:8443/sites/Eng",
    "https://example.com/sites/Eng",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("refuses %s", raw => {
    expect(parseSharePointUrl(raw)).toBeNull();
  });
});

describe("the URL of everything", () => {
  it("is the start page, recognized on either host and in any case", () => {
    expect(allUrl("contoso")).toBe("https://contoso.sharepoint.com/_layouts/15/sharepoint.aspx");
    expect(isAllUrl(url(allUrl("contoso")))).toBe(true);
    expect(isAllUrl(url("https://contoso-my.sharepoint.com/_layouts/15/SharePoint.aspx?v=following"))).toBe(true);
  });

  it("is not a site's own start page or a look-alike", () => {
    expect(isAllUrl(url("https://contoso.sharepoint.com/sites/Eng/_layouts/15/sharepoint.aspx"))).toBe(false);
    expect(isAllUrl(url("https://contoso.sharepoint.com/_layouts/15/sharepoint.aspxx"))).toBe(false);
  });
});

describe("isSiteRootPath", () => {
  it.each([
    "https://contoso.sharepoint.com",
    "https://contoso.sharepoint.com/",
    "https://contoso.sharepoint.com/sites/Eng",
    "https://contoso.sharepoint.com/sites/Eng/",
    "https://contoso.sharepoint.com/teams/Ops",
    "https://contoso-my.sharepoint.com/personal/sarah_contoso_com",
  ])("%s can only be a site", raw => {
    expect(isSiteRootPath(url(raw))).toBe(true);
  });

  it.each([
    "https://contoso.sharepoint.com/sites/Eng/Shared%20Documents",
    "https://contoso.sharepoint.com/sites",
    "https://contoso.sharepoint.com/sites/Eng?id=%2Fsites%2FEng%2FShared%20Documents",
    "https://contoso.sharepoint.com/Shared%20Documents",
  ])("%s may be something else", raw => {
    expect(isSiteRootPath(url(raw))).toBe(false);
  });
});

describe("normalizeForShares", () => {
  const folder = "/sites/Eng/Shared Documents/Specs (2026)";
  const once = encodeURIComponent(folder);
  const base = "https://contoso.sharepoint.com/sites/Eng/Shared%20Documents/Forms/AllItems.aspx";

  it.each([
    ["decoded", folder.replace(/ /g, "+")],
    ["encoded once", once],
    ["encoded twice", encodeURIComponent(once)],
  ])("applies exactly one round of encoding to a folder id %s", (_, id) => {
    const normalized = normalizeForShares(url(`${base}?id=${id}`));
    expect(normalized).toBe(`${base}?id=${once}`);
  });

  it("keeps the parameters that name a document and drops the ones that only steer the view", () => {
    const normalized = normalizeForShares(url(
      "https://contoso.sharepoint.com/:w:/r/sites/Eng/_layouts/15/Doc.aspx?sourcedoc=%7BABC%7D&file=Brief.docx&action=default&mobileredirect=true&d=w123"));
    expect(normalized).toBe("https://contoso.sharepoint.com/:w:/r/sites/Eng/_layouts/15/Doc.aspx?sourcedoc=%7BABC%7D&file=Brief.docx&d=w123");
  });

  it("drops a query that holds nothing but view parameters", () => {
    expect(normalizeForShares(url("https://contoso.sharepoint.com/sites/Eng/Shared%20Documents/a.docx?web=1&csf=1")))
      .toBe("https://contoso.sharepoint.com/sites/Eng/Shared%20Documents/a.docx");
  });
});

describe("shareIdFor", () => {
  it("is u! plus the unpadded base64url of the URL", () => {
    // Microsoft's documented example.
    expect(shareIdFor("https://onedrive.live.com/redir?resid=1231244193912!12&authKey=1201919!12921!1"))
      .toBe("u!aHR0cHM6Ly9vbmVkcml2ZS5saXZlLmNvbS9yZWRpcj9yZXNpZD0xMjMxMjQ0MTkzOTEyITEyJmF1dGhLZXk9MTIwMTkxOSExMjkyMSEx");
  });

  it("encodes UTF-8 and never emits + / or =", () => {
    const id = shareIdFor("https://contoso.sharepoint.com/sites/Eng/Shared Documents/Café ?>?.docx");
    expect(id).toMatch(/^u![A-Za-z0-9_-]+$/);
    const base64 = id.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), char => char.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe("https://contoso.sharepoint.com/sites/Eng/Shared Documents/Café ?>?.docx");
  });
});

describe("sitePathCandidates", () => {
  it("tries the longest site path first, down to the site collection", () => {
    expect(sitePathCandidates(url("https://contoso.sharepoint.com/sites/Eng/Sub/Deeper/Shared%20Documents/x.docx")))
      .toEqual(["/sites/Eng/Sub/Deeper", "/sites/Eng/Sub", "/sites/Eng"]);
  });

  it("stops at the segments SharePoint reserves for things that aren't webs", () => {
    expect(sitePathCandidates(url("https://contoso.sharepoint.com/sites/Eng/Lists/Issues/AllItems.aspx"))).toEqual(["/sites/Eng"]);
    expect(sitePathCandidates(url("https://contoso.sharepoint.com/sites/Eng/SitePages/Home.aspx"))).toEqual(["/sites/Eng"]);
    expect(sitePathCandidates(url("https://contoso.sharepoint.com/sites/Eng/_layouts/15/viewlsts.aspx"))).toEqual(["/sites/Eng"]);
  });

  it("falls back to the host root for a path outside a managed path", () => {
    expect(sitePathCandidates(url("https://contoso.sharepoint.com/Shared%20Documents/a.docx"))).toEqual(["/"]);
    expect(sitePathCandidates(url("https://contoso.sharepoint.com/Team/Shared%20Documents"))).toEqual(["/Team", "/"]);
    expect(sitePathCandidates(url("https://contoso.sharepoint.com/"))).toEqual(["/"]);
  });

  it("treats a OneDrive's personal path as its site", () => {
    expect(sitePathCandidates(url("https://contoso-my.sharepoint.com/personal/sarah_contoso_com/Documents/a.txt")))
      .toEqual(["/personal/sarah_contoso_com/Documents/a.txt", "/personal/sarah_contoso_com/Documents", "/personal/sarah_contoso_com"]);
  });
});

describe("isSitePagesUrl", () => {
  it("recognizes a page, encoded or not", () => {
    expect(isSitePagesUrl(url("https://contoso.sharepoint.com/sites/Eng/SitePages/Launch-Plan.aspx"))).toBe(true);
    expect(isSitePagesUrl(url("https://contoso.sharepoint.com/sites/Eng/sitepages/Launch%20Plan.aspx"))).toBe(true);
  });

  it("refuses the library view and other pages", () => {
    expect(isSitePagesUrl(url("https://contoso.sharepoint.com/sites/Eng/SitePages/Forms/ByAuthor.aspx"))).toBe(false);
    expect(isSitePagesUrl(url("https://contoso.sharepoint.com/sites/Eng/Shared%20Documents/x.aspx"))).toBe(false);
  });
  it("answers for a path with a stray percent sign rather than throwing", () => {
    expect(isSitePagesUrl(url("https://contoso.sharepoint.com/sites/Eng/SitePages/100%done.aspx"))).toBe(true);
  });
});
