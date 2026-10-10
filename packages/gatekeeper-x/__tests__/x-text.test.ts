import { describe, expect, it } from "vitest";
import { comparableText, comparableUrl, extractMentions, extractUrls, weightedLength } from "../src/x-text";

describe("weightedLength", () => {
  it("counts Latin text one per character", () => {
    expect(weightedLength("hello")).toBe(5);
    expect(weightedLength("a".repeat(280))).toBe(280);
  });

  it("counts every link as 23, however long", () => {
    expect(weightedLength("see https://example.com/a/very/long/path?with=query&and=more")).toBe(4 + 23);
    expect(weightedLength("https://a.co")).toBe(23);
    expect(weightedLength("visit example.com today")).toBe(6 + 23 + 6);
  });

  it("counts CJK and most other scripts as two", () => {
    expect(weightedLength("日本語")).toBe(6);
    expect(weightedLength("한국어")).toBe(6);
  });

  it("counts an emoji as two, whatever it is built from", () => {
    expect(weightedLength("👍")).toBe(2);
    expect(weightedLength("👍🏽")).toBe(2);
    expect(weightedLength("👨‍👩‍👧‍👦")).toBe(2);
    expect(weightedLength("🇺🇸")).toBe(2);
  });

  it("counts typographic punctuation as one", () => {
    expect(weightedLength("“quoted” — ‘ok’")).toBe(15);
  });

  it("normalizes to NFC first", () => {
    expect(weightedLength("e\u0301")).toBe(1);
  });
});

describe("extraction", () => {
  it("finds links as written, without trailing punctuation", () => {
    expect(extractUrls("Read https://example.com/x. And foo.io!")).toEqual(["https://example.com/x", "foo.io"]);
    expect(extractUrls("no links here")).toEqual([]);
  });

  it("finds no domain DNS couldn't hold", () => {
    expect(extractUrls(`${"a".repeat(63)}.com`)).toEqual([`${"a".repeat(63)}.com`]);
    expect(extractUrls(`${"a".repeat(64)}.com`)).toEqual([]);
  });

  it("weighs long drafts in time linear in their length", () => {
    // Each took seconds when a failed match could backtrack across the whole run.
    for (const text of ["a.".repeat(50_000), "a-".repeat(50_000), `https://x.co/${".".repeat(100_000)}a`]) {
      const started = performance.now();
      weightedLength(text);
      comparableText(text);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it("finds mentions, once each, ignoring email addresses", () => {
    expect(extractMentions("@jack hi @Jack, mail me at a@b.com or ask @bob_1")).toEqual(["jack", "bob_1"]);
    expect(extractMentions("@@double @this_handle_is_too_long")).toEqual([]);
  });
});

describe("comparableText", () => {
  it("equates a draft with the post X made of it", () => {
    expect(comparableText("Hello https://example.com/page world"))
      .toBe(comparableText("Hello  https://t.co/AbCdEf   world"));
  });

  it("tells different texts apart", () => {
    expect(comparableText("Hello world")).not.toBe(comparableText("Hello there"));
  });
});

describe("comparableUrl", () => {
  it("equates a link as written with X's record of it", () => {
    expect(comparableUrl("example.com")).toBe(comparableUrl("http://example.com"));
    expect(comparableUrl("https://Example.COM/Path/")).toBe(comparableUrl("example.com/Path"));
  });

  it("tells different destinations apart", () => {
    expect(comparableUrl("https://example.com/a")).not.toBe(comparableUrl("https://example.com/b"));
    expect(comparableUrl("https://example.com/Path")).not.toBe(comparableUrl("https://example.com/path"));
  });
});
