// A configurator's `resourceUrl` mints the string that `parseResourceUrl` then turns into a
// capability, and its `initialValuesFromResourceUrl` reads a URL the user pasted back into form
// values. Neither can import `resources.ts`: `scripts/build-gatekeeper-configurator.ts` transpiles
// each configurator module on its own, stripping only `@gadgets/configurator-ui` and type-only
// imports, so a runtime import would not resolve inside the sandboxed frame. The duplication is
// deliberate; this test is what keeps the copies honest. Drift on either side -- a lost
// `encodeURIComponent`, a normalization one side does and the other does not -- shows up here
// rather than as a resource the backend rejects after the user has filled the form.

import { describe, expect, it } from "vitest";
import gmailConfigurator from "../src/configurator/gmail-configurator-ui";
import { GMAIL_RESOURCE, parseResourceUrl } from "../src/resources";

// The configurators never call `ui` from these two methods; it is present only to satisfy the
// context type, and touching it is a bug.
const noUi = new Proxy({}, {
  get() { throw new Error("must not call the ui capability"); },
}) as never;

const gmailUrl = (values: Record<string, unknown>) =>
  gmailConfigurator.resourceUrl!({ values, ui: noUi }) as string;

const gmailValues = (resourceUrl: string) =>
  gmailConfigurator.initialValuesFromResourceUrl!({
    resourceUrl, resourceUrlPattern: GMAIL_RESOURCE.urlPattern, ui: noUi,
  });

describe("Gmail configurator URLs", () => {
  it.for([
    ["the whole mailbox", { mode: "all" }, { kind: "gmail" }],
    ["a search", { mode: "search", query: "from:alerts@example.com" },
      { kind: "gmail", searchQuery: "from:alerts@example.com" }],
    ["a search with spaces", { mode: "search", query: "is:unread subject:invoice" },
      { kind: "gmail", searchQuery: "is:unread subject:invoice" }],
    // A literal `+` in an address must survive as a `+`, not become a space.
    ["a search naming a plus address", { mode: "search", query: "to:nathan+receipts@example.com" },
      { kind: "gmail", searchQuery: "to:nathan+receipts@example.com" }],
    ["a label", { mode: "label", label: "Receipts" }, { kind: "gmail", labelName: "Receipts" }],
    ["a label with a slash", { mode: "label", label: "Work/Invoices" },
      { kind: "gmail", labelName: "Work/Invoices" }],
  ] as const)("builds a URL the server parses back for %s", ([, values, target]) => {
    expect(parseResourceUrl(gmailUrl(values))).toEqual(target);
  });

  it.for([
    [{ mode: "search", query: "is:unread subject:invoice" }],
    [{ mode: "search", query: "to:nathan+receipts@example.com" }],
    [{ mode: "label", label: "Work/Invoices" }],
    [{ mode: "all" }],
  ] as const)("round-trips %o through the URL and back to the same values", ([values]) => {
    expect(gmailValues(gmailUrl(values))).toEqual(values);
  });

  // Gmail's own UI writes spaces as `+`, so this is the shape of a URL copied from the address bar
  // rather than one this configurator built. Both sides have to read it the same way, or the form
  // prefills a query that differs from the one the capability was granted for.
  it("reads a pasted Gmail URL the way the server does", () => {
    const pasted = "https://mail.google.com/mail/u/0/#search/is%3Aunread+subject%3Ainvoice";

    expect(gmailValues(pasted)).toEqual({ mode: "search", query: "is:unread subject:invoice" });
    expect(parseResourceUrl(pasted)).toEqual({
      kind: "gmail", searchQuery: "is:unread subject:invoice",
    });
  });

  it("keeps an escaped plus literal in a pasted URL", () => {
    const pasted = "https://mail.google.com/mail/u/0/#search/to%3Anathan%2Breceipts%40example.com";

    expect(gmailValues(pasted))
      .toEqual({ mode: "search", query: "to:nathan+receipts@example.com" });
    expect(parseResourceUrl(pasted)).toEqual({
      kind: "gmail", searchQuery: "to:nathan+receipts@example.com",
    });
  });

  it("treats the inbox hash Gmail lands on as the whole mailbox, as the server does", () => {
    const inbox = "https://mail.google.com/mail/u/0/#inbox";

    expect(gmailValues(inbox)).toEqual({ mode: "all" });
    expect(parseResourceUrl(inbox)).toEqual({ kind: "gmail" });
  });
});
