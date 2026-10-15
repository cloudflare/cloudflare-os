import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessTokenRequest } from "../../src/auth-retry";
import type { GoogleDocConfiguratorRpc } from "../../src/configurator/google-doc-configurator-types";
import { GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, GOOGLE_SLIDES_MIME_TYPE } from "../../src/drive-session";
import { GatekeeperUserImpl, type UserAccount } from "../../src/google";
import {
  calendarPickerRank, hasCalendarPrivateAccessRole, hasCalendarWriteRole,
} from "../../src/calendar-api";
import {
  BigQueryConfiguratorUI, CalendarConfiguratorUI, DriveFolderConfiguratorUI, GoogleDocConfiguratorUI,
  GoogleSheetsConfiguratorUI, GoogleSlidesConfiguratorUI,
} from "../../src/google-configurators";
import type { GoogleAccessToken } from "../../src/google-api";
import { OfficeConversion } from "../../src/office-conversion";
import {
  GOOGLE_DOC_RESOURCE, GOOGLE_SHEETS_RESOURCE, GOOGLE_SLIDES_RESOURCE, OFFICE_IMPORT_GRANT,
  resourceUrlPatternsToOAuthScopes,
} from "../../src/resources";

const token = (value: string): GoogleAccessToken => ({
  token: value,
  expires: new Date(Date.now() + 3600_000),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Google resource configurators", () => {
  it("resolves the primary Calendar alias to its stable ID", async () => {
    let getToken = vi.fn(async () => token("access-token"));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "person@example.com",
      summary: "Primary calendar",
      primary: true,
    })));

    await expect(new CalendarConfiguratorUI(getToken).getPrimaryCalendarId())
      .resolves.toBe("person@example.com");
  });

  // One provider page across every corpus the account reaches. A continuation token is normal for
  // an interactive picker, so it must neither be followed nor treated as a failure.
  it("offers listable folders from every corpus in one all-drives request", async () => {
    const calls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls.push(new URL(input instanceof Request ? input.url : input.toString()));
      return Response.json({
        nextPageToken: "next",
        files: [
          { id: "mine", name: "Team plans", capabilities: { canListChildren: true } },
          {
            id: "shared-with-me", name: "Team budget",
            owners: [{ displayName: "Ada" }], capabilities: { canListChildren: true },
          },
          {
            id: "in-drive", name: "Team drive folder", driveId: "drive-1",
            capabilities: { canListChildren: true },
          },
          { id: "metadata-only", name: "Team archive", capabilities: { canListChildren: false } },
        ],
      });
    }));

    await expect(new DriveFolderConfiguratorUI(async () => token("access-token"))
      .listDriveFolders("Team"))
      .resolves.toEqual([
        { value: "mine", title: "Team plans", subtitle: "My Drive", meta: "mine" },
        { value: "shared-with-me", title: "Team budget", subtitle: "Ada", meta: "…-with-me" },
        {
          value: "in-drive", title: "Team drive folder", subtitle: "In a shared drive",
          meta: "in-drive",
        },
      ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("corpora")).toBe("allDrives");
    expect(calls[0].searchParams.get("q")).toBe(
      "trashed = false and mimeType = 'application/vnd.google-apps.folder' and " +
      "name contains 'Team'",
    );
  });

  // Duplicate folder names across shared drives are ordinary, and every other column matches, so
  // without a differentiator the user cannot see which capability they are about to grant.
  it("tells same-named folders apart", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      files: [
        {
          id: "1AbCdEfGhIjKlMnOpQrStUv_platform", name: "Engineering", driveId: "drive-1",
          capabilities: { canListChildren: true },
        },
        {
          id: "1AbCdEfGhIjKlMnOpQrStUv_marketing", name: "Engineering", driveId: "drive-2",
          capabilities: { canListChildren: true },
        },
      ],
    })));

    const options = await new DriveFolderConfiguratorUI(async () => token("access-token"))
      .listDriveFolders("Engineering");

    expect(options.map(option => [option.title, option.subtitle])).toEqual([
      ["Engineering", "In a shared drive"],
      ["Engineering", "In a shared drive"],
    ]);
    expect(options.map(option => option.meta)).toEqual(["…platform", "…arketing"]);
  });

  it("offers every calendar the account can write, including limited writers", async () => {
    let getToken = vi.fn(async () => token("access-token"));
    let requestUrl: URL | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requestUrl = new URL(input instanceof Request ? input.url : input);
      return Response.json({ items: [] });
    }));

    await new CalendarConfiguratorUI(getToken).listCalendars("");

    expect(requestUrl?.searchParams.get("minAccessRole")).toBe("writerWithoutPrivateAccess");
  });

  // A limited writer can edit the calendar but not see private events, so it may be chosen as a
  // binding target yet must not be admitted as an observer of one.
  it("separates write access from private-event access only for limited writers", () => {
    const calendar = (accessRole: string) => ({
      id: "shared@example.com", summary: "Shared", accessRole,
    } as Parameters<typeof hasCalendarWriteRole>[0]);

    for (const role of ["owner", "writer"]) {
      expect(hasCalendarWriteRole(calendar(role))).toBe(true);
      expect(hasCalendarPrivateAccessRole(calendar(role))).toBe(true);
    }
    expect(hasCalendarWriteRole(calendar("writerWithoutPrivateAccess"))).toBe(true);
    expect(hasCalendarPrivateAccessRole(calendar("writerWithoutPrivateAccess"))).toBe(false);
    for (const role of ["reader", "freeBusyReader", "none"]) {
      expect(hasCalendarWriteRole(calendar(role))).toBe(false);
      expect(hasCalendarPrivateAccessRole(calendar(role))).toBe(false);
    }
    expect(calendarPickerRank(calendar("writerWithoutPrivateAccess")))
      .toBeLessThan(calendarPickerRank(calendar("reader")));
  });

  it.each([
    ["owner", true],
    ["writer", true],
    ["writerWithoutPrivateAccess", true],
    ["reader", false],
  ] as const)("reports %s access accurately for an exact calendar", async (accessRole, expected) => {
    let getToken = vi.fn(async () => token("access-token"));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "shared@example.com",
      summary: "Shared calendar",
      accessRole,
    })));

    await expect(new CalendarConfiguratorUI(getToken).canWriteCalendar("shared@example.com"))
      .resolves.toBe(expected);
  });

  it("treats inaccessible exact calendars as unavailable", async () => {
    let getToken = vi.fn(async () => token("access-token"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    await expect(new CalendarConfiguratorUI(getToken).canWriteCalendar("private@example.com"))
      .resolves.toBe(false);
  });

  it("surfaces transient exact-calendar failures", async () => {
    let getToken = vi.fn(async () => token("access-token"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 500 })));

    await expect(new CalendarConfiguratorUI(getToken).canWriteCalendar("shared@example.com"))
      .rejects.toThrow("Google Calendar API request failed: 500");
  });

  it("does not mistake a quota 403 for missing Calendar access", async () => {
    let getToken = vi.fn(async () => token("access-token"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limit", { status: 403 })));

    await expect(new CalendarConfiguratorUI(getToken).canWriteCalendar("shared@example.com"))
      .rejects.toThrow("Google Calendar API request failed: 403");
  });

  it("refreshes a rejected Calendar access token", async () => {
    let getToken = vi.fn(async (opts?: AccessTokenRequest) =>
      token(opts?.forceRefresh ? "fresh" : "stale"));
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      let authorization = new Headers(init?.headers).get("Authorization");
      if (authorization === "Bearer stale") {
        return Response.json({ error: { code: 401 } }, { status: 401 });
      }
      return Response.json({
        items: [{ id: "person@example.com", summary: "Primary calendar", primary: true }],
      });
    }));

    await expect(new CalendarConfiguratorUI(getToken).listCalendars(""))
      .resolves.toEqual([{
        value: "person@example.com",
        title: "Primary calendar",
        subtitle: "Primary calendar",
        meta: undefined,
      }]);
    expect(getToken.mock.calls).toEqual([
      [undefined],
      [{ forceRefresh: true, staleToken: "stale" }],
    ]);
  });

  it("reloads a widened BigQuery access token after a scope 403", async () => {
    let getToken = vi.fn(async (opts?: AccessTokenRequest) =>
      token(opts?.reloadStored ? "widened" : "narrow"));
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      let authorization = new Headers(init?.headers).get("Authorization");
      if (authorization === "Bearer narrow") {
        return Response.json({ error: { code: 403 } }, { status: 403 });
      }
      return Response.json({
        projects: [{
          id: "project-1",
          friendlyName: "Project One",
          projectReference: { projectId: "project-1" },
        }],
      });
    }));

    await expect(new BigQueryConfiguratorUI(getToken).listProjects(""))
      .resolves.toEqual([{
        value: "project-1",
        title: "project-1",
        subtitle: "Project One",
      }]);
    expect(getToken.mock.calls).toEqual([
      [undefined],
      [{ reloadStored: true }],
    ]);
  });
});

