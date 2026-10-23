import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, GOOGLE_SLIDES_MIME_TYPE } from "../src/drive-session";
import { isDriveFileId } from "../src/drive-api";
import { GoogleApiError } from "../src/google-response";
import {
  explainUnopenedFile, nativeCopyName, nonNativeFileError, OFFICE_KINDS,
  officeFileError, officeLabel, OfficeConversion, type OfficeKind,
} from "../src/office-conversion";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** What Google says when it will not touch an Office file; code must never repeat it. */
const GOOGLE_TEXT = "This operation is not supported for this document. The document must not be an Office file.";

const KINDS: [OfficeKind, string, string, string][] = [
  ["sheets", XLSX, GOOGLE_SHEET_MIME_TYPE, "Sheets"],
  ["doc", DOCX, GOOGLE_DOC_MIME_TYPE, "Docs"],
  ["slides", PPTX, GOOGLE_SLIDES_MIME_TYPE, "Slides"],
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("officeFileError", () => {
  it.each(KINDS)("names %s, says it is an Office file, and points to the connect dialog", (
    kind, _office, _native, title,
  ) => {
    let { message } = officeFileError(kind);
    expect(message).toContain(`rather than a Google ${title} file`);
    expect(message).toMatch(/is an Office file, such as \.(xlsx|docx|pptx)/);
    expect(message).toContain(`connect dialog, which offers to make a Google ${title} copy`);
    expect(message).not.toContain(GOOGLE_TEXT);
  });

  it("says Docs cannot edit the file, and Sheets and Slides cannot open it", () => {
    expect(officeFileError("doc").message).toContain("Google's API cannot edit it");
    expect(officeFileError("sheets").message).toContain("Google's API cannot open it");
    expect(officeFileError("slides").message).toContain("Google's API cannot open it");
  });
});

const refused = () => new GoogleApiError("Google API request failed [http=400]", "FAILED_PRECONDITION");

describe("explainUnopenedFile", () => {

  it.each(KINDS)("explains a %s refusal of a file Drive says is an Office file", async (kind, office) => {
    let explained = await explainUnopenedFile(kind, refused(), async () => office);
    expect(explained).toEqual(officeFileError(kind));
  });

  it.each(KINDS)("does not offer conversion for a %s refusal of a file of another type", async (
    kind, _office, _native, title,
  ) => {
    let explained = await explainUnopenedFile(kind, refused(), async () => "text/csv");
    expect(explained).toEqual(nonNativeFileError(kind));
    expect((explained as Error).message).toContain(`choose File > Save as Google ${title}`);
    expect((explained as Error).message).not.toContain("connect dialog");
  });

  it("says Docs cannot edit a file of another type, and Sheets and Slides cannot open it", () => {
    expect(nonNativeFileError("doc").message).toMatch(/^Google Docs cannot edit this file/);
    expect(nonNativeFileError("sheets").message).toMatch(/^Google Sheets cannot open this file/);
    expect(nonNativeFileError("slides").message).toMatch(/^Google Slides cannot open this file/);
  });

  it.each(KINDS)("keeps the original %s error for a native file", async (kind, _office, native) => {
    let error = refused();
    await expect(explainUnopenedFile(kind, error, async () => native)).resolves.toBe(error);
  });

  it("keeps the original error, and asks Drive nothing, for any other status", async () => {
    let denied = new GoogleApiError("Google Slides get failed [http=403]", "PERMISSION_DENIED");
    let mimeType = vi.fn(async () => PPTX);
    await expect(explainUnopenedFile("slides", denied, mimeType)).resolves.toBe(denied);
    let plain = new Error("network down");
    await expect(explainUnopenedFile("slides", plain, mimeType)).resolves.toBe(plain);
    expect(mimeType).not.toHaveBeenCalled();
  });

  it("keeps the original error when Drive cannot say what the file is", async () => {
    let error = refused();
    await expect(explainUnopenedFile("doc", error, async () => {
      throw new Error("Google Drive API request failed: 403");
    })).resolves.toBe(error);
    await expect(explainUnopenedFile("doc", error, async () => undefined)).resolves.toBe(error);
  });
});

describe("Office allowlists", () => {
  it("labels each kind's Office types and nothing of another kind", () => {
    expect(officeLabel("sheets", XLSX)).toBe("xlsx");
    expect(officeLabel("doc", DOCX)).toBe("docx");
    expect(officeLabel("slides", PPTX)).toBe("pptx");
    expect(officeLabel("sheets", DOCX)).toBeUndefined();
    expect(officeLabel("doc", PPTX)).toBeUndefined();
    expect(officeLabel("slides", XLSX)).toBeUndefined();
  });

  it("compares MIME types case-insensitively, as Drive and its import list disagree on case", () => {
    expect(officeLabel("sheets", "application/vnd.ms-excel.sheet.macroEnabled.12")).toBe("xlsm");
    expect(officeLabel("sheets", "application/vnd.ms-excel.sheet.macroenabled.12")).toBe("xlsm");
    expect(officeLabel("doc", "APPLICATION/MSWORD")).toBe("doc");
  });

  it("accepts the x-vnd.oasis aliases of the OpenDocument types", () => {
    expect(officeLabel("sheets", "application/x-vnd.oasis.opendocument.spreadsheet")).toBe("ods");
    expect(officeLabel("doc", "application/x-vnd.oasis.opendocument.text")).toBe("odt");
    expect(officeLabel("slides", "application/x-vnd.oasis.opendocument.presentation")).toBe("odp");
    expect(officeLabel("doc", "text/rtf")).toBe("rtf");
  });

  it("refuses CSV, plain text, native files and anything unnamed", () => {
    expect(officeLabel("sheets", "text/csv")).toBeUndefined();
    expect(officeLabel("sheets", "text/tab-separated-values")).toBeUndefined();
    expect(officeLabel("doc", "text/plain")).toBeUndefined();
    expect(officeLabel("slides", "application/vnd.openxmlformats-officedocument.presentationml.slideshow"))
      .toBeUndefined();
    for (let [kind, , native] of KINDS) expect(officeLabel(kind, native)).toBeUndefined();
    expect(officeLabel("sheets", undefined)).toBeUndefined();
  });

  it("names a copy after its source without the Office extension, whatever its case", () => {
    expect(nativeCopyName("sheets", "Budget.XLSX")).toBe("Budget");
    expect(nativeCopyName("sheets", "Budget.ods")).toBe("Budget");
    expect(nativeCopyName("doc", "Notes.final.docx")).toBe("Notes.final");
    expect(nativeCopyName("doc", "Notes.pdf")).toBe("Notes.pdf");
    expect(nativeCopyName("slides", "Deck.docx")).toBe("Deck.docx");
    // A name that is only the extension keeps it, so the copy is never nameless.
    expect(nativeCopyName("slides", ".pptx")).toBe(".pptx");
  });

  it("keeps every allowlisted type distinct from its kind's native type", () => {
    for (let { nativeMimeType, officeMimeTypes } of Object.values(OFFICE_KINDS)) {
      expect(Object.keys(officeMimeTypes)).not.toContain(nativeMimeType);
    }
  });
});

type FakeFile = {
  id: string;
  name: string;
  mimeType: string;
  trashed?: boolean;
  parents?: string[];
  modifiedTime?: string;
  size?: string;
  canCopy?: boolean;
  createdTime?: string;
  /** Whether the account may edit it; a copy another user made reads as not. Defaults to true. */
  canEdit?: boolean;
  appProperties?: Record<string, string>;
};

/** A Drive that answers the requests a conversion makes, recording each. */
class FakeDrive {
  files = new Map<string, FakeFile>();
  /** Folders the account may add to; any other folder reads as unwritable. */
  writableFolders = new Set<string>();
  maxImportSizes: Record<string, string> = {
    [GOOGLE_DOC_MIME_TYPE]: "10485760",
    [GOOGLE_SHEET_MIME_TYPE]: "104857600",
    [GOOGLE_SLIDES_MIME_TYPE]: "104857600",
  };
  copyFailure: { status: number; reason: string } | undefined;
  readonly requests: { method: string; url: URL; body?: unknown }[] = [];
  #nextCopy = 1;

  constructor(...files: FakeFile[]) {
    for (let file of files) this.files.set(file.id, file);
  }

  get copies() {
    return this.requests.filter(request => request.method === "POST");
  }

  install(): void {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      let url = new URL(String(input));
      let method = init?.method ?? "GET";
      let body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      this.requests.push({ method, url, ...(body === undefined ? {} : { body }) });
      return this.#answer(method, url, body);
    }));
  }

  #answer(method: string, url: URL, body: any): Response {
    if (url.hostname !== "www.googleapis.com") throw new Error(`Unexpected request: ${url}`);
    let path = url.pathname.replace("/drive/v3", "");
    if (path === "/about") return Response.json({ maxImportSizes: this.maxImportSizes });
    if (path === "/files") {
      let sourceId = /value='([^']+)'/.exec(url.searchParams.get("q") ?? "")?.[1];
      return Response.json({
        files: [...this.files.values()].filter(file =>
          file.appProperties?.gadgetsConvertedFrom === sourceId && !file.trashed).map(file => this.#copyFields(file)),
      });
    }
    let copy = /^\/files\/([^/]+)\/copy$/.exec(path);
    if (copy && method === "POST") {
      if (this.copyFailure) {
        let { status, reason } = this.copyFailure;
        return Response.json({ error: { code: status, message: GOOGLE_TEXT, errors: [{ reason, message: GOOGLE_TEXT }] } }, { status });
      }
      let made: FakeFile = {
        id: `copy-${this.#nextCopy++}`, name: body.name, mimeType: body.mimeType, trashed: false,
        parents: body.parents, createdTime: "2026-10-15T10:00:00.000Z",
        appProperties: body.appProperties,
      };
      this.files.set(made.id, made);
      return Response.json(this.#copyFields(made));
    }
    let id = /^\/files\/([^/]+)$/.exec(path)?.[1];
    let file = id === undefined ? undefined : this.files.get(id);
    let fields = url.searchParams.get("fields") ?? "";
    if (fields === "capabilities(canAddChildren)") {
      if (!this.writableFolders.has(id!) && !id!.startsWith("readonly")) {
        return Response.json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, { status: 404 });
      }
      return Response.json({ capabilities: { canAddChildren: this.writableFolders.has(id!) } });
    }
    if (!file) return Response.json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, { status: 404 });
    if (fields.includes("appProperties")) return Response.json(this.#copyFields(file));
    return Response.json({
      id: file.id, name: file.name, mimeType: file.mimeType, trashed: file.trashed ?? false,
      ...(file.parents ? { parents: file.parents } : {}),
      ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
      ...(file.size ? { size: file.size } : {}),
      capabilities: { canCopy: file.canCopy ?? true },
    });
  }

  #copyFields(file: FakeFile) {
    return {
      id: file.id, name: file.name, mimeType: file.mimeType, trashed: file.trashed ?? false,
      parents: file.parents, createdTime: file.createdTime, appProperties: file.appProperties,
      capabilities: { canEdit: file.canEdit ?? true },
    };
  }
}

