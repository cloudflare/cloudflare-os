import { describe, expect, it } from "vitest";
import { fileIcon, formatDate, formatSize, parseRef } from "../src/sharepoint-configurator";

const SITE = "contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,33333333-3333-3333-3333-333333333333";
const GUID = "44444444-4444-4444-4444-444444444444";
const DRIVE = "b!AAAAAAAAAAAAAAAAAAAA";

describe("parseRef", () => {
  it.each([
    ["all", { kind: "all" }],
    [`site:${SITE}`, { kind: "site", siteId: SITE }],
    [`pages:${SITE}`, { kind: "pages", siteId: SITE }],
    [`drive:${DRIVE}`, { kind: "drive", driveId: DRIVE }],
    [`folder:${DRIVE}/01ABC!12`, { kind: "folder", driveId: DRIVE, itemId: "01ABC!12" }],
    [`file:${DRIVE}/01ABC`, { kind: "file", driveId: DRIVE, itemId: "01ABC" }],
    [`list:${SITE}/${GUID}`, { kind: "list", siteId: SITE, listId: GUID }],
    [`page:${SITE}/${GUID}`, { kind: "page", siteId: SITE, pageId: GUID }],
  ])("reads %s", (ref, expected) => {
    expect(parseRef(ref)).toEqual(expected);
  });

  it.each([
    "", "everything", "all:", "site", "site:", "site:x/y", `site:${SITE}/extra`, "folder:../../me", `folder:${DRIVE}`,
    `folder:${DRIVE}/`, `folder:${DRIVE}/01/02`, `folder:${DRIVE}/..`, `folder:${DRIVE}/a b`, `file:${DRIVE}/01?x=1`,
    `drive:${DRIVE}/root`, "drive:root", `list:${SITE}`, `list:${SITE}/not-a-guid`, `list:${SITE}/${GUID}/items`,
    `page:${SITE}/${GUID}/x`, `onedrive:${DRIVE}`, `item:${DRIVE}/01`, `${SITE}`,
  ])("refuses %j, which would put more than an ID into a Graph path", ref => {
    expect(() => parseRef(ref)).toThrow("That choice isn't valid. Choose again.");
  });
});

describe("fileIcon", () => {
  it.each([
    ["Brief.DOCX", "document"],
    ["budget.xlsx", "spreadsheet"],
    ["roster.csv", "spreadsheet"],
    ["deck.pptx", "presentation"],
    ["scan.pdf", "pdf"],
    ["photo.HEIC", "image"],
    ["clip.mov", "video"],
    ["memo.m4a", "audio"],
    ["bundle.tgz", "archive"],
    ["notes.md", "text"],
    ["config.yaml", "code"],
    ["Makefile", "file"],
    [".gitignore", "file"],
  ])("%s is a %s", (name, icon) => {
    expect(fileIcon(name)).toBe(icon);
  });
});

describe("formatSize", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [1536, "1.5 KB"],
    [10 * 1024, "10 KB"],
    [1024 * 1024 - 1, "1024 KB"],
    [1024 * 1024, "1 MB"],
    [5.25 * 1024 * 1024 * 1024, "5.3 GB"],
    [3 * 1024 ** 5, "3072 TB"],
  ])("%i bytes reads as %s", (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });
});

describe("formatDate", () => {
  const now = new Date("2026-10-17T12:00:00Z");

  it("leaves out this year's year, and reads in UTC", () => {
    expect(formatDate("2026-03-04T23:30:00Z", now)).toBe("Mar 4");
    expect(formatDate("2026-12-31T23:59:59Z", now)).toBe("Dec 31");
  });

  it("includes another year's year", () => {
    expect(formatDate("2024-03-04T00:00:00Z", now)).toBe("Mar 4, 2024");
  });

  it("says nothing for a missing or unreadable date", () => {
    expect(formatDate(undefined, now)).toBeUndefined();
    expect(formatDate("yesterday", now)).toBeUndefined();
  });
});
