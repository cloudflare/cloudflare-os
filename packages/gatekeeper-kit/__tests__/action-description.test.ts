import { describe, expect, it } from "vitest";
import {
  ActionDescriptionBuilder,
  buildDescription,
  codeSpan,
  defuseFences,
  plainInline,
  quoteUntrusted,
  sanitizeTitle,
  truncateToBytes,
} from "../src/action-description";

const encoder = new TextEncoder();

describe("ActionDescriptionBuilder", () => {
  it("renders content inside a fence the content cannot close", () => {
    const payload = "before\n```\nescaped\n```\nafter ````";
    const { description, descriptionIsComplete } =
      buildDescription("Posts a comment.").verbatim("Body", payload).finish();

    expect(descriptionIsComplete).toBe(true);
    // Five backticks: one more than the longest run in the payload.
    expect(description).toBe(`Posts a comment.\n\n**Body:**\n\n\`\`\`\`\`\n${payload}\n\`\`\`\`\``);
    // The bytes between the fences are exactly the payload.
    expect(description.split("`````")[1]).toBe(`\n${payload}\n`);
  });

  it("puts the info string on the opening fence", () => {
    const { description } = buildDescription().verbatim("SQL", "select 1", "sql").finish();
    expect(description).toBe("**SQL:**\n\n```sql\nselect 1\n```");
  });

  it("keeps a short value inline and moves an unrepresentable one into a block", () => {
    const { description, descriptionIsComplete } = buildDescription()
      .inline("Title", "Fix the build")
      .inline("Note", "has `ticks`")
      .inline("Multi", "two\nlines")
      .inline("Padded", " edge ")
      .inline("Long", "x".repeat(121))
      .finish();

    expect(descriptionIsComplete).toBe(true);
    expect(description).toContain("**Title:** `Fix the build`");
    expect(description).toContain("**Note:**\n\n```\nhas `ticks`\n```");
    expect(description).toContain("**Multi:**\n\n```\ntwo\nlines\n```");
    expect(description).toContain("**Padded:**\n\n```\n edge \n```");
    expect(description).toContain(`**Long:**\n\n\`\`\`\n${"x".repeat(121)}\n\`\`\``);
  });

  it("names empty content instead of rendering an empty block", () => {
    const { description, descriptionIsComplete } = buildDescription()
      .verbatim("Body", "")
      .inline("Title", "")
      .list("Labels", [])
      .finish();

    expect(descriptionIsComplete).toBe(true);
    expect(description).toBe("**Body:** _(empty)_\n\n**Title:** _(empty)_\n\n**Labels:** _(none)_");
  });

  it("renders a list one item per line, or as JSON when an item has a line break", () => {
    expect(buildDescription().list("Labels", ["bug", "help wanted"]).finish().description)
      .toBe("**Labels:**\n\n```\nbug\nhelp wanted\n```");
    expect(buildDescription().list("Labels", ["a\nb", "c"]).finish().description)
      .toBe('**Labels:**\n\n```json\n[\n  "a\\nb",\n  "c"\n]\n```');
  });

  it("pretty-prints JSON and marks an unserializable value incomplete", () => {
    const complete = buildDescription().json("Arguments", { a: 1, b: ["x"] }).finish();
    expect(complete).toEqual({
      description: '**Arguments:**\n\n```json\n{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}\n```',
      descriptionIsComplete: true,
    });

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const incomplete = buildDescription().json("Arguments", cyclic).finish();
    expect(incomplete.description).toBe("**Arguments:** _(could not be displayed)_");
    expect(Object.hasOwn(incomplete, "descriptionIsComplete")).toBe(false);

    // `undefined` has no JSON form at all.
    expect(buildDescription().json("Value", undefined).finish().description)
      .toBe("**Value:** _(could not be displayed)_");
  });

  it("truncates an oversize field on a UTF-8 boundary, notes it, and drops the flag", () => {
    const builder = new ActionDescriptionBuilder(undefined, { maxBytes: 400 });
    // Three-byte code points, so an arbitrary byte cut would land mid-character.
    const body = "€".repeat(1000);
    const { description, descriptionIsComplete } = builder.verbatim("Body", body).finish();

    expect(descriptionIsComplete).toBeUndefined();
    const shown = description.split("```")[1]!.slice(1, -1);
    expect(shown).toMatch(/^€+$/);
    expect(description).toContain(`_Truncated: showing ${shown.length * 3} of 3000 bytes._`);
    expect(encoder.encode(description).byteLength).toBeLessThanOrEqual(400);
  });

  it("omits later fields once the budget is spent", () => {
    const builder = new ActionDescriptionBuilder("Intro.", { maxBytes: 300 });
    const { description, descriptionIsComplete } = builder
      .verbatim("First", "a".repeat(1000))
      .verbatim("Second", "b")
      .inline("Third", "c")
      .finish();

    expect(descriptionIsComplete).toBeUndefined();
    expect(description).toContain("_Truncated: showing");
    expect(description).toContain("**Second:** _(omitted: description limit reached)_");
    // Inline values take the same path, so nothing slips past the cap on the label's line; after
    // the first placeholder, omitted fields are only counted.
    expect(description).not.toContain("**Third:**");
    expect(description.endsWith("_(1 more field omitted: description limit reached)_")).toBe(true);
    // Only the placeholders sit past the budget.
    const [shown] = description.split("\n\n**Second:**");
    expect(encoder.encode(shown).byteLength).toBeLessThanOrEqual(300);
  });

  it("bounds the placeholders however many fields are omitted", () => {
    const builder = new ActionDescriptionBuilder("Intro.", { maxBytes: 300 });
    builder.verbatim("First", "a".repeat(1000));
    for (let i = 0; i < 1000; i++) builder.inline(`Field ${i}`, "x").verbatim(`Block ${i}`, "y");
    const { description, descriptionIsComplete } = builder.finish();

    expect(descriptionIsComplete).toBeUndefined();
    // One labelled placeholder, then a count of the rest.
    expect(description.match(/_\(omitted: description limit reached\)_/g)).toHaveLength(1);
    expect(description).toMatch(/\n\n_\(\d{4} more fields omitted: description limit reached\)_$/);
    expect(encoder.encode(description).byteLength).toBeLessThanOrEqual(300 + 200);
  });

  it("fences a value whose whitespace a code span would collapse", () => {
    const { description, descriptionIsComplete } = buildDescription()
      .inline("Spaces", "a  b")
      .inline("Tab", "a\tb")
      .inline("Single", "a b")
      .finish();

    expect(descriptionIsComplete).toBe(true);
    expect(description).toContain("**Spaces:**\n\n```\na  b\n```");
    expect(description).toContain("**Tab:**\n\n```\na\tb\n```");
    expect(description).toContain("**Single:** `a b`");
  });

  it("escapes control characters, or flags verbatim text that has them", () => {
    const shown = buildDescription()
      .inline("Name", "a\u0000b")
      .list("Items", ["ok", "c\u0007d"])
      .json("Value", { s: "e\u0085f\u007F" })
      .finish();
    expect(shown.descriptionIsComplete).toBe(true);
    expect(shown.description).toContain('**Name:**\n\n```json\n"a\\u0000b"\n```');
    expect(shown.description).toContain('"c\\u0007d"');
    expect(shown.description).toContain('"s": "e\\u0085f\\u007f"');
    // oxlint-disable-next-line no-control-regex -- asserting none reach the description
    expect(shown.description).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/);

    const raw = buildDescription().verbatim("Body", "a\u0000b").finish();
    expect(raw.descriptionIsComplete).toBeUndefined();
    expect(raw.description)
      .toBe("**Body:**\n\n```\na\u0000b\n```\n\n_Contains invisible or control characters that cannot be displayed._");
  });

  it("escapes bidi controls, or flags verbatim text that has them", () => {
    const shown = buildDescription()
      .inline("Name", "a\u202Eb")
      .list("Items", ["ok", "c\u2066d\u2069"])
      .json("Value", { s: "e\u200Ff\u061C" })
      .finish();
    expect(shown.descriptionIsComplete).toBe(true);
    expect(shown.description).toContain('**Name:**\n\n```json\n"a\\u202eb"\n```');
    expect(shown.description).toContain('"c\\u2066d\\u2069"');
    expect(shown.description).toContain('"s": "e\\u200ff\\u061c"');
    expect(shown.description).not.toMatch(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/);

    const raw = buildDescription().verbatim("Body", "a\u202Eb").finish();
    expect(raw.descriptionIsComplete).toBeUndefined();
    expect(raw.description)
      .toBe("**Body:**\n\n```\na\u202Eb\n```\n\n_Contains invisible or control characters that cannot be displayed._");
  });

  it("escapes other invisible characters, or flags verbatim text that has them", () => {
    const shown = buildDescription()
      .inline("Email", "admin\u200B@x.com")
      .list("Items", ["ok", "\uFEFFc"])
      .json("Value", { s: "co\u00ADop", t: "a\u{E0001}b" })
      .finish();
    expect(shown.descriptionIsComplete).toBe(true);
    expect(shown.description).toContain('**Email:**\n\n```json\n"admin\\u200b@x.com"\n```');
    expect(shown.description).toContain('"\\ufeffc"');
    expect(shown.description).toContain('"s": "co\\u00adop"');
    expect(shown.description).toContain('"t": "a\\udb40\\udc01b"');
    expect(JSON.parse('"a\\udb40\\udc01b"')).toBe("a\u{E0001}b");
    expect(shown.description).not.toMatch(/\p{Default_Ignorable_Code_Point}/u);

    const raw = buildDescription().verbatim("Body", "admin\u200B@x.com").finish();
    expect(raw.descriptionIsComplete).toBeUndefined();
    expect(raw.description).toBe(
      "**Body:**\n\n```\nadmin\u200B@x.com\n```\n\n_Contains invisible or control characters that cannot be displayed._");
  });

  it("keeps verbatim prose whose only invisibles belong to emoji complete", () => {
    const text = "Thanks \u2764\uFE0F from \u{1F468}\u200D\u{1F469}\u200D\u{1F467}, " +
      "\u{1F44D}\u{1F3FD} \u{1F9D1}\u{1F3FD}\u200D\u{1F4BB}, press 1\uFE0F\u20E3 " +
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    const shown = buildDescription().verbatim("Body", text).finish();
    expect(shown.descriptionIsComplete).toBe(true);
    expect(shown.description).toBe(`**Body:**\n\n\`\`\`\n${text}\n\`\`\``);
  });

  it("flags verbatim prose with invisibles outside emoji, which can hide data", () => {
    const secretTags = [..."secret"].map(c => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join("");
    for (const text of [
      "pay\u200Dload",
      "a\u{E0100}b",
      "a\uFE0Fb",
      `\u{1F3F4}${secretTags}\u{E007F}`,
      "co\u00ADop",
      "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645",
    ]) {
      const shown = buildDescription().verbatim("Body", text).finish();
      expect(shown.descriptionIsComplete, JSON.stringify(text)).toBeUndefined();
      expect(shown.description).toBe(
        `**Body:**\n\n\`\`\`\n${text}\n\`\`\`\n\n_Contains invisible or control characters that cannot be displayed._`);
    }
  });

  it("notes CRLF line breaks and keeps the field complete", () => {
    const crlf = "one\r\ntwo\r\n";
    const shown = buildDescription().verbatim("Body", crlf).finish();

    expect(shown.descriptionIsComplete).toBe(true);
    expect(shown.description).toBe(`**Body:**\n\n\`\`\`\n${crlf}\n\`\`\`\n\n` +
      "_Line breaks are CRLF (carriage return + line feed), shown as plain line breaks._");

    // `inline` takes the same block for such a value.
    const inline = buildDescription().inline("Name", "a\r\nb").finish();
    expect(inline.descriptionIsComplete).toBe(true);
    expect(inline.description).toContain("_Line breaks are CRLF");
  });

  it("flags carriage returns a block cannot show exactly, and leaves the field incomplete", () => {
    for (const text of ["a\rb", "a\r\nb\nc", "a\nb\r\n", "a\r\r\nb"]) {
      const { description, descriptionIsComplete } =
        buildDescription().verbatim("Body", text).finish();
      expect(descriptionIsComplete).toBeUndefined();
      expect(description).toBe(`**Body:**\n\n\`\`\`\n${text}\n\`\`\`\n\n` +
        "_Contains carriage returns that cannot be displayed exactly._");
    }

    // `inline`, `list` and `json` escape the carriage return instead, so they stay complete, and
    // none puts a raw one in the description.
    const escaped = buildDescription()
      .inline("Name", "a\rb")
      .list("Items", ["c\r\nd", "e"])
      .json("Value", { s: "f\rg" })
      .finish();
    expect(escaped.descriptionIsComplete).toBe(true);
    expect(escaped.description).toContain('**Name:**\n\n```json\n"a\\rb"\n```');
    expect(escaped.description).toContain('"c\\r\\nd"');
    expect(escaped.description).toContain('"s": "f\\rg"');
    expect(escaped.description).not.toContain("\r");
  });

  it("adds no line-ending note to text without carriage returns", () => {
    expect(buildDescription().verbatim("Body", "one\ntwo\n").finish()).toEqual({
      description: "**Body:**\n\n```\none\ntwo\n\n```",
      descriptionIsComplete: true,
    });
  });

  it("keeps the line-ending note within the budget", () => {
    const maxBytes = 400;
    // The largest text shown in full: the budget less the intro, the field's framing, the room
    // reserved for a truncation note, and the line-ending note after its blank line.
    const note = "_Line breaks are CRLF (carriage return + line feed), shown as plain line breaks._";
    const framing = encoder.encode("Intro.\n\n**Body:**\n\n```\n\n```").byteLength;
    const fits = maxBytes - framing - 80 - encoder.encode(note).byteLength - 2;
    for (const size of [fits - 1, fits, fits + 1, fits + 50]) {
      const text = "ab\r\n".repeat(Math.floor(size / 4)) + "x".repeat(size % 4);
      const { description, descriptionIsComplete } =
        new ActionDescriptionBuilder("Intro.", { maxBytes }).verbatim("Body", text).finish();

      expect(description).toContain(note);
      expect(descriptionIsComplete).toBe(size <= fits ? true : undefined);
      expect(encoder.encode(description).byteLength).toBeLessThanOrEqual(maxBytes);
    }
  });

  it("counts prose against the budget without cutting it", () => {
    const builder = new ActionDescriptionBuilder("p".repeat(500), { maxBytes: 300 });
    const { description, descriptionIsComplete } = builder.verbatim("Body", "b").finish();

    expect(description.startsWith("p".repeat(500))).toBe(true);
    expect(description).toContain("**Body:** _(omitted: description limit reached)_");
    expect(descriptionIsComplete).toBeUndefined();
  });

  it("leaves a description whose prose alone overflows the budget incomplete", () => {
    const { description, descriptionIsComplete } =
      new ActionDescriptionBuilder("p".repeat(500), { maxBytes: 300 }).finish();

    // Shown in full, since prose is never cut, but past the budget all the same.
    expect(description).toBe("p".repeat(500));
    expect(descriptionIsComplete).toBeUndefined();

    const later = new ActionDescriptionBuilder("Intro.", { maxBytes: 300 })
      .prose("q".repeat(500)).finish();
    expect(later.description).toBe(`Intro.\n\n${"q".repeat(500)}`);
    expect(later.descriptionIsComplete).toBeUndefined();
  });

  it("puts the completeness key on the result only when set", () => {
    expect(Object.hasOwn(buildDescription("Prose only.").finish(), "descriptionIsComplete"))
      .toBe(true);
    const incomplete = new ActionDescriptionBuilder(undefined, { maxBytes: 10 })
      .verbatim("Body", "long enough to be cut").finish();
    expect(Object.hasOwn(incomplete, "descriptionIsComplete")).toBe(false);
  });
});

