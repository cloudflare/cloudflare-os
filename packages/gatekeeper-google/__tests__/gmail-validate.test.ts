import { describe, expect, it } from "vitest";
import {
  MAX_GMAIL_ADDRESS_BYTES, MAX_GMAIL_BODY_BYTES, MAX_GMAIL_LABEL_BYTES, MAX_GMAIL_QUERY_BYTES,
  MAX_GMAIL_RECIPIENTS, MAX_GMAIL_SUBJECT_BYTES, validateGmailAddress, validateGmailBody,
  validateGmailLabelName, validateGmailQueryForGrouping, validateGmailRecipientCount,
  validateOutboundInput,
} from "../src/gmail-validate";

// Multi-byte, so a byte limit and a length limit can be told apart.
const wide = (bytes: number) => "\u00e9".repeat(bytes / 2);

describe("validateGmailQueryForGrouping", () => {
  it.each([
    ["empty", ""],
    ["plain terms", "from:someone subject:hello"],
    ["balanced parens", "(a OR b) AND c"],
    ["balanced braces", "{a b} c"],
    ["nested", "((a) {b})"],
    ["quoted paren", 'subject:"a ) b"'],
    ["single-quoted brace", "subject:'a } b'"],
    ["escaped quote", 'subject:\\"'],
    ["escaped paren", "a \\( b"],
  ])("accepts %s", (_name, query) => {
    expect(() => validateGmailQueryForGrouping(query)).not.toThrow();
  });

  it.each([
    ["unclosed paren", "(a"],
    ["unopened paren", "a)"],
    ["unclosed brace", "{a"],
    ["crossed delimiters", "({a)}"],
    ["unterminated double quote", 'subject:"a'],
    ["unterminated single quote", "subject:'a"],
    ["escaped closing quote leaves it open", 'subject:"a\\"'],
  ])("rejects %s", (_name, query) => {
    expect(() => validateGmailQueryForGrouping(query)).toThrow();
  });

  // The base and caller queries are combined as `(base) (caller)`, so an unbalanced delimiter in
  // either would swallow the other's parentheses and escape the binding's restriction.
  it("rejects a query that would close the wrapping group early", () => {
    expect(() => validateGmailQueryForGrouping(") OR (")).toThrow();
  });

  it("counts the query limit in bytes, not characters", () => {
    expect(() => validateGmailQueryForGrouping(wide(MAX_GMAIL_QUERY_BYTES))).not.toThrow();
    expect(() => validateGmailQueryForGrouping(wide(MAX_GMAIL_QUERY_BYTES + 2))).toThrow(/at most/);
  });
});

describe("validateGmailLabelName", () => {
  it("accepts a name at the byte limit", () => {
    expect(() => validateGmailLabelName(wide(MAX_GMAIL_LABEL_BYTES))).not.toThrow();
  });

  it.each([["empty", ""], ["over the limit", wide(MAX_GMAIL_LABEL_BYTES + 2)]])(
    "rejects %s", (_name, label) => {
      expect(() => validateGmailLabelName(label)).toThrow(/between 1 and/);
    });
});

describe("validateGmailAddress", () => {
  it("accepts an address at the byte limit", () => {
    expect(() => validateGmailAddress(wide(MAX_GMAIL_ADDRESS_BYTES))).not.toThrow();
  });

  it.each([["empty", ""], ["over the limit", wide(MAX_GMAIL_ADDRESS_BYTES + 2)]])(
    "rejects %s", (_name, address) => {
      expect(() => validateGmailAddress(address)).toThrow();
    });
});

describe("validateGmailBody", () => {
  it("accepts an empty body and one at the byte limit", () => {
    expect(() => validateGmailBody("")).not.toThrow();
    expect(() => validateGmailBody(wide(MAX_GMAIL_BODY_BYTES))).not.toThrow();
  });

  it("rejects a body over the byte limit", () => {
    expect(() => validateGmailBody(wide(MAX_GMAIL_BODY_BYTES + 2))).toThrow(/at most/);
  });
});

describe("validateGmailRecipientCount", () => {
  it("accepts 1 and the maximum", () => {
    expect(() => validateGmailRecipientCount(["a@b.com"])).not.toThrow();
    expect(() => validateGmailRecipientCount(Array(MAX_GMAIL_RECIPIENTS).fill("a@b.com")))
      .not.toThrow();
  });

  it.each([["none", 0], ["one over the maximum", MAX_GMAIL_RECIPIENTS + 1]])(
    "rejects %s", (_name, count) => {
      expect(() => validateGmailRecipientCount(Array(count).fill("a@b.com")))
        .toThrow(/between 1 and/);
    });
});

describe("validateOutboundInput", () => {
  it("accepts a well-formed message", () => {
    expect(() => validateOutboundInput(["a@b.com"], "Subject", "Body")).not.toThrow();
  });

  it("rejects an empty recipient among valid ones", () => {
    expect(() => validateOutboundInput(["a@b.com", ""], "s", "b")).toThrow();
  });

  it("applies the subject limit in bytes", () => {
    expect(() => validateOutboundInput(["a@b.com"], wide(MAX_GMAIL_SUBJECT_BYTES), "b"))
      .not.toThrow();
    expect(() => validateOutboundInput(["a@b.com"], wide(MAX_GMAIL_SUBJECT_BYTES + 2), "b"))
      .toThrow(/subject/);
  });
});
