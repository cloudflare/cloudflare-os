import { describe, expect, it } from "vitest";
import {
  combineGmailQueries, MAX_GMAIL_ADDRESS_BYTES, MAX_GMAIL_BODY_BYTES, MAX_GMAIL_LABEL_BYTES,
  MAX_GMAIL_QUERY_BYTES, MAX_GMAIL_RECIPIENTS, MAX_GMAIL_SUBJECT_BYTES, validateGmailAddress,
  validateGmailBody, validateGmailBodyAlternatives, validateGmailLabelName, validateGmailQueryForGrouping,
  validateGmailRecipientCount, validateOutboundInput,
} from "../src/gmail-validate";

// Multi-byte, so a byte limit and a length limit can be told apart.
const wide = (bytes: number) => "\u00e9".repeat(bytes / 2);

describe("validateGmailQueryForGrouping", () => {
  it.each([
    ["plain terms", "from:someone subject:hello"],
    ["balanced parens", "(a OR b) AND c"],
    ["balanced braces", "{a b} c"],
    ["nested", "((a) {b})"],
    ["quoted paren", 'subject:"a ) b"'],
    ["apostrophe", "from:o'connor@example.com"],
  ])("accepts %s", (_name, query) => {
    expect(() => validateGmailQueryForGrouping(query)).not.toThrow();
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["unclosed paren", "(a"],
    ["unopened paren", "a)"],
    ["unclosed brace", "{a"],
    ["crossed delimiters", "({a)}"],
    ["unterminated double quote", 'subject:"a'],
    ["escaped closing quote leaves it open", 'subject:"a\\"'],
    ["backslash outside a phrase", "a \\( b"],
    ["backslash cannot hide a wrapper close", "a \\) OR secret"],
    ["backslash inside a phrase", 'subject:"a \\" b"'],
    ["single quote cannot hide a wrapper close", "subject:'a) OR secret"],
    ["control character", "from:a@example.com\nOR from:attacker@example.com"],
  ])("rejects %s", (_name, query) => {
    expect(() => validateGmailQueryForGrouping(query)).toThrow();
  });

  // The base and caller queries are combined as `(base) AND (caller)`, so an unbalanced delimiter in
  // either would swallow the other's parentheses and escape the binding's restriction.
  it("rejects a query that would close the wrapping group early", () => {
    expect(() => validateGmailQueryForGrouping(") OR (")).toThrow();
  });

  it("counts the query limit in bytes, not characters", () => {
    expect(() => validateGmailQueryForGrouping(wide(MAX_GMAIL_QUERY_BYTES))).not.toThrow();
    expect(() => validateGmailQueryForGrouping(wide(MAX_GMAIL_QUERY_BYTES + 2))).toThrow(/at most/);
  });

  it("rejects provider-ambiguous escapes inside a phrase", () => {
    expect(() => validateGmailQueryForGrouping('subject:"a \\) b"')).toThrow(/backslash/);
  });
});

describe("combineGmailQueries", () => {
  it("places both validated queries in explicit AND groups", () => {
    expect(combineGmailQueries("label:receipts", "from:shop@example.com"))
      .toBe("(label:receipts) AND (from:shop@example.com)");
  });

  it("rejects a leading boolean operator", () => {
    expect(() => combineGmailQueries("label:receipts", "OR in:anywhere"))
      .toThrow(/cannot start/);
  });

  it("validates the final effective query length, including wrappers", () => {
    const half = "a".repeat(MAX_GMAIL_QUERY_BYTES / 2);
    expect(() => validateGmailQueryForGrouping(half)).not.toThrow();
    expect(() => combineGmailQueries(half, half)).toThrow(/at most/);
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

  it("bounds the combined plain-text and HTML staged value", () => {
    expect(() => validateGmailBodyAlternatives(
      "a".repeat(MAX_GMAIL_BODY_BYTES / 2), "b".repeat(MAX_GMAIL_BODY_BYTES / 2)))
      .not.toThrow();
    expect(() => validateGmailBodyAlternatives(
      "a".repeat(MAX_GMAIL_BODY_BYTES / 2 + 1), "b".repeat(MAX_GMAIL_BODY_BYTES / 2)))
      .toThrow(/total/);
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