/** Every Doc, Sheets and Slides configurator has the same RPC surface beyond its listing. */
type OfficeConfigurator = Omit<GoogleDocConfiguratorRpc, "listDocs"> & {
  list(query: string): Promise<{ value: string; title: string; subtitle?: string; meta?: string }[]>;
};

type OfficeKindCase = {
  kind: "doc" | "sheets" | "slides";
  pattern: string;
  list: "listDocs" | "listSpreadsheets" | "listPresentations";
  title: "Docs" | "Sheets" | "Slides";
  native: string;
  office: string;
  label: string;
  /** A second Office type of the kind, spelled as Drive spells it. */
  other: string;
  otherLabel: string;
};

const OFFICE_KIND_CASES: OfficeKindCase[] = [
  {
    kind: "sheets", pattern: GOOGLE_SHEETS_RESOURCE.urlPattern, list: "listSpreadsheets",
    title: "Sheets", native: GOOGLE_SHEET_MIME_TYPE,
    office: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "xlsx",
    other: "application/vnd.ms-excel.sheet.macroEnabled.12", otherLabel: "xlsm",
  },
  {
    kind: "doc", pattern: GOOGLE_DOC_RESOURCE.urlPattern, list: "listDocs",
    title: "Docs", native: GOOGLE_DOC_MIME_TYPE,
    office: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "docx", other: "application/msword", otherLabel: "doc",
  },
  {
    kind: "slides", pattern: GOOGLE_SLIDES_RESOURCE.urlPattern, list: "listPresentations",
    title: "Slides", native: GOOGLE_SLIDES_MIME_TYPE,
    office: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    label: "pptx", other: "application/vnd.ms-powerpoint", otherLabel: "ppt",
  },
];

