// A configurator's `resourceUrl` mints the string that `parseResourceUrl` then turns into a
// capability, and its `initialValuesFromResourceUrl` reads a URL the user pasted back into form
// values. Neither can import `resources.ts`: `scripts/build-gatekeeper-configurator.ts` transpiles
// each configurator module on its own, stripping only `@gadgets/configurator-ui` and type-only
// imports, so a runtime import would not resolve inside the sandboxed frame. The duplication is
// deliberate; this test is what keeps the copies honest. Drift on either side -- a lost
// `encodeURIComponent`, a normalization one side does and the other does not -- shows up here
// rather than as a resource the backend rejects after the user has filled the form.

import { describe, expect, it, vi } from "vitest";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({
    component, props, children,
  }),
  Autocomplete: "Autocomplete",
  Field: "Field",
  RadioCards: "RadioCards",
  Section: "Section",
}));
import driveAccountConfigurator from "../src/configurator/drive-account-configurator-ui";
import driveFileConfigurator from "../src/configurator/drive-file-configurator-ui";
import calendarConfigurator from "../src/configurator/calendar-configurator-ui";
import type { CalendarConfiguratorRpc } from "../src/configurator/calendar-configurator-types";
import gmailConfigurator from "../src/configurator/gmail-configurator-ui";
import sharedDriveConfigurator from "../src/configurator/shared-drive-configurator-ui";
import {
  GMAIL_RESOURCE, GOOGLE_CALENDAR_RESOURCE, GOOGLE_DRIVE_FILE_RESOURCE, GOOGLE_DRIVE_RESOURCE,
  GOOGLE_SHARED_DRIVE_RESOURCE, parseResourceUrl,
} from "../src/resources";

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

const configurableUrl = (
  configurator: { resourceUrl?: (context: { values: Record<string, unknown>; ui: never }) => string },
  values: Record<string, unknown>,
) => configurator.resourceUrl!({ values, ui: noUi });

// Drive value keys match the urlPattern named groups, so the sandbox runtime's
// `defaultValuesFromResourceUrl` (not a per-module hook) is the prefill path. This is that fallback:
// URLPattern groups plus decodeURIComponent, ignoring numeric/wildcard names.
function valuesFromUrlPattern(resourceUrl: string, resourceUrlPattern: string) {
  const match = new URLPattern(resourceUrlPattern).exec(resourceUrl);
  const groups = match?.pathname.groups ?? {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(groups)) {
    if (typeof value === "string" && value.length > 0 && !/^[0-9]+$/.test(key)) {
      out[key] = decodeURIComponent(value);
    }
  }
  return out;
}

const renderedCopy = (configurator: { render?: (context: never) => unknown }) =>
  JSON.stringify(configurator.render!({ values: {}, setValues() {}, ui: noUi } as never));
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

describe("Calendar configurator URLs", () => {
  it("resolves an account-relative primary prefill to a stable calendar ID", async () => {
    const ui = {
      getPrimaryCalendarId: vi.fn(async () => "person@example.com"),
      listCalendars: vi.fn(),
    } as unknown as CalendarConfiguratorRpc;

    const values = await calendarConfigurator.initialValuesFromResourceUrl!({
      resourceUrl: "https://calendar.google.com/calendar/primary/?availability=allVisible",
      resourceUrlPattern: GOOGLE_CALENDAR_RESOURCE.urlPattern,
      ui,
    });
    const resourceUrl = calendarConfigurator.resourceUrl!({
      values, ui,
    });

    expect(calendarConfigurator.isReady!({ values: { calendarId: "primary" } })).toBe(false);
    expect(calendarConfigurator.isReady!({ values })).toBe(true);
    expect(ui.getPrimaryCalendarId).toHaveBeenCalledOnce();
    expect(parseResourceUrl(resourceUrl)).toEqual({
      kind: "calendar",
      calendarId: "person@example.com",
      availabilityMode: "allVisible",
    });
  });
});

describe("Drive configurator URLs", () => {
  it("mints the whole-account resource", () => {
    let url = configurableUrl(driveAccountConfigurator, { scope: "account" });
    expect(url).toBe(GOOGLE_DRIVE_RESOURCE.urlPattern);
    expect(parseResourceUrl(url)).toEqual({ kind: "driveAccount" });
  });

  it("explains native Doc and Sheet reads at every Drive scope", () => {
    expect(renderedCopy(driveAccountConfigurator)).toContain(
      "native Google Docs and Sheets can be opened in read-only content sessions.",
    );
    expect(renderedCopy(sharedDriveConfigurator)).toContain(
      "Search its files and read native Google Docs and Sheets.",
    );
    expect(renderedCopy(driveFileConfigurator)).toContain(
      "A selected native Google Doc or Sheet also provides read-only content.",
    );
  });

  it("round-trips an encoded shared-drive ID", () => {
    let values = { driveId: "shared/id with spaces" };
    let url = configurableUrl(sharedDriveConfigurator, values);
    expect(url).toBe(
      GOOGLE_SHARED_DRIVE_RESOURCE.urlPattern.replace(":driveId", encodeURIComponent(values.driveId)),
    );
    expect(parseResourceUrl(url)).toEqual({ kind: "sharedDrive", driveId: values.driveId });
  });

  it("round-trips an encoded file ID", () => {
    let values = { fileId: "file/id with spaces" };
    let url = configurableUrl(driveFileConfigurator, values);
    expect(url).toBe(
      GOOGLE_DRIVE_FILE_RESOURCE.urlPattern.replace(":fileId", encodeURIComponent(values.fileId)),
    );
    expect(parseResourceUrl(url)).toEqual({ kind: "driveFile", fileId: values.fileId });
  });

  // Prefill after deleting the hand-written hooks: the sandbox fallback extracts named groups and
  // decodeURIComponent's them. A missing decode would leave `%2F`/`%20` in the form values.
  it("prefills encoded IDs from urlPattern named groups", () => {
    let driveValues = { driveId: "shared/id with spaces" };
    let driveUrl = configurableUrl(sharedDriveConfigurator, driveValues);
    expect(valuesFromUrlPattern(driveUrl, GOOGLE_SHARED_DRIVE_RESOURCE.urlPattern))
      .toEqual(driveValues);

    let fileValues = { fileId: "file/id with spaces" };
    let fileUrl = configurableUrl(driveFileConfigurator, fileValues);
    expect(valuesFromUrlPattern(fileUrl, GOOGLE_DRIVE_FILE_RESOURCE.urlPattern))
      .toEqual(fileValues);
  });
});
