import { describe, expect, it } from "vitest";
import { comparableText, comparableUrl, duplicateKey, extractMentions, extractUrls, weightedLength, withoutLeadingMentions } from "../src/x-text";

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

  it("keeps a long dotted draft as text rather than a link", () => {
    const text = "a.".repeat(50_000);
    expect(extractUrls(text)).toEqual([]);
    expect(weightedLength(text)).toBe(100_000);
    expect(comparableText(text)).toBe(text);
  });

  it("counts a long URL as one link and keeps its trailing sentence punctuation", () => {
    const url = `https://x.co/${".".repeat(100_000)}a`;
    const text = `${url}.`;
    expect(extractUrls(text)).toEqual([url]);
    expect(weightedLength(text)).toBe(24);
    expect(comparableText(text)).toBe(".");
  });

  it("finds mentions, once each, ignoring email addresses", () => {
    expect(extractMentions("@jack hi @Jack, mail me at a@b.com or ask @bob_1")).toEqual(["jack", "bob_1"]);
    expect(extractMentions("@@double @this_handle_is_too_long")).toEqual([]);
  });
});

describe("withoutLeadingMentions", () => {
  it("drops the run of handles X leads a reply with, and nothing after it", () => {
    expect(withoutLeadingMentions("@bob @carol Agreed, @dave")).toBe("Agreed, @dave");
    expect(withoutLeadingMentions("Agreed")).toBe("Agreed");
  });
});

describe("comparableText", () => {
  it("keeps a closing parenthesis the link opened, as X's parser does", () => {
    const link = "https://en.wikipedia.org/wiki/Primer_(film)";
    expect(extractUrls(`Read ${link}`)).toEqual([link]);
    expect(extractUrls(`(see ${link}).`)).toEqual([link]);
    expect(extractUrls("(see https://example.com/a), then")).toEqual(["https://example.com/a"]);
    expect(comparableText(`Read ${link}`)).toBe(comparableText("Read https://t.co/AbCdEf"));
  });

  it("takes a query straight after a bare domain as part of the link, as X does", () => {
    expect(extractUrls("Read example.com?q=one")).toEqual(["example.com?q=one"]);
    expect(extractUrls("See example.com?q=one.")).toEqual(["example.com?q=one"]);
    expect(comparableText("Read example.com?q=one")).toBe(comparableText("Read https://t.co/AbCdEf"));
    expect(comparableUrl("EXAMPLE.com?q=One")).toBe("example.com?q=One");
  });

  it("keeps the punctuation after a link, however the link was written", () => {
    expect(comparableText("Visit example.com.")).toBe(comparableText("Visit https://t.co/AbCdEf."));
    expect(comparableText("See (https://example.com/a), then")).toBe(comparableText("See (https://t.co/x), then"));
  });

  it("equates a draft with the post X made of it", () => {
    expect(comparableText("Hello https://example.com/page world"))
      .toBe(comparableText("Hello  https://t.co/AbCdEf   world"));
  });

  it("tells different texts apart", () => {
    expect(comparableText("Hello world")).not.toBe(comparableText("Hello there"));
  });
});

describe("duplicateKey", () => {
  it("equates drafts X would take for the same post", () => {
    expect(duplicateKey("Same  words\n")).toBe(duplicateKey("Same words"));
  });

  it("tells apart drafts that differ only in where their links point", () => {
    expect(duplicateKey("https://example.com/one")).not.toBe(duplicateKey("https://example.com/two"));
    expect(duplicateKey("Read this: example.com/a")).not.toBe(duplicateKey("Read this: example.com/b"));
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