type FakeFile = {
  id: string;
  name: string;
  mimeType: string;
  trashed?: boolean;
  parents?: string[];
  canCopy?: boolean;
  createdTime?: string;
  modifiedTime?: string;
  /** Whether the account may edit it; another user's copy reads as not. Defaults to true. */
  canEdit?: boolean;
  appProperties?: Record<string, string>;
};

const notFound = () =>
  Response.json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, { status: 404 });

/** Drive as the configurators reach it: file reads, listings, about, and copies, each recorded. */
class FakeDrive {
  files = new Map<string, FakeFile>();
  writableFolders = new Set<string>(["folder-1"]);
  readonly requests: { method: string; url: URL; body?: any }[] = [];

  constructor(...files: FakeFile[]) {
    for (let file of files) this.files.set(file.id, file);
  }

  get copies() {
    return this.requests.filter(request => request.method === "POST");
  }

  install(): this {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      let url = new URL(input instanceof Request ? input.url : input.toString());
      let method = init?.method ?? "GET";
      let body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      this.requests.push({ method, url, ...(body === undefined ? {} : { body }) });
      return this.#answer(method, url, body);
    }));
    return this;
  }

  #answer(method: string, url: URL, body: any): Response {
    if (url.hostname !== "www.googleapis.com") throw new Error(`Unexpected request: ${url}`);
    let path = url.pathname.replace("/drive/v3", "");
    if (path === "/about") return Response.json({ maxImportSizes: {} });
    if (path === "/files") {
      let q = url.searchParams.get("q") ?? "";
      let sourceId = /appProperties has \{ key='gadgetsConvertedFrom' and value='([^']+)' \}/.exec(q)?.[1];
      let files = [...this.files.values()].filter(file => sourceId === undefined
        ? q.includes(`mimeType = '${file.mimeType}'`)
        : file.appProperties?.gadgetsConvertedFrom === sourceId && !file.trashed);
      return Response.json({ files: files.map(file => this.#fields(file)) });
    }
    let copy = /^\/files\/([^/]+)\/copy$/.exec(path);
    if (copy && method === "POST") {
      let made: FakeFile = {
        id: `copy-of-${copy[1]}`, name: body.name, mimeType: body.mimeType, trashed: false,
        parents: body.parents, createdTime: "2026-10-15T10:00:00.000Z",
        appProperties: body.appProperties,
      };
      this.files.set(made.id, made);
      return Response.json(this.#fields(made));
    }
    let id = /^\/files\/([^/]+)$/.exec(path)?.[1];
    if (url.searchParams.get("fields") === "capabilities(canAddChildren)") {
      return Response.json({ capabilities: { canAddChildren: this.writableFolders.has(id!) } });
    }
    let file = id === undefined ? undefined : this.files.get(id);
    return file ? Response.json(this.#fields(file)) : notFound();
  }

  #fields(file: FakeFile) {
    return {
      id: file.id, name: file.name, mimeType: file.mimeType, trashed: file.trashed ?? false,
      parents: file.parents, createdTime: file.createdTime, modifiedTime: file.modifiedTime,
      appProperties: file.appProperties,
      capabilities: { canCopy: file.canCopy ?? true, canEdit: file.canEdit ?? true },
    };
  }
}

/**
 * A connected account whose recorded grant is `granted`, and the configurator its gatekeeper starts
 * for `pattern`, reached through the RPC stub the iframe holds.
 */
async function startOfficeConfigurator(testCase: OfficeKindCase, granted: string[] = []) {
  let account = {
    getAccessToken: vi.fn(async () => token("access-token")),
    getGrantedResourceUrlPatterns: vi.fn(async () => granted),
  };
  let ctx = {
    props: { userObjectId: "account-id" },
    exports: { UserAccount: { idFromString: () => "account-id", get: () => account } },
  };
  let user = new GatekeeperUserImpl(ctx as never, {} as never);
  let frame = await user.startResourceConfigurator(testCase.pattern);
  let stub = frame.ui as unknown as Record<string, (...args: unknown[]) => Promise<any>>;
  // Each result is awaited into a plain promise: an RpcPromise is callable, and `expect().rejects`
  // would call it.
  let ui: OfficeConfigurator = {
    list: async query => await stub[testCase.list](query),
    inspectFile: async fileId => await stub.inspectFile(fileId),
    hasConversionAccess: async () => await stub.hasConversionAccess(),
    convertFile: async (fileId, opts) => opts === undefined
      ? await stub.convertFile(fileId) : await stub.convertFile(fileId, opts),
  };
  return { ui, account, user };
}

const OFFICE_CONFIGURATOR_UIS = {
  doc: GoogleDocConfiguratorUI, sheets: GoogleSheetsConfiguratorUI, slides: GoogleSlidesConfiguratorUI,
};

/**
 * The same configurator built directly rather than through the gatekeeper, for calls that reject:
 * workerd reports a rejection through a local RPC stub as uncaught even once it is handled.
 */
function directOfficeConfigurator(testCase: OfficeKindCase): OfficeConfigurator {
  let conversion = new OfficeConversion(testCase.kind, async () => "access-token", async () => true);
  let target = new OFFICE_CONFIGURATOR_UIS[testCase.kind](
    async () => token("access-token"), conversion,
  ) as unknown as Record<string, (...args: unknown[]) => Promise<any>>;
  return {
    list: query => target[testCase.list](query),
    inspectFile: fileId => target.inspectFile(fileId),
    hasConversionAccess: () => target.hasConversionAccess(),
    convertFile: (fileId, opts) => target.convertFile(fileId, opts),
  };
}

const officeSource = (testCase: OfficeKindCase, overrides: Partial<FakeFile> = {}): FakeFile => ({
  id: "source-1", name: `Report.${testCase.label}`, mimeType: testCase.office,
  parents: ["folder-1"], modifiedTime: "2026-10-01T00:00:00.000Z", ...overrides,
});

describe.each(OFFICE_KIND_CASES)("the $title configurator's Office files", testCase => {
  it("lists native files and the Office files a connect converts, labelled", async () => {
    let drive = new FakeDrive(
      { id: "native-1", name: "Report", mimeType: testCase.native },
      { id: "office-1", name: `Report.${testCase.label.toUpperCase()}`, mimeType: testCase.office },
      { id: "office-2", name: "Report draft", mimeType: testCase.other },
    ).install();
    let { ui } = await startOfficeConfigurator(testCase);

    let options = await ui.list("Report");

    expect(options).toEqual([
      { value: "native-1", title: "Report", subtitle: "" },
      {
        value: "office-1", title: `Report.${testCase.label.toUpperCase()}`, subtitle: "",
        meta: `Makes a Google ${testCase.title} copy`,
      },
      {
        value: "office-2", title: `Report draft (${testCase.otherLabel})`, subtitle: "",
        meta: `Makes a Google ${testCase.title} copy`,
      },
    ]);
    let q = drive.requests[0].url.searchParams.get("q")!;
    expect(q).toContain(`mimeType = '${testCase.native}' or `);
    expect(q).toContain(`mimeType = '${testCase.office}'`);
    expect(q).toContain(`mimeType = '${testCase.other}'`);
    expect(q).not.toContain("text/csv");
  });

  it("tells native, Office and unsupported files apart, with whether the owner allows copying", async () => {
    new FakeDrive(
      { id: "native-1", name: "Report", mimeType: testCase.native },
      officeSource(testCase),
      officeSource(testCase, { id: "locked-1", canCopy: false }),
      { id: "csv-1", name: "Report.csv", mimeType: "text/csv" },
    ).install();
    let { ui } = await startOfficeConfigurator(testCase);

    await expect(ui.inspectFile("native-1")).resolves.toEqual({ type: "native" });
    await expect(ui.inspectFile("source-1")).resolves.toEqual({
      type: "office", title: `Report.${testCase.label}`, label: testCase.label, canCopy: true,
    });
    await expect(ui.inspectFile("locked-1")).resolves
      .toEqual(expect.objectContaining({ type: "office", canCopy: false }));
    await expect(ui.inspectFile("csv-1")).resolves.toEqual({ type: "unsupported" });
  });

  it("refuses a trashed Office file as an answer the configurator can show", async () => {
    new FakeDrive(officeSource(testCase, { trashed: true })).install();
    let { ui } = await startOfficeConfigurator(testCase);

    await expect(ui.inspectFile("source-1")).resolves.toEqual({
      type: "refused", message: "This file is in the Drive trash. Restore it before converting it.",
    });
  });

  it("offers the copy made before, with the date it was made, and only one the account can edit", async () => {
    new FakeDrive(officeSource(testCase), {
      id: "theirs", name: "Report", mimeType: testCase.native, parents: ["shared-folder"],
      canEdit: false, createdTime: "2026-10-05T00:00:00.000Z",
      appProperties: { gadgetsConvertedFrom: "source-1" },
    }, {
      id: "copy-a", name: "Report", mimeType: testCase.native, parents: ["folder-1"],
      createdTime: "2026-10-04T00:00:00.000Z", appProperties: { gadgetsConvertedFrom: "source-1" },
    }).install();
    let { ui } = await startOfficeConfigurator(testCase);

    let inspection = await ui.inspectFile("source-1");

    expect(inspection).toEqual(expect.objectContaining({
      existingCopy: { fileId: "copy-a", title: "Report", convertedAt: new Date("2026-10-04T00:00:00.000Z") },
    }));
  });

  it("asks for access, without calling Drive, until the account holds the grant", async () => {
    let drive = new FakeDrive(officeSource(testCase)).install();
    let granted: string[] = [];
    let { ui, account } = await startOfficeConfigurator(testCase, granted);

    await expect(ui.hasConversionAccess()).resolves.toBe(false);
    await expect(ui.convertFile("source-1")).resolves.toEqual({ type: "needsAccess" });
    expect(drive.requests).toEqual([]);

    // The grant lands while the dialog is open, and the same configurator sees it.
    granted.push(OFFICE_IMPORT_GRANT);
    await expect(ui.hasConversionAccess()).resolves.toBe(true);
    expect(account.getGrantedResourceUrlPatterns).toHaveBeenCalledTimes(3);
  });

  it("copies an Office file beside the original once the grant is held", async () => {
    let info = vi.spyOn(console, "info").mockImplementation(() => {});
    let drive = new FakeDrive(officeSource(testCase)).install();
    let { ui } = await startOfficeConfigurator(testCase, [OFFICE_IMPORT_GRANT]);

    await expect(ui.convertFile("source-1")).resolves.toEqual({
      type: "converted", fileId: "copy-of-source-1", title: "Report", location: "besideOriginal",
      reused: false,
    });
    expect(drive.copies.map(copy => copy.body)).toEqual([{
      name: "Report", mimeType: testCase.native, parents: ["folder-1"],
      appProperties: { gadgetsConvertedFrom: "source-1", gadgetsSourceModified: "2026-10-01T00:00:00.000Z" },
    }]);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.office.converted", conversionKind: testCase.kind, fileId: "source-1",
      copyFileId: "copy-of-source-1",
    }));
  });

  it("copies into My Drive's root when the original's folder cannot take it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let drive = new FakeDrive(officeSource(testCase, { parents: ["read-only-folder"] })).install();
    let { ui } = await startOfficeConfigurator(testCase, [OFFICE_IMPORT_GRANT]);

    await expect(ui.convertFile("source-1")).resolves.toEqual(expect.objectContaining({
      type: "converted", location: "myDrive",
    }));
    expect(drive.copies.map(copy => copy.body.parents)).toEqual([["root"]]);
  });

  it("reuses a copy made before without the grant", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let drive = new FakeDrive(officeSource(testCase), {
      id: "copy-a", name: "Report", mimeType: testCase.native, parents: ["folder-1"],
      appProperties: { gadgetsConvertedFrom: "source-1" },
    }).install();
    let { ui, account } = await startOfficeConfigurator(testCase);

    await expect(ui.convertFile("source-1", { reuse: "copy-a" })).resolves.toEqual({
      type: "converted", fileId: "copy-a", title: "Report", location: "besideOriginal", reused: true,
    });
    expect(account.getGrantedResourceUrlPatterns).not.toHaveBeenCalled();
    expect(drive.copies).toEqual([]);
  });

  it("still reuses a copy made before once the owner has turned off copying", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let drive = new FakeDrive(officeSource(testCase, { canCopy: false }), {
      id: "copy-a", name: "Report", mimeType: testCase.native, parents: ["folder-1"],
      appProperties: { gadgetsConvertedFrom: "source-1" },
    }).install();
    let ui = directOfficeConfigurator(testCase);

    await expect(ui.convertFile("source-1", { reuse: "copy-a" })).resolves.toEqual(
      expect.objectContaining({ type: "converted", fileId: "copy-a", reused: true }));
    expect(drive.copies).toEqual([]);
  });

  it.each([
    ["a type this kind does not convert", { mimeType: "text/csv" }, "not an Office file"],
    ["a file whose owner turned off copying", { canCopy: false }, "turned off copying"],
    ["a trashed file", { trashed: true }, "Drive trash"],
  ])("refuses %s without asking Drive to copy it", async (_name, overrides, message) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let drive = new FakeDrive(officeSource(testCase, overrides)).install();
    let ui = directOfficeConfigurator(testCase);

    await expect(ui.convertFile("source-1")).rejects.toThrow(message);
    expect(drive.copies).toEqual([]);
  });

  it("refuses a malformed file ID before reaching Drive", async () => {
    let drive = new FakeDrive(officeSource(testCase)).install();
    let ui = directOfficeConfigurator(testCase);

    await expect(ui.convertFile("../source-1")).rejects.toThrow("Not a Google Drive file ID.");
    await expect(ui.convertFile("source-1", { reuse: "copy/1" }))
      .rejects.toThrow("Not a Google Drive file ID.");
    expect(drive.requests).toEqual([]);
  });

  it("reuses only a live copy that names this source", async () => {
    let info = vi.spyOn(console, "info").mockImplementation(() => {});
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let drive = new FakeDrive(
      officeSource(testCase),
      { id: "copy-a", name: "Report", mimeType: testCase.native, parents: ["folder-1"],
        appProperties: { gadgetsConvertedFrom: "source-1" } },
      { id: "copy-b", name: "Other", mimeType: testCase.native,
        appProperties: { gadgetsConvertedFrom: "source-2" } },
      { id: "copy-c", name: "Report", mimeType: testCase.native, trashed: true,
        appProperties: { gadgetsConvertedFrom: "source-1" } },
      { id: "copy-d", name: "Report", mimeType: testCase.native, canEdit: false,
        appProperties: { gadgetsConvertedFrom: "source-1" } },
    ).install();
    let ui = directOfficeConfigurator(testCase);

    await expect(ui.convertFile("source-1", { reuse: "copy-a" })).resolves.toEqual({
      type: "converted", fileId: "copy-a", title: "Report", location: "besideOriginal", reused: true,
    });
    await expect(ui.convertFile("source-1", { reuse: "copy-b" })).rejects.toThrow("no longer available");
    await expect(ui.convertFile("source-1", { reuse: "copy-c" })).rejects.toThrow("no longer available");
    await expect(ui.convertFile("source-1", { reuse: "copy-d" })).rejects.toThrow("no longer available");
    expect(drive.copies).toEqual([]);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.office.reused", conversionKind: testCase.kind, fileId: "source-1",
      copyFileId: "copy-a",
    }));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.office.failed", conversionKind: testCase.kind, fileId: "source-1",
      method: "reuse",
    }));
    expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain("Other");
  });
});