const token = async () => "access-token";
const granted = async () => true;

function source(overrides: Partial<FakeFile> = {}): FakeFile {
  return {
    id: "src-1", name: "Budget.xlsx", mimeType: XLSX, parents: ["folder-1"],
    modifiedTime: "2026-10-01T00:00:00.000Z", size: "2048", ...overrides,
  };
}

describe("isDriveFileId", () => {
  it("accepts Drive's alphabet and refuses anything that could reach another path", () => {
    expect(isDriveFileId("1AbC-dEf_9xYz")).toBe(true);
    for (let id of ["", "a/b", "../x", "a b", "a%2Fb", "a?b", "x".repeat(257)]) {
      expect(isDriveFileId(id)).toBe(false);
    }
  });
});

describe("OfficeConversion.inspectFile", () => {
  it("says a native file is native", async () => {
    new FakeDrive(source({ mimeType: GOOGLE_SHEET_MIME_TYPE, name: "Budget" })).install();
    await expect(new OfficeConversion("sheets", token, granted).inspectFile("src-1"))
      .resolves.toEqual({ type: "native" });
  });

  it("describes an Office file with its label and whether it may be copied", async () => {
    new FakeDrive(source({ canCopy: false })).install();
    await expect(new OfficeConversion("sheets", token, granted).inspectFile("src-1"))
      .resolves.toEqual({ type: "office", title: "Budget.xlsx", label: "xlsx", canCopy: false });
  });

  it("calls a file of another kind, or no Office kind, unsupported", async () => {
    new FakeDrive(source({ mimeType: DOCX }), source({ id: "csv-1", mimeType: "text/csv" })).install();
    let conversion = new OfficeConversion("sheets", token, granted);
    await expect(conversion.inspectFile("src-1")).resolves.toEqual({ type: "unsupported" });
    await expect(conversion.inspectFile("csv-1")).resolves.toEqual({ type: "unsupported" });
  });

  it("offers the copy this deployment already made, and only a live one of the right type", async () => {
    let drive = new FakeDrive(
      source(),
      { id: "old-copy", name: "Budget", mimeType: GOOGLE_SHEET_MIME_TYPE, trashed: true,
        createdTime: "2026-10-02T00:00:00.000Z", appProperties: { gadgetsConvertedFrom: "src-1" } },
      { id: "doc-copy", name: "Budget", mimeType: GOOGLE_DOC_MIME_TYPE,
        createdTime: "2026-10-03T00:00:00.000Z", appProperties: { gadgetsConvertedFrom: "src-1" } },
      // Newer, and listed first, but made by another user of this deployment in a folder this
      // account can only read.
      { id: "theirs", name: "Budget", mimeType: GOOGLE_SHEET_MIME_TYPE, canEdit: false,
        createdTime: "2026-10-05T00:00:00.000Z", appProperties: { gadgetsConvertedFrom: "src-1" } },
      { id: "copy-a", name: "Budget", mimeType: GOOGLE_SHEET_MIME_TYPE,
        createdTime: "2026-10-04T00:00:00.000Z", appProperties: { gadgetsConvertedFrom: "src-1" } },
    );
    drive.install();
    let inspection = await new OfficeConversion("sheets", token, granted).inspectFile("src-1");
    expect(inspection).toEqual({
      type: "office", title: "Budget.xlsx", label: "xlsx", canCopy: true,
      existingCopy: { fileId: "copy-a", title: "Budget", convertedAt: new Date("2026-10-04T00:00:00.000Z") },
    });
    let lookup = drive.requests.find(request => request.url.pathname.endsWith("/files"))!;
    expect(lookup.url.searchParams.get("q")).toBe(
      `trashed = false and mimeType = '${GOOGLE_SHEET_MIME_TYPE}' and ` +
      "appProperties has { key='gadgetsConvertedFrom' and value='src-1' }");
    expect(lookup.url.searchParams.get("corpora")).toBe("allDrives");
  });

  it("offers no copy when the lookup fails", async () => {
    let drive = new FakeDrive(source());
    drive.install();
    let fetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) =>
      new URL(input).pathname.endsWith("/files")
        ? Response.json({ error: { code: 500 } }, { status: 500 })
        : fetch(input, init)));
    await expect(new OfficeConversion("sheets", token, granted).inspectFile("src-1"))
      .resolves.not.toHaveProperty("existingCopy");
  });

  it("refuses a malformed ID, as an answer rather than a failure, before asking Drive", async () => {
    let drive = new FakeDrive();
    drive.install();
    await expect(new OfficeConversion("doc", token, granted).inspectFile("../src-1"))
      .resolves.toEqual({ type: "refused", message: "Not a Google Drive file ID." });
    expect(drive.requests).toEqual([]);
  });

  it("refuses a trashed Office file as an answer, offering neither it nor a copy", async () => {
    new FakeDrive(
      source({ trashed: true }),
      { id: "copy-a", name: "Budget", mimeType: GOOGLE_SHEET_MIME_TYPE,
        createdTime: "2026-10-04T00:00:00.000Z", appProperties: { gadgetsConvertedFrom: "src-1" } },
    ).install();
    await expect(new OfficeConversion("sheets", token, granted).inspectFile("src-1")).resolves.toEqual({
      type: "refused", message: "This file is in the Drive trash. Restore it before converting it.",
    });
  });

  it("fails, rather than answering, when Drive cannot say what the file is", async () => {
    new FakeDrive().install();
    await expect(new OfficeConversion("sheets", token, granted).inspectFile("missing"))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe("OfficeConversion.convertFile", () => {
  it.each(KINDS)("copies a %s Office file into its native type beside the original", async (
    kind, office, native,
  ) => {
    let info = vi.spyOn(console, "info").mockImplementation(() => {});
    let drive = new FakeDrive(source({ name: `Report.${officeLabel(kind, office)}`, mimeType: office }));
    drive.writableFolders.add("folder-1");
    drive.install();

    let result = await new OfficeConversion(kind, token, granted).convertFile("src-1");

    expect(result).toEqual({
      type: "converted", fileId: "copy-1", title: "Report", location: "besideOriginal", reused: false,
    });
    expect(drive.copies).toHaveLength(1);
    expect(drive.copies[0].url.pathname).toBe("/drive/v3/files/src-1/copy");
    expect(drive.copies[0].body).toEqual({
      name: "Report", mimeType: native, parents: ["folder-1"],
      appProperties: { gadgetsConvertedFrom: "src-1", gadgetsSourceModified: "2026-10-01T00:00:00.000Z" },
    });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.office.converted", conversionKind: kind, fileId: "src-1", copyFileId: "copy-1",
    }));
    expect(JSON.stringify(info.mock.calls)).not.toContain("Report");
  });

  it("asks for access, without calling Drive, when the account lacks the grant", async () => {
    let drive = new FakeDrive(source());
    drive.install();
    let hasAccess = vi.fn(async () => false);
    let conversion = new OfficeConversion("sheets", token, hasAccess);

    await expect(conversion.convertFile("src-1")).resolves.toEqual({ type: "needsAccess" });
    await expect(conversion.hasConversionAccess()).resolves.toBe(false);
    expect(drive.requests).toEqual([]);
    expect(hasAccess).toHaveBeenCalledTimes(2);
  });

  it("copies into My Drive's root, and says so, when the original's folder cannot take it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let drive = new FakeDrive(source({ parents: ["readonly-folder"] }));
    drive.install();

    let result = await new OfficeConversion("sheets", token, granted).convertFile("src-1");

    expect(result).toMatchObject({ type: "converted", location: "myDrive" });
    expect(drive.copies[0].body).toMatchObject({ parents: ["root"] });
  });

  it("asks the grant afresh on every call", async () => {
    let drive = new FakeDrive(source());
    drive.writableFolders.add("folder-1");
    drive.install();
    vi.spyOn(console, "info").mockImplementation(() => {});
    let held = false;
    let conversion = new OfficeConversion("sheets", token, async () => held);

    await expect(conversion.convertFile("src-1")).resolves.toEqual({ type: "needsAccess" });
    held = true;
    await expect(conversion.convertFile("src-1")).resolves.toMatchObject({ type: "converted" });
  });

  it("goes back to waiting for access when Drive says the token lacks the scope", async () => {
    let drive = new FakeDrive(source());
    drive.copyFailure = { status: 403, reason: "insufficientPermissions" };
    drive.install();
    await expect(new OfficeConversion("sheets", token, granted).convertFile("src-1"))
      .resolves.toEqual({ type: "needsAccess" });
  });

  it.each([
    ["a type this kind does not convert", source({ mimeType: "text/csv" }), /not an Office file Google Sheets can convert/],
    ["a native file", source({ mimeType: GOOGLE_SHEET_MIME_TYPE }), /not an Office file Google Sheets can convert/],
    ["a file whose owner turned off copying", source({ canCopy: false }), /turned off copying/],
    ["a trashed file", source({ trashed: true }), /in the Drive trash/],
  ])("refuses %s without sending a copy request", async (_case, file, message) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let drive = new FakeDrive(file);
    drive.install();
    await expect(new OfficeConversion("sheets", token, granted).convertFile("src-1"))
      .rejects.toThrow(message);
    expect(drive.copies).toEqual([]);
  });

  it("refuses a malformed source or copy ID before asking Drive anything", async () => {
    let drive = new FakeDrive(source());
    drive.install();
    let conversion = new OfficeConversion("sheets", token, granted);
    await expect(conversion.convertFile("src 1")).rejects.toThrow("Not a Google Drive file ID.");
    await expect(conversion.convertFile("src-1", { reuse: "a/b" })).rejects.toThrow("Not a Google Drive file ID.");
    expect(drive.requests).toEqual([]);
  });

  it("returns an earlier copy only once it proves to be one of this source", async () => {
    let info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let drive = new FakeDrive(
      source(),
      { id: "copy-a", name: "Budget", mimeType: GOOGLE_SHEET_MIME_TYPE, parents: ["folder-1"],
        trashed: false, appProperties: { gadgetsConvertedFrom: "src-1" } },
      { id: "other", name: "Other", mimeType: GOOGLE_SHEET_MIME_TYPE, trashed: false,
        appProperties: { gadgetsConvertedFrom: "src-2" } },
      { id: "wrong-type", name: "Budget", mimeType: GOOGLE_DOC_MIME_TYPE, trashed: false,
        appProperties: { gadgetsConvertedFrom: "src-1" } },
      { id: "binned", name: "Budget", mimeType: GOOGLE_SHEET_MIME_TYPE, trashed: true,
        appProperties: { gadgetsConvertedFrom: "src-1" } },
      { id: "theirs", name: "Budget", mimeType: GOOGLE_SHEET_MIME_TYPE, trashed: false,
        canEdit: false, appProperties: { gadgetsConvertedFrom: "src-1" } },
    );
    drive.install();
    let conversion = new OfficeConversion("sheets", token, granted);

    await expect(conversion.convertFile("src-1", { reuse: "copy-a" })).resolves.toEqual({
      type: "converted", fileId: "copy-a", title: "Budget", location: "besideOriginal", reused: true,
    });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.office.reused", fileId: "src-1", copyFileId: "copy-a", conversionKind: "sheets",
    }));
    for (let reuse of ["other", "wrong-type", "binned", "theirs"]) {
      await expect(conversion.convertFile("src-1", { reuse })).rejects.toThrow("no longer available");
    }
    expect(drive.copies).toEqual([]);
  });

  // Reusing reads metadata only, which the connection's own Drive scope already covers.
  it("reuses an earlier copy without the grant, never asking for access", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let drive = new FakeDrive(
      source(),
      { id: "copy-a", name: "Budget", mimeType: GOOGLE_SHEET_MIME_TYPE, parents: ["root-0AJ"],
        trashed: false, appProperties: { gadgetsConvertedFrom: "src-1" } },
    );
    drive.install();
    let hasAccess = vi.fn(async () => false);

    await expect(new OfficeConversion("sheets", token, hasAccess).convertFile("src-1", { reuse: "copy-a" }))
      .resolves.toEqual({
        type: "converted", fileId: "copy-a", title: "Budget", location: "myDrive", reused: true,
      });
    expect(hasAccess).not.toHaveBeenCalled();
    expect(drive.copies).toEqual([]);
  });

  it("reports a reuse Drive refuses for scope as a failure, not as a wait for access", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fetch = vi.fn(async () =>
      Response.json({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, { status: 403 }));
    vi.stubGlobal("fetch", fetch);

    await expect(new OfficeConversion("sheets", token, async () => false)
      .convertFile("src-1", { reuse: "copy-a" })).rejects.toThrow(Error);
    expect(fetch).toHaveBeenCalled();
  });

  it("reports a refused copy in its own words and logs it without Google's text", async () => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let drive = new FakeDrive(source());
    drive.copyFailure = { status: 403, reason: "storageQuotaExceeded" };
    drive.install();

    let error = await new OfficeConversion("sheets", token, granted).convertFile("src-1").catch(value => value);

    expect(error.message).toBe("The connected Google account has no Drive storage left for the copy.");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.office.failed", conversionKind: "sheets", fileId: "src-1", method: "copy",
      httpStatus: 403, providerReasons: ["storageQuotaExceeded"],
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(GOOGLE_TEXT);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Budget");
  });
});