describe("truncateToBytes", () => {
  it("returns short text unchanged", () => {
    expect(truncateToBytes("héllo", 6)).toEqual({ text: "héllo", truncated: false });
  });

  it("never splits a code point", () => {
    // "é" is two bytes; a cut at byte 2 lands inside it.
    expect(truncateToBytes("aéb", 2)).toEqual({ text: "a", truncated: true });
    expect(truncateToBytes("aéb", 3)).toEqual({ text: "aé", truncated: true });
    // A four-byte emoji, cut at every offset inside it.
    for (const max of [1, 2, 3]) expect(truncateToBytes("😀x", max).text).toBe("");
    expect(truncateToBytes("😀x", 4).text).toBe("😀");
  });
});

describe("sanitizers", () => {
  it("defuses fences", () => {
    expect(defuseFences("a ``` b ```` c")).toBe("a ''' b ''' c");
  });

  it("block-quotes untrusted prose without headings or fences", () => {
    expect(quoteUntrusted("## Heading\n> quoted\n```\nx", 100)).toBe("> Heading\n> quoted\n> '''\n> x");
    expect(quoteUntrusted("abcdef", 3)).toBe("> abc…");
    expect(quoteUntrusted("safe\r<!--\r\nx", 100)).toBe("> safe\n> <!--\n> x");
  });

  it("bounds code spans and inline prose", () => {
    expect(codeSpan("a `b`\n c")).toBe("`a b c`");
    expect(codeSpan("")).toBe("`(unnamed)`");
    expect(codeSpan("abcdef", 3)).toBe("`abc…`");
    expect(plainInline("*a* [b](c) #d")).toBe("a bc d");
    expect(plainInline("  ")).toBe("(unnamed)");
  });

  it("flattens and caps titles", () => {
    expect(sanitizeTitle("one\r\ntwo\nthree")).toBe("one two three");
    expect(sanitizeTitle("x".repeat(300))).toHaveLength(200);
    expect(sanitizeTitle("abcdef", 3)).toBe("abc");
  });
});