describe("the Office import grant", () => {
  it("is held by the account but left out of what the Workshop is told it was granted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      sub: "1234", name: "Ada", email: "ada@example.com", picture: "https://example.com/ada.png",
    })));
    let { user } = await startOfficeConfigurator(
      OFFICE_KIND_CASES[0], [GOOGLE_SHEETS_RESOURCE.urlPattern, OFFICE_IMPORT_GRANT]);

    let description = await user.describe();

    expect(description.grantedResourceUrlPatterns).toEqual([GOOGLE_SHEETS_RESOURCE.urlPattern]);
  });
});

const testEnv = env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> };
/** The storage key oauth-flow.ts keeps a prepared consent flow under. */
const OAUTH_FLOW_KEY = "oauthFlow";

/** A stored account whose recorded grant is `resourceUrlPatterns`, and the user entrypoint over it. */
async function storedAccount(resourceUrlPatterns: string[]) {
  let account = testEnv.UserAccount.get(testEnv.UserAccount.newUniqueId());
  await runInDurableObject(account, (_instance: unknown, state: DurableObjectState) => {
    state.storage.kv.put("refreshToken", "refresh-token");
    state.storage.kv.put("accessToken", token("access-token"));
    state.storage.kv.put("grantedResources", resourceUrlPatterns);
    state.storage.kv.put("grantedScopes", resourceUrlPatternsToOAuthScopes(resourceUrlPatterns));
  });
  let ctx = {
    props: { userObjectId: account.id.toString() },
    exports: { UserAccount: testEnv.UserAccount },
  };
  return { account, user: new GatekeeperUserImpl(ctx as never, {} as never) };
}

