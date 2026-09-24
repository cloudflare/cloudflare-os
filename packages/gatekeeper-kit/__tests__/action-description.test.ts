import { describe, expect, it } from "vitest";
import {
  ActionDescriptionBuilder,
  buildDescription,
  codeSpan,
  defuseFences,
  type FileDescription,
  plainInline,
  quoteUntrusted,
  sanitizeTitle,
  truncateToBytes,
} from "../src/action-description";

const encoder = new TextEncoder();

const bytes = (list: string[]) => list.reduce((sum, item) => sum + encoder.encode(item).byteLength, 0);

describe("ActionDescriptionBuilder", () => {
  it("carries values as fields and keeps the description to prose", () => {
    const payload = "LGTM ```but``` <script>alert(1)</script>";
    const result = buildDescription("Posts a comment.")
      .verbatim("Body", payload, "markdown")
      .prose("Nothing is sent until approval.")
      .finish();

    expect(result).toEqual({
      description: "Posts a comment.\n\nNothing is sent until approval.",
      fields: [{ label: "Body", kind: "text", value: payload, syntax: "markdown" }],
      descriptionIsComplete: true,
    });
  });

  it("omits the syntax key when none is given", () => {
    expect(buildDescription().verbatim("SQL", "select 1", "sql").finish().fields)
      .toEqual([{ label: "SQL", kind: "text", value: "select 1", syntax: "sql" }]);
    expect(buildDescription().verbatim("Body", "x").finish().fields)
      .toEqual([{ label: "Body", kind: "text", value: "x" }]);
  });

  it("keeps a short value inline and moves one a line cannot show into text", () => {
    const { fields, descriptionIsComplete } = buildDescription()
      .inline("Title", "Fix the build")
      .inline("Ticks", "has `ticks`")
      .inline("Multi", "two\nlines")
      .inline("Padded", " edge ")
      .inline("Spaces", "a  b")
      .inline("Tab", "a\tb")
      .inline("Long", "x".repeat(121))
      .finish();

    expect(descriptionIsComplete).toBe(true);
    expect(fields).toEqual([
      { label: "Title", kind: "inline", value: "Fix the build" },
      { label: "Ticks", kind: "inline", value: "has `ticks`" },
      { label: "Multi", kind: "text", value: "two\nlines" },
      { label: "Padded", kind: "text", value: " edge " },
      { label: "Spaces", kind: "text", value: "a  b" },
      { label: "Tab", kind: "text", value: "a\tb" },
      { label: "Long", kind: "text", value: "x".repeat(121) },
    ]);
  });

  it("carries empty values as empty fields", () => {
    const { description, fields, descriptionIsComplete } = buildDescription()
      .verbatim("Body", "")
      .inline("Title", "")
      .list("Labels", [])
      .finish();

    expect(descriptionIsComplete).toBe(true);
    expect(description).toBe("");
    expect(fields).toEqual([
      { label: "Body", kind: "text", value: "" },
      { label: "Title", kind: "inline", value: "" },
      { label: "Labels", kind: "list", items: [] },
    ]);
  });

  it("carries a list as items, or as JSON when an item has a line break", () => {
    expect(buildDescription().list("Labels", ["bug", "help wanted"]).finish().fields)
      .toEqual([{ label: "Labels", kind: "list", items: ["bug", "help wanted"] }]);
    expect(buildDescription().list("Labels", ["a\nb", "c"]).finish().fields)
      .toEqual([{ label: "Labels", kind: "json", value: '[\n  "a\\nb",\n  "c"\n]' }]);
  });

  it("pretty-prints JSON and marks an unserializable value incomplete", () => {
    expect(buildDescription().json("Arguments", { a: 1, b: ["x"] }).finish()).toEqual({
      description: "",
      fields: [{ label: "Arguments", kind: "json", value: '{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}' }],
      descriptionIsComplete: true,
    });

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const incomplete = buildDescription().json("Arguments", cyclic).finish();
    expect(incomplete).toEqual({ description: "**Arguments:** _(could not be displayed)_" });

    // `undefined` has no JSON form at all.
    expect(buildDescription().json("Value", undefined).finish().description)
      .toBe("**Value:** _(could not be displayed)_");
  });

  it("truncates an oversize field on a UTF-8 boundary and drops the flag", () => {
    const builder = new ActionDescriptionBuilder(undefined, { maxBytes: 400 });
    // Three-byte code points, so an arbitrary byte cut would land mid-character.
    const { fields, descriptionIsComplete } = builder.verbatim("Body", "€".repeat(1000)).finish();

    expect(descriptionIsComplete).toBeUndefined();
    const [field] = fields!;
    expect(field).toMatchObject({ label: "Body", kind: "text" });
    const value = (field as { value: string }).value;
    expect(value).toMatch(/^€+$/);
    expect(field!.truncated).toEqual({ shownBytes: value.length * 3, totalBytes: 3000 });
    expect(encoder.encode(value).byteLength).toBeLessThanOrEqual(400);
  });

  it("truncates a list by whole items", () => {
    const items = Array.from({ length: 100 }, (_, i) => `recipient-${i}@example.com`);
    const { fields, descriptionIsComplete } =
      new ActionDescriptionBuilder(undefined, { maxBytes: 400 }).list("To", items).finish();

    expect(descriptionIsComplete).toBeUndefined();
    const field = fields![0] as { items: string[]; truncated?: object };
    expect(field.items.length).toBeGreaterThan(0);
    expect(field.items).toEqual(items.slice(0, field.items.length));
    expect(field.truncated).toEqual({ shownBytes: bytes(field.items), totalBytes: bytes(items) });
  });

  it("stubs the first omitted field and counts the rest in prose", () => {
    const builder = new ActionDescriptionBuilder("Intro.", { maxBytes: 300 });
    const { description, fields, descriptionIsComplete } = builder
      .verbatim("First", "a".repeat(1000))
      .verbatim("Second", "b")
      .inline("Third", "c")
      .finish();

    expect(descriptionIsComplete).toBeUndefined();
    expect(fields).toHaveLength(2);
    expect(fields![0]!.truncated?.shownBytes).toBeGreaterThan(0);
    expect(fields![1]).toEqual(
      { label: "Second", kind: "inline", value: "", truncated: { shownBytes: 0, totalBytes: 1 } });
    // Inline values take the same path, so nothing slips past the cap; after the first stub,
    // omitted fields are only counted.
    expect(description).toBe("Intro.\n\n_(1 more field omitted: description limit reached)_");
  });

  it("bounds the stubs however many fields are omitted", () => {
    const builder = new ActionDescriptionBuilder("Intro.", { maxBytes: 300 });
    builder.verbatim("First", "a".repeat(1000));
    for (let i = 0; i < 1000; i++) builder.inline(`Field ${i}`, "x").verbatim(`Block ${i}`, "y");
    const { description, fields, descriptionIsComplete } = builder.finish();

    expect(descriptionIsComplete).toBeUndefined();
    expect(fields!.filter(field => field.truncated?.shownBytes === 0)).toHaveLength(1);
    expect(fields).toHaveLength(2);
    expect(description).toMatch(/\n\n_\(\d{4} more fields omitted: description limit reached\)_$/);
  });

  it("reroutes values with control characters to JSON and stays complete", () => {
    const shown = buildDescription()
      .inline("Name", "a\u0000b")
      .list("Items", ["ok", "c\u0007d"])
      .json("Value", { s: "e\u0085f\u007F" })
      .verbatim("Body", "a\u0000b")
      .finish();
    expect(shown.descriptionIsComplete).toBe(true);
    expect(shown.fields).toEqual([
      { label: "Name", kind: "json", value: '"a\\u0000b"' },
      { label: "Items", kind: "json", value: '[\n  "ok",\n  "c\\u0007d"\n]' },
      { label: "Value", kind: "json", value: '{\n  "s": "e\\u0085f\\u007f"\n}' },
      { label: "Body", kind: "json", value: '"a\\u0000b"' },
    ]);
    for (const field of shown.fields!) {
      // oxlint-disable-next-line no-control-regex -- asserting none reach a value
      expect((field as { value: string }).value).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/);
    }
  });

  it("reroutes values with bidi controls to JSON", () => {
    const shown = buildDescription()
      .inline("Name", "a\u202Eb")
      .list("Items", ["ok", "c\u2066d\u2069"])
      .json("Value", { s: "e\u200Ff\u061C" })
      .verbatim("Body", "a\u202Eb")
      .finish();
    expect(shown.descriptionIsComplete).toBe(true);
    expect(shown.fields).toEqual([
      { label: "Name", kind: "json", value: '"a\\u202eb"' },
      { label: "Items", kind: "json", value: '[\n  "ok",\n  "c\\u2066d\\u2069"\n]' },
      { label: "Value", kind: "json", value: '{\n  "s": "e\\u200ff\\u061c"\n}' },
      { label: "Body", kind: "json", value: '"a\\u202eb"' },
    ]);
  });

  it("reroutes values with other invisible characters to JSON", () => {
    const shown = buildDescription()
      .inline("Email", "admin\u200B@x.com")
      .list("Items", ["ok", "\uFEFFc"])
      .json("Value", { s: "co\u00ADop", t: "a\u{E0001}b" })
      .finish();
    expect(shown.descriptionIsComplete).toBe(true);
    expect(shown.fields).toEqual([
      { label: "Email", kind: "json", value: '"admin\\u200b@x.com"' },
      { label: "Items", kind: "json", value: '[\n  "ok",\n  "\\ufeffc"\n]' },
      { label: "Value", kind: "json", value: '{\n  "s": "co\\u00adop",\n  "t": "a\\udb40\\udc01b"\n}' },
    ]);
    expect(JSON.parse('"a\\udb40\\udc01b"')).toBe("a\u{E0001}b");
  });

  it("keeps text whose only invisibles belong to emoji as text", () => {
    const text = "Thanks \u2764\uFE0F from \u{1F468}\u200D\u{1F469}\u200D\u{1F467}, " +
      "\u{1F44D}\u{1F3FD} \u{1F9D1}\u{1F3FD}\u200D\u{1F4BB}, press 1\uFE0F\u20E3 " +
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    expect(buildDescription().verbatim("Body", text).finish()).toEqual({
      description: "",
      fields: [{ label: "Body", kind: "text", value: text }],
      descriptionIsComplete: true,
    });
  });

  it("reroutes text with invisibles outside emoji to JSON, exact and complete", () => {
    const secretTags = [..."secret"].map(c => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join("");
    for (const text of [
      "pay\u200Dload",
      "a\u{E0100}b",
      "a\uFE0Fb",
      `\u{1F3F4}${secretTags}\u{E007F}`,
      "co\u00ADop",
      "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645",
    ]) {
      const shown = buildDescription().verbatim("Body", text, "markdown").finish();
      expect(shown.descriptionIsComplete, JSON.stringify(text)).toBe(true);
      const [field] = shown.fields!;
      expect(field).toMatchObject({ label: "Body", kind: "json" });
      expect(JSON.parse((field as { value: string }).value)).toBe(text);
      expect((field as { value: string }).value).not.toMatch(/\p{Default_Ignorable_Code_Point}/u);
    }
  });

  it("keeps CRLF-only text as text, complete", () => {
    const crlf = "one\r\ntwo\r\n";
    expect(buildDescription().verbatim("Body", crlf).finish()).toEqual({
      description: "",
      fields: [{ label: "Body", kind: "text", value: crlf }],
      descriptionIsComplete: true,
    });

    // `inline` takes the same path for such a value.
    expect(buildDescription().inline("Name", "a\r\nb").finish().fields)
      .toEqual([{ label: "Name", kind: "text", value: "a\r\nb" }]);
  });

  it("reroutes carriage returns that are not CRLF line breaks to JSON", () => {
    for (const text of ["a\rb", "a\r\nb\nc", "a\nb\r\n", "a\r\r\nb"]) {
      const shown = buildDescription().verbatim("Body", text).finish();
      expect(shown.descriptionIsComplete).toBe(true);
      expect(shown.fields).toEqual([{ label: "Body", kind: "json", value: JSON.stringify(text) }]);
    }

    const escaped = buildDescription()
      .inline("Name", "a\rb")
      .list("Items", ["c\r\nd", "e"])
      .finish();
    expect(escaped.descriptionIsComplete).toBe(true);
    expect(escaped.fields).toEqual([
      { label: "Name", kind: "json", value: '"a\\rb"' },
      { label: "Items", kind: "json", value: '[\n  "c\\r\\nd",\n  "e"\n]' },
    ]);
  });

  it("names provider bytes as a complete file and agent bytes as an incomplete one", () => {
    const file = { name: "report.pdf", mediaType: "application/pdf", size: 1234, sha256: "ab".repeat(32) };
    expect(buildDescription().file("Attachment 1", { ...file, origin: "provider" }).finish())
      .toEqual({
        description: "",
        fields: [{ label: "Attachment 1", kind: "file", ...file, origin: "provider" }],
        descriptionIsComplete: true,
      });

    const agent = buildDescription().file("File", { ...file, origin: "agent" }).finish();
    expect(agent.fields).toEqual([{ label: "File", kind: "file", ...file, origin: "agent" }]);
    expect(Object.hasOwn(agent, "descriptionIsComplete")).toBe(false);
  });

  it("takes only a file's own members, whatever else the caller's object carries", () => {
    const stray = {
      label: "Forged", kind: "inline", truncated: { shownBytes: 0, totalBytes: 1 },
      name: "a.txt", mediaType: "text/plain", size: 1, origin: "provider",
    } as unknown as FileDescription;
    expect(buildDescription().file("File", stray).finish().fields).toEqual([
      { label: "File", kind: "file", name: "a.txt", mediaType: "text/plain", size: 1, origin: "provider" },
    ]);
  });

  it("keeps a file name with invisible characters in the file field, for surfaces to escape", () => {
    const file = { name: "invoice\u202Efdp.exe", mediaType: "application/pdf", size: 1 };
    expect(buildDescription().file("File", { ...file, origin: "provider" }).finish()).toEqual({
      description: "",
      fields: [{ label: "File", kind: "file", ...file, origin: "provider" }],
      descriptionIsComplete: true,
    });
  });

  it("counts prose against the budget without cutting it", () => {
    const builder = new ActionDescriptionBuilder("p".repeat(500), { maxBytes: 300 });
    const { description, fields, descriptionIsComplete } = builder.verbatim("Body", "b").finish();

    expect(description).toBe("p".repeat(500));
    expect(fields).toEqual(
      [{ label: "Body", kind: "inline", value: "", truncated: { shownBytes: 0, totalBytes: 1 } }]);
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

  it("puts the completeness and fields keys on the result only when set", () => {
    const proseOnly = buildDescription("Prose only.").finish();
    expect(Object.hasOwn(proseOnly, "descriptionIsComplete")).toBe(true);
    expect(Object.hasOwn(proseOnly, "fields")).toBe(false);
    const incomplete = new ActionDescriptionBuilder(undefined, { maxBytes: 200 })
      .verbatim("Body", "long enough to be cut ".repeat(20)).finish();
    expect(Object.hasOwn(incomplete, "descriptionIsComplete")).toBe(false);
  });

  it("keeps a description at the full budget within the storage limit once serialized", () => {
    const builder = buildDescription("Intro.");
    for (let i = 0; i < 50; i++) builder.inline(`Field ${i}`, `value ${i}`);
    builder.list("To", Array.from({ length: 500 }, (_, i) => `r${i}@example.com`));
    builder.json("Arguments", { body: "j".repeat(20_000) });
    builder.verbatim("Body", "b".repeat(200_000), "markdown");
    for (let i = 0; i < 100; i++) builder.verbatim(`Extra ${i}`, "e".repeat(1000));
    const result = builder.finish();

    expect(result.descriptionIsComplete).toBeUndefined();
    expect(encoder.encode(JSON.stringify(result)).byteLength).toBeLessThan(128 * 1024);
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
