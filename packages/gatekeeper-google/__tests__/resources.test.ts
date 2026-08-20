import { describe, expect, it } from "vitest";
import {
  BIGQUERY_RESOURCE, GMAIL_RESOURCE, GOOGLE_CALENDAR_RESOURCE, GOOGLE_DOC_RESOURCE,
  GOOGLE_SHEETS_RESOURCE, IDENTITY_SCOPES, LEGACY_GRANTED_RESOURCE_URL_PATTERNS, RESOURCE_BY_KIND,
  RESOURCE_SCOPES, SUPPORTED_RESOURCES, grantedResourcesFromScopes, parseResourceUrl,
  resourceUrlPatternsToOAuthScopes, validateResourceUrlPatterns,
} from "../src/resources";

/** The message `parseResourceUrl` rejects `url` with. Fails the test if it accepts it. */
function messageFor(url: string): string {
  try {
    parseResourceUrl(url);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected ${url} to be rejected`);
}

describe("resource declarations", () => {
  // A urlPattern is permanent identity: it keys admin disable-sets, blueprint typeUrlPatterns and
  // recorded grants, so changing one after deploy orphans every binding that used it.
  it("pins every grantable resource's urlPattern", () => {
    expect(SUPPORTED_RESOURCES.map(r => r.urlPattern)).toEqual([
      "https://mail.google.com/*",
      "https://docs.google.com/document/d/:docId/*",
      "https://docs.google.com/spreadsheets/d/:spreadsheetId/*",
      "https://calendar.google.com/calendar/:calendarId/*",
      "https://bigquery.googleapis.com/:projectId/*",
    ]);
  });

  it("has a distinct pattern per resource", () => {
    let patterns = SUPPORTED_RESOURCES.map(r => r.urlPattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  // Adding an entry short-circuits ensureResources, so a legacy account would be treated as
  // already holding a grant it never made and would never be re-prompted for consent.
  it("keeps the legacy granted set frozen at Gmail, Doc and BigQuery", () => {
    expect(LEGACY_GRANTED_RESOURCE_URL_PATTERNS).toEqual([
      GMAIL_RESOURCE.urlPattern,
      GOOGLE_DOC_RESOURCE.urlPattern,
      BIGQUERY_RESOURCE.urlPattern,
    ]);
  });

  it("maps every parse kind to a declared resource", () => {
    for (let resource of Object.values(RESOURCE_BY_KIND)) {
      expect(SUPPORTED_RESOURCES).toContain(resource);
    }
    expect(new Set(Object.values(RESOURCE_BY_KIND)).size).toBe(SUPPORTED_RESOURCES.length);
  });
});

describe("resourceUrlPatternsToOAuthScopes", () => {
  it("always includes the identity scopes", () => {
    expect(resourceUrlPatternsToOAuthScopes([])).toEqual(IDENTITY_SCOPES);
  });

  // undefined means "every resource"; [] means "none". Conflating them would silently grant a
  // billing-only connection full resource access, or strip a full one.
  it("distinguishes undefined (all resources) from [] (none)", () => {
    expect(resourceUrlPatternsToOAuthScopes(undefined).length)
      .toBeGreaterThan(resourceUrlPatternsToOAuthScopes([]).length);
  });

  it("returns exactly the requested resource's scopes plus identity", () => {
    expect(resourceUrlPatternsToOAuthScopes([BIGQUERY_RESOURCE.urlPattern])).toEqual([
      ...IDENTITY_SCOPES,
      "https://www.googleapis.com/auth/bigquery",
    ]);
  });

  it("deduplicates scopes shared between resources", () => {
    let scopes = resourceUrlPatternsToOAuthScopes(
      [GOOGLE_DOC_RESOURCE.urlPattern, GOOGLE_SHEETS_RESOURCE.urlPattern]);
    expect(scopes).toContain("https://www.googleapis.com/auth/drive.metadata.readonly");
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it("rejects an unknown pattern rather than silently ignoring it", () => {
    expect(() => resourceUrlPatternsToOAuthScopes(["https://drive.google.com/*"]))
      .toThrow(/Unknown grantable resource/);
  });
});

describe("grantedResourcesFromScopes", () => {
  it("round-trips every resource through its own scopes", () => {
    for (let { resource } of RESOURCE_SCOPES) {
      let scopes = resourceUrlPatternsToOAuthScopes([resource.urlPattern]);
      expect(grantedResourcesFromScopes(scopes)).toContain(resource.urlPattern);
    }
  });

  it("round-trips the full grant", () => {
    expect(grantedResourcesFromScopes(resourceUrlPatternsToOAuthScopes(undefined)))
      .toEqual(SUPPORTED_RESOURCES.map(r => r.urlPattern));
  });

  it("reports nothing for identity scopes alone", () => {
    expect(grantedResourcesFromScopes(IDENTITY_SCOPES)).toEqual([]);
  });

  // Recording a wider grant than was actually made makes ensureResources short-circuit into a
  // binding that 403s, with no way to re-prompt.
  it("fails closed on a partial grant", () => {
    let calendar = RESOURCE_SCOPES.find(e => e.resource === GOOGLE_CALENDAR_RESOURCE)!;
    expect(calendar.scopes.length).toBeGreaterThan(1);
    expect(grantedResourcesFromScopes(calendar.scopes.slice(0, 1)))
      .not.toContain(GOOGLE_CALENDAR_RESOURCE.urlPattern);
  });

  it("ignores scopes it does not know", () => {
    expect(grantedResourcesFromScopes(["https://www.googleapis.com/auth/drive"])).toEqual([]);
  });
});

describe("validateResourceUrlPatterns", () => {
  it("accepts undefined and every known pattern", () => {
    expect(() => validateResourceUrlPatterns(undefined)).not.toThrow();
    expect(() => validateResourceUrlPatterns(SUPPORTED_RESOURCES.map(r => r.urlPattern)))
      .not.toThrow();
  });

  it("names each unknown pattern", () => {
    expect(() => validateResourceUrlPatterns(["https://a.example/", "https://b.example/"]))
      .toThrow(/https:\/\/a\.example\/, https:\/\/b\.example\//);
  });
});

describe("parseResourceUrl", () => {
  describe("unsupported URLs", () => {
    // Regression: Gmail used to be the fallback branch, so any unrecognised Google URL minted a
    // full mailbox binding. The caller derives the resource -- and hence the admin disable check
    // and the recorded typeUrlPattern -- from what this returns.
    it.each([
      "https://drive.google.com/drive/folders/abc",
      "https://drive.google.com/file/d/abc/view",
      "https://groups.google.com/g/team",
      "https://mail.google.com.evil.example/",
      "https://example.com/",
    ])("rejects %s instead of falling back to Gmail", url => {
      expect(() => parseResourceUrl(url)).toThrow(/Unsupported Google resource URL/);
    });

    it("rejects a docs.google.com path that is neither a doc nor a sheet", () => {
      expect(() => parseResourceUrl("https://docs.google.com/presentation/d/abc/edit"))
        .toThrow(/Unsupported Google Docs resource URL/);
    });

    it("rejects a calendar.google.com path outside /calendar/", () => {
      expect(() => parseResourceUrl("https://calendar.google.com/other/abc"))
        .toThrow(/Unsupported Google Calendar resource URL/);
    });

    it("rejects a non-https URL", () => {
      expect(() => parseResourceUrl("http://mail.google.com/")).toThrow(/must use https/);
    });

    it("rejects a string that is not a URL", () => {
      expect(() => parseResourceUrl("mail.google.com")).toThrow(/Not a valid resource URL/);
    });

    // These errors reach the Workshop UI and are logged by their catchers, so the parts of a
    // caller-supplied URL that carry content or credentials must not ride along.
    describe("error messages", () => {

      it("omits the fragment, which for Gmail is a search query", () => {
        let message = messageFor(
          "https://docs.google.com/presentation/d/abc/edit#search/acquisition+target");
        expect(message).not.toContain("acquisition");
        expect(message).toContain("docs.google.com/presentation/d/abc/edit");
      });

      it("omits query parameters", () => {
        expect(messageFor("https://calendar.google.com/other?token=sekrit"))
          .not.toContain("sekrit");
      });

      it("omits credentials embedded in the authority", () => {
        let message = messageFor("https://user:hunter2@docs.google.com/presentation/d/abc");
        expect(message).not.toContain("hunter2");
        expect(message).not.toContain("user");
      });

      it("quotes back nothing at all from an unparseable string", () => {
        expect(messageFor("not a url at all sekrit")).toBe("Not a valid resource URL.");
      });

      it("names only the host for an unsupported one", () => {
        expect(messageFor("https://groups.google.com/g/team?invite=sekrit"))
          .toBe("Unsupported Google resource URL host: groups.google.com");
      });

      it("names only the scheme for a non-https URL", () => {
        expect(messageFor("http://mail.google.com/#search/sekrit"))
          .toBe("Google resource URLs must use https, not http:");
      });
    });
  });

  describe("gmail", () => {
    it("treats a bare mailbox and #inbox as unscoped", () => {
      expect(parseResourceUrl("https://mail.google.com/")).toEqual({ kind: "gmail" });
      expect(parseResourceUrl("https://mail.google.com/#inbox")).toEqual({ kind: "gmail" });
    });

    it("decodes a search scope, normalizing Gmail's + for space", () => {
      expect(parseResourceUrl("https://mail.google.com/#search/from%3Aa%40b.com+urgent"))
        .toEqual({ kind: "gmail", searchQuery: "from:a@b.com urgent" });
    });

    it("decodes a label scope and keeps it opaque", () => {
      expect(parseResourceUrl("https://mail.google.com/#label/Team%2FAlerts"))
        .toEqual({ kind: "gmail", labelName: "Team/Alerts" });
    });

    // A label is resolved to an ID at session start, so a name that looks like search syntax must
    // survive parsing intact rather than being validated as a query.
    it("does not apply query validation to a label name", () => {
      expect(parseResourceUrl("https://mail.google.com/#label/a(b"))
        .toEqual({ kind: "gmail", labelName: "a(b" });
    });

    it("rejects a search scope with unbalanced grouping", () => {
      expect(() => parseResourceUrl("https://mail.google.com/#search/%28a"))
        .toThrow(/unterminated grouping/);
    });

    it("rejects an empty label", () => {
      expect(() => parseResourceUrl("https://mail.google.com/#label/")).toThrow(/label name/);
    });

    it("rejects an unrecognised view", () => {
      expect(() => parseResourceUrl("https://mail.google.com/#sent"))
        .toThrow(/Unsupported Gmail view/);
    });
  });

  describe("docs and sheets", () => {
    it("extracts a document ID, ignoring trailing path", () => {
      expect(parseResourceUrl("https://docs.google.com/document/d/DOC123/edit?usp=sharing"))
        .toEqual({ kind: "doc", documentId: "DOC123" });
    });

    it("extracts a spreadsheet ID", () => {
      expect(parseResourceUrl("https://docs.google.com/spreadsheets/d/SHEET123/edit#gid=0"))
        .toEqual({ kind: "sheets", spreadsheetId: "SHEET123" });
    });

    it.each([
      ["document", "https://docs.google.com/document/d/"],
      ["spreadsheet", "https://docs.google.com/spreadsheets/d/"],
    ])("rejects a %s URL with no ID", (_name, url) => {
      expect(() => parseResourceUrl(url)).toThrow(/no .* ID found/);
    });
  });

  describe("calendar", () => {
    it("decodes the calendar ID and defaults to the narrow availability mode", () => {
      expect(parseResourceUrl("https://calendar.google.com/calendar/a%40b.com"))
        .toEqual({ kind: "calendar", calendarId: "a@b.com", availabilityMode: "thisCalendar" });
    });

    it("opts into allVisible only on the exact query value", () => {
      expect(parseResourceUrl("https://calendar.google.com/calendar/c1?availability=allVisible"))
        .toMatchObject({ availabilityMode: "allVisible" });
      expect(parseResourceUrl("https://calendar.google.com/calendar/c1?availability=yes"))
        .toMatchObject({ availabilityMode: "thisCalendar" });
    });

    // "primary" resolves per account, so a binding using it would not name a stable calendar.
    it("rejects the account-relative primary alias", () => {
      expect(() => parseResourceUrl("https://calendar.google.com/calendar/primary"))
        .toThrow(/stable calendar ID/);
    });

    it("rejects a missing calendar ID", () => {
      expect(() => parseResourceUrl("https://calendar.google.com/calendar/"))
        .toThrow(/no calendar ID found/);
    });
  });

  describe("bigquery", () => {
    it.each([
      ["project", "https://bigquery.googleapis.com/proj",
        { projectId: "proj", datasetId: undefined, tableId: undefined }],
      ["dataset", "https://bigquery.googleapis.com/proj/ds",
        { projectId: "proj", datasetId: "ds", tableId: undefined }],
      ["table", "https://bigquery.googleapis.com/proj/ds/tbl",
        { projectId: "proj", datasetId: "ds", tableId: "tbl" }],
    ])("scopes to a %s", (_name, url, expected) => {
      expect(parseResourceUrl(url)).toEqual({ kind: "bigquery", ...expected });
    });

    it("tolerates redundant slashes and decodes segments", () => {
      expect(parseResourceUrl("https://bigquery.googleapis.com//proj//my%20ds/"))
        .toEqual({ kind: "bigquery", projectId: "proj", datasetId: "my ds", tableId: undefined });
    });

    it.each([
      ["no project", "https://bigquery.googleapis.com/", /must include a project ID/],
      ["too many segments", "https://bigquery.googleapis.com/a/b/c/d", /must be/],
      ["a query string", "https://bigquery.googleapis.com/proj?x=1", /query strings or fragments/],
      ["a fragment", "https://bigquery.googleapis.com/proj#x", /query strings or fragments/],
    ])("rejects %s", (_name, url, message) => {
      expect(() => parseResourceUrl(url)).toThrow(message);
    });
  });
});
