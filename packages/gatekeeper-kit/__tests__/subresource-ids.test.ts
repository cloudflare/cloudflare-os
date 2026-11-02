import { describe, expect, it } from "vitest";
import { formatSubresourceId, parseSubresourceId, type SubresourceId } from "../src/subresource-ids";

describe("subresource IDs", () => {
  it("lead with a namespace only when one is given", () => {
    const namespaced: SubresourceId = {
      namespace: "gmail",
      fragments: [{ name: "inbox", id: "mpeterson@cloudflare.com" }],
    };
    const bare: SubresourceId = { fragments: [{ name: "space", id: "ENG" }, { name: "page", id: "123" }] };

    expect(formatSubresourceId(namespaced)).toBe("gmail/inbox/mpeterson%40cloudflare.com");
    expect(formatSubresourceId(bare)).toBe("space/ENG/page/123");
    expect(parseSubresourceId("gmail/inbox/mpeterson%40cloudflare.com")).toStrictEqual(namespaced);
    expect(parseSubresourceId("space/ENG/page/123")).toStrictEqual(bare);
  });

  it("escape separators so components cannot run together", () => {
    const value: SubresourceId = {
      namespace: "drive",
      fragments: [{ name: "folder", id: "a/b" }, { name: "file", id: "100%/ü😀 it's(1)*!~.-_" }],
    };
    const id = formatSubresourceId(value);

    expect(id).toBe("drive/folder/a%2Fb/file/100%25%2F%C3%BC%F0%9F%98%80%20it's(1)*!~.-_");
    expect(parseSubresourceId(id)).toStrictEqual(value);
    expect(formatSubresourceId({ fragments: [{ name: "file", id: "a/b" }] }))
      .not.toBe(formatSubresourceId({ namespace: "file", fragments: [{ name: "a", id: "b" }] }));
  });

  it.each<[string, SubresourceId, RegExp]>([
    ["an empty namespace", { namespace: "", fragments: [{ name: "file", id: "1" }] }, /namespace/],
    ["no fragments", { namespace: "gmail", fragments: [] }, /at least one fragment/],
    ["an empty fragment name", { fragments: [{ name: "", id: "1" }] }, /names and ids/],
    ["an empty fragment id", { fragments: [{ name: "file", id: "" }] }, /names and ids/],
    ["a lone surrogate", { fragments: [{ name: "file", id: "\uD800" }] }, /well-formed/],
  ])("refuse to format %s", (_, value, message) => {
    expect(() => formatSubresourceId(value)).toThrow(message);
  });

  it.each([
    ["the empty string", ""],
    ["a namespace alone", "gmail"],
    ["an empty component", "file//page/1"],
    ["a trailing separator", "gmail/inbox/"],
    ["a needless escape", "%66ile/1"],
    ["a lowercase escape", "file/a%2fb"],
    ["a raw character the encoder escapes", "file/a b"],
    ["a malformed escape", "file/%E0%A4%A"],
    ["a lone surrogate", "file/\uD800"],
  ])("refuse to parse %s", (_, id) => {
    expect(() => parseSubresourceId(id)).toThrow("Not a subresource ID in canonical form.");
  });
});