describe("the Office import grant on a stored account", () => {
  it("is kept by the account, so asking for it again needs no consent, but is never described", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      sub: "1234", name: "Ada", email: "ada@example.com", picture: "https://example.com/ada.png",
    })));
    let { account, user } = await storedAccount([GOOGLE_SHEETS_RESOURCE.urlPattern, OFFICE_IMPORT_GRANT]);

    expect(await account.getGrantedResourceUrlPatterns()).toEqual(
      expect.arrayContaining([GOOGLE_SHEETS_RESOURCE.urlPattern, OFFICE_IMPORT_GRANT]));
    await expect(user.ensureResources([OFFICE_IMPORT_GRANT])).resolves.toEqual({});
    expect((await user.describe()).grantedResourceUrlPatterns)
      .toEqual([GOOGLE_SHEETS_RESOURCE.urlPattern]);
  });

  it("is asked for, with everything already recorded, when the account does not hold it", async () => {
    let { account, user } = await storedAccount([GOOGLE_SHEETS_RESOURCE.urlPattern]);

    let { url } = await user.ensureResources([OFFICE_IMPORT_GRANT]);

    expect(url).toMatch(new RegExp(`/${account.id.toString()}/[^/]+$`));
    expect(await account.getGrantedResourceUrlPatterns()).not.toContain(OFFICE_IMPORT_GRANT);
    let flow = await runInDurableObject(account, (_instance: unknown, state: DurableObjectState) =>
      state.storage.kv.get<{ requestedResources: string[] }>(OAUTH_FLOW_KEY));
    expect(flow?.requestedResources.toSorted())
      .toEqual([GOOGLE_SHEETS_RESOURCE.urlPattern, OFFICE_IMPORT_GRANT].toSorted());
  });
});
