import { describe, expect, it } from "vitest";
import {
  XmlError, attribute, childElements, decodeEntities, parseXml, streamElements, textContent, type XmlElement, type XmlErrorCode,
  type XmlOptions,
} from "../../src/content/xml";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const options: XmlOptions = { namespaces: { [W]: "w" } };

function expectXmlError(text: string, code: XmlErrorCode, extra: Partial<XmlOptions> = {}): void {
  expect(() => parseXml(text, { ...options, ...extra })).toThrow(expect.objectContaining({ name: "XmlError", code }) as XmlError);
}

describe("parseXml", () => {
  it("reports names with the caller's prefix whatever prefix the file binds", () => {
    const root = parseXml(`<doc xmlns:word="${W}"><word:p word:val="1"/><other:x xmlns:other="urn:other" plain="2"/></doc>`, options);
    const [paragraph, other] = childElements(root);
    expect(paragraph!.name).toBe("w:p");
    expect(attribute(paragraph, "w:val")).toBe("1");
    expect(other!.name).toBe("{urn:other}x");
    expect(attribute(other, "plain")).toBe("2");
  });

  it("applies a default namespace to elements but not to unprefixed attributes", () => {
    const root = parseXml(`<document xmlns="${W}" id="7"><p/></document>`, options);
    expect(root.name).toBe("w:document");
    expect(attribute(root, "id")).toBe("7");
    expect(childElements(root)[0]!.name).toBe("w:p");
  });

  it("scopes namespace declarations to their element", () => {
    const root = parseXml(`<r><a xmlns:w="${W}"><w:t/></a><w:t xmlns:w="urn:not-word"/></r>`, options);
    expect(childElements(childElements(root)[0])[0]!.name).toBe("w:t");
    expect(childElements(root)[1]!.name).toBe("{urn:not-word}t");
  });

  it("decodes predefined entities, numeric references and CDATA", () => {
    const root = parseXml(`<t a="&lt;&quot;&#65;&#x42;">&amp;&apos;&gt; &#x1F600; <![CDATA[<raw> & stuff]]></t>`, options);
    expect(attribute(root, "a")).toBe('<"AB');
    expect(textContent(root)).toBe("&'> 😀 <raw> & stuff");
  });

  it("replaces invalid character references rather than producing broken strings", () => {
    expect(decodeEntities("&#0;&#xD800;&#x110000;")).toBe("���");
  });

  it("skips the XML declaration, processing instructions and comments", () => {
    const root = parseXml(`<?xml version="1.0"?><!-- c --><?pi data?><r><!-- inner -->text<?x?></r><!-- after -->`, options);
    expect(textContent(root)).toBe("text");
  });

  it("keeps whitespace in leaf elements and drops indentation between elements", () => {
    const root = parseXml(`<r>\n  <t xml:space="preserve"> </t>\n  <t>a b</t>\n</r>`, options);
    expect(root.children).toHaveLength(2);
    expect(childElements(root).map(textContent)).toEqual([" ", "a b"]);
    expect(attribute(childElements(root)[0], "xml:space")).toBe("preserve");
  });

  it("stores attributes in a map, so names like __proto__ are inert", () => {
    const root = parseXml(`<r __proto__="x" constructor="y"/>`, options);
    expect(attribute(root, "__proto__")).toBe("x");
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  describe("entity expansion safety", () => {
    it("never expands entities a DOCTYPE declares (billion laughs)", () => {
      const lol = `<?xml version="1.0"?><!DOCTYPE lolz [
        <!ENTITY lol "lol">
        <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
        <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
        <!ENTITY lol9 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
      ]><lolz>&lol9;</lolz>`;
      expect(textContent(parseXml(lol, options))).toBe("&lol9;");
    });

    it("never resolves external entities (XXE)", () => {
      const xxe = `<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd"> <!ELEMENT r ANY>]><r>&xxe;</r>`;
      expect(textContent(parseXml(xxe, options))).toBe("&xxe;");
    });

    it("refuses a DOCTYPE after the root starts", () => {
      expectXmlError(`<r><!DOCTYPE x></r>`, "malformed");
    });
  });

  describe("malformed input", () => {
    it.each([
      ["mismatched tags", "<a><b></a></b>"],
      ["an unclosed element", "<a><b></b>"],
      ["two roots", "<a/><b/>"],
      ["text outside the root", "<a/>junk"],
      ["no root", "<?xml version='1.0'?>"],
      ["an unquoted attribute", "<a b=c/>"],
      ["a repeated attribute", '<a b="1" b="2"/>'],
      ["an unterminated comment", "<a><!-- </a>"],
      ["an unterminated CDATA section", "<a><![CDATA[ </a>"],
      ["a stray close tag", "</a>"],
      ["< in an attribute", '<a b="<"/>'],
    ])("refuses %s", (_label, text) => {
      expectXmlError(text, "malformed");
    });
  });

  describe("limits", () => {
    it("bounds nesting depth", () => {
      expectXmlError("<a>".repeat(300) + "</a>".repeat(300), "limit");
      expectXmlError("<a>".repeat(11) + "</a>".repeat(11), "limit", { maxDepth: 10 });
    });

    it("bounds the elements in one tree", () => {
      expectXmlError(`<r>${"<x/>".repeat(101)}</r>`, "limit", { maxElements: 100 });
      // Four attributes weigh as much as an element: 1 + 51 × (1 + 4 / 4) > 100.
      expectXmlError(`<r>${'<x a="1" b="2" c="3" d="4"/>'.repeat(51)}</r>`, "limit", { maxElements: 100 });
      expect(childElements(parseXml(`<r>${'<x a="1" b="2" c="3" d="4"/>'.repeat(49)}</r>`, { ...options, maxElements: 100 }))).toHaveLength(49);
    });
  });

  it("lets the caller replace elements as they close", () => {
    const root = parseXml("<r><wrap><keep>1</keep></wrap><keep>2</keep></r>", {
      ...options,
      replace: element => (element.name === "wrap" ? element.children : undefined),
    });
    expect(childElements(root).map(element => element.name)).toEqual(["keep", "keep"]);
  });
});

describe("streamElements", () => {
  it("yields each element at the requested depth as a complete subtree", () => {
    const text = `<w:document xmlns:w="${W}"><w:body><w:p><w:t>one</w:t></w:p><w:tbl><w:tr/></w:tbl><w:p><w:t>two</w:t></w:p></w:body></w:document>`;
    const blocks: XmlElement[] = [...streamElements(text, 2, options)];
    expect(blocks.map(block => block.name)).toEqual(["w:p", "w:tbl", "w:p"]);
    expect(blocks.map(textContent)).toEqual(["one", "", "two"]);
  });

  it("applies the element limit to each subtree, not the whole stream", () => {
    const text = `<r><b>${"<p><x/></p>".repeat(50)}</b></r>`;
    expect([...streamElements(text, 2, { ...options, maxElements: 5 })]).toHaveLength(50);
  });

  it("still checks well-formedness of what it skips", () => {
    expect(() => [...streamElements("<r><b><p/></c></r>", 2, options)]).toThrow(XmlError);
  });
});
