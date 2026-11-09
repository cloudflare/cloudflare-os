import { describe, expect, it, vi } from "vitest";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  DriveFolderSessionCore, DriveSessionCore, driveFileToEntry, requireDriveBindingScope,
  type CommentPageReader,
} from "../src/drive-session";
import { readFolderRoot, type FolderLocation } from "../src/drive-folder-scope";
import {
  DriveApiRequestError, FOLDER_MIME_TYPE,
  type DriveCommentList, type DriveCommentRecord, type DriveFile, type DriveListFilesOptions,
  type DriveScopeNode,
} from "../src/drive-api";
import type {
  DriveBindingAccess, DriveComment, DriveListOptions, DriveSearchQuery,
} from "../src/drive-types";

const docMime = "application/vnd.google-apps.document";
const sheetMime = "application/vnd.google-apps.spreadsheet";
const pdfMime = "application/pdf";

/** A converted read reports exactly `subresources` and leaves observer exclusion to them. */
function expectReported(description: ObservationDescription | undefined, subresources: string[]) {
  expect(description?.subresources).toEqual(subresources);
  expect(description).not.toHaveProperty("excludeObservers");
}

const file = (overrides: Partial<DriveFile> = {}): DriveFile => ({
  id: "file-1",
  name: "Quarterly plan",
  mimeType: "application/pdf",
  modifiedTime: "2026-01-02T03:04:05Z",
  ...overrides,
});

function core(overrides: {
  scope?: { kind: "account" } | { kind: "file"; fileId: string };
  access?: DriveBindingAccess;
  files?: DriveFile[];
  getFile?: (id: string) => Promise<DriveFile>;
  listFiles?: (options: DriveListFilesOptions) => Promise<{
    files: DriveFile[];
    nextPageToken?: string;
  }>;
  getScopeNodes?: (ids: readonly string[]) => Promise<(DriveScopeNode | undefined)[]>;
  canComment?: (id: string) => Promise<boolean>;
  listComments?: (id: string, options?: { pageToken?: string }) => Promise<DriveCommentList>;
  authorize?: (description: ObservationDescription) => Promise<void>;
} = {}) {
  let listFiles = vi.fn(overrides.listFiles ?? (async () => ({ files: overrides.files ?? [file()] })));
  let getFile = vi.fn(overrides.getFile ?? (async (id: string) => file({ id })));
  let getScopeNodes = vi.fn(overrides.getScopeNodes ??
    (async (ids: readonly string[]) => ids.map(() => undefined)));
  let canComment = vi.fn(overrides.canComment ?? (async () => true));
  let listComments = vi.fn(overrides.listComments ?? (async () => ({ comments: [] })));
  let authorizations: ObservationDescription[] = [];
  let events: string[] = [];
  let session = new DriveSessionCore({
    api: { listFiles, getFile, getScopeNodes, canComment, listComments },
    scope: overrides.scope ?? { kind: "account" },
    access: overrides.access ?? "read",
    authorize: async (description: ObservationDescription) => {
      authorizations.push(description);
      events.push("authorize");
      await overrides.authorize?.(description);
    },
  });
  return {
    session, listFiles, getFile, getScopeNodes, canComment, listComments, authorizations, events,
  };
}

const folder = (id: string, overrides: Partial<DriveFile> = {}): DriveFile =>
  file({ id, name: id, mimeType: FOLDER_MIME_TYPE, trashed: false,
    capabilities: { canListChildren: true }, ...overrides });

const child = (id: string, parent: string, overrides: Partial<DriveFile> = {}): DriveFile =>
  file({ id, name: id, parents: [parent], trashed: false, ...overrides });

/**
 * A provider serving one Drive tree. `parents` is the only edge, exactly as Drive models it, and
 * the scope-node view is the narrow projection the real batch returns.
 */
function tree(nodes: DriveFile[]) {
  let byId = new Map(nodes.map(node => [node.id, node]));
  return {
    byId,
    getFile: async (id: string) => {
      let found = byId.get(id);
      if (!found) throw new DriveApiRequestError(404);
      return found;
    },
    getScopeNodes: async (ids: readonly string[]) => ids.map((id): DriveScopeNode | undefined => {
      let found = byId.get(id);
      if (!found) return undefined;
      return {
        id: found.id,
        ...(found.mimeType ? { mimeType: found.mimeType } : {}),
        ...(found.parents ? { parents: found.parents } : {}),
        ...(found.driveId ? { driveId: found.driveId } : {}),
        ...(found.trashed === undefined ? {} : { trashed: found.trashed }),
        ...(found.capabilities?.canListChildren === undefined ? {} : {
          canListChildren: found.capabilities.canListChildren,
        }),
      };
    }),
  };
}

/** A comment someone else wrote, as Drive lists it. */
const record = (id: string): DriveCommentRecord => ({
  id, content: `Comment ${id}`, author: { displayName: "Ada", me: false },
  createdTime: "2026-10-20T10:00:00.000Z", resolved: false, deleted: false, replies: [],
});
/** That comment as a listing shows it. */
const shown = (comment: DriveCommentRecord): DriveComment => ({
  id: comment.id, author: { displayName: comment.author.displayName, me: comment.author.me },
  text: comment.content, createdTime: new Date(comment.createdTime), resolved: comment.resolved,
  replies: [],
});
/** Pages comments through as Drive lists them, with nothing queued to show. */
const plainPages: CommentPageReader = async fetch => {
  let { comments, nextPageToken } = await fetch();
  return { comments: comments.map(shown), ...(nextPageToken ? { nextPageToken } : {}) };
};
/** The same pages, each said to show a queued comment that quotes the file as a Google Doc. */
const quotingPages: CommentPageReader = async fetch =>
  ({ ...(await plainPages(fetch)), quotesDocument: true });


describe("Drive metadata mapping", () => {
  it("maps the complete declared metadata shape without provider-only fields", () => {
    expect(driveFileToEntry(file({
      size: "123",
      parents: ["folder-1"],
      owners: [{ displayName: "Ada", emailAddress: "ada@example.com" }],
      webViewLink: "https://drive.google.com/open?id=file-1",
    }))).toEqual({
      id: "file-1",
      name: "Quarterly plan",
      mimeType: "application/pdf",
      isFolder: false,
      modifiedTime: new Date("2026-01-02T03:04:05Z"),
      size: 123,
      owner: { displayName: "Ada", emailAddress: "ada@example.com" },
      parentId: "folder-1",
      webViewLink: "https://drive.google.com/open?id=file-1",
    });
  });

  it("omits owner metadata for shared-drive entries", () => {
    let entry = driveFileToEntry(file({
      driveId: "drive-1",
      owners: [{ displayName: "Unexpected owner", emailAddress: "owner@example.com" }],
    }));
    expect(entry.driveId).toBe("drive-1");
    expect(entry).not.toHaveProperty("owner");
  });

  it.each([
    ["folder", "application/vnd.google-apps.folder", undefined],
    ["shortcut", "application/vnd.google-apps.shortcut", { targetId: "target-1" }],
  ] as const)("omits size for a %s", (_kind, mimeType, shortcutDetails) => {
    let entry = driveFileToEntry(file({ mimeType, size: "123", shortcutDetails }));
    expect(entry).not.toHaveProperty("size");
    expect(entry.shortcut).toEqual(shortcutDetails);
  });
});

// Persisted props outlive a code deploy, so an unrecognized kind must refuse rather than fall
// through every narrow check and be served as the whole account.
describe("requireDriveBindingScope", () => {
  it("refuses a binding scope from an older model", () => {
    expect(() => requireDriveBindingScope({ kind: "sharedDrive", driveId: "drive-1" } as never))
      .toThrow(/predates the current folder resource/);
  });

  it("passes each supported scope through", () => {
    for (const scope of [
      { kind: "account" }, { kind: "folder", folderId: "f" }, { kind: "file", fileId: "x" },
    ] as const) {
      expect(requireDriveBindingScope(scope)).toBe(scope);
    }
  });
});

describe("Drive session scope", () => {
  it("lists the connected account and reports every returned file", async () => {
    let { session, listFiles, authorizations, events } = core({
      files: [file(), file({ id: "file-2" })],
    });
    let page = await (await session.list()).next();

    expect(page?.map(entry => entry.id)).toEqual(["file-1", "file-2"]);
    expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({ corpus: { kind: "user" } }));
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], ["drive/file/file-1", "drive/file/file-2"]);
    expect(events).toEqual(["authorize"]);
  });

  it("authorizes an empty account search and ends it normally", async () => {
    let { session, authorizations, events } = core({ files: [] });

    let cursor = await session.search({ namePrefix: "missing" });
    await expect(cursor.next()).resolves.toBeNull();

    expect(authorizations).toEqual([expect.objectContaining({
      title: "Read Google Drive metadata",
      description: expect.stringContaining('name starts with "missing"'),
    })]);
    expectReported(authorizations[0], []);
    expect(events).toEqual(["authorize"]);
  });

  it("propagates missing OAuth scopes without recording a file-access observation", async () => {
    let { session, authorizations } = core({
      getFile: async () => { throw new DriveApiRequestError(403, "insufficientPermissions"); },
    });

    await expect(session.getEntry("file-1")).rejects.toMatchObject({
      status: 403, reason: "insufficientPermissions",
    });
    expect(authorizations).toEqual([]);
  });

  // A file unit proves only metadata access, so it cannot stand for "this account can list the
  // folder": a metadata-only observer would pass it vacuously.
  it("reports a listable parent folder as a folder subresource", async () => {
    let { session, authorizations, events } = core({ getFile: async id => folder(id) });

    await session.list({ directParentId: "F" });
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], ["drive/folder/F"]);
    expect(events).toEqual(["authorize"]);
  });

  it("reports nothing for a live parent folder this account cannot list", async () => {
    let { session, authorizations, events } = core({
      getFile: async id => folder(id, { capabilities: { canListChildren: false } }),
    });

    await expect(session.list({ directParentId: "F" }))
      .rejects.toThrow("directParentId must identify a folder whose children can be listed");
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], []);
    expect(events).toEqual(["authorize"]);
  });

  it.each([
    ["a non-folder", (id: string) => file({ id })],
    ["a trashed folder", (id: string) => folder(id, { trashed: true })],
  ])("refuses %s parent as an objective disclosure", async (_label, getFile) => {
    let { session, authorizations, events } = core({ getFile: async id => getFile(id) });

    await expect(session.list({ directParentId: "F" }))
      .rejects.toThrow("directParentId must identify a folder whose children can be listed");
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], ["drive/file/F"]);
    expect(events).toEqual(["authorize"]);
  });

  // Dropping a blank parent as if it were absent turns a folder listing into an account-wide one,
  // which is the opposite of the narrowing the caller asked for.
  it.each([
    ["list", (session: DriveSessionCore) => session.list({ directParentId: "   " })],
    ["search", (session: DriveSessionCore) =>
      session.search({ namePrefix: "plan", directParentId: "   " })],
  ])("refuses a blank parent on %s", async (_label, read) => {
    let { session, listFiles, getFile, events } = core();

    await expect(read(session)).rejects.toThrow("directParentId must not be blank");
    expect(getFile).not.toHaveBeenCalled();
    expect(listFiles).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  // One class serves both session interfaces, so the RPC boundary validates the widest shape and
  // an account caller can still be handed `childFolderIds`. Ignoring it would search the whole
  // account while the caller believes the read was narrowed.
  it("refuses child folders on an account search", async () => {
    let { session, listFiles, events } = core();

    await expect(session.search({ namePrefix: "plan", childFolderIds: ["A"] } as DriveSearchQuery))
      .rejects.toThrow(/childFolderIds is not accepted/);
    expect(listFiles).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("ends a search cleanly after an earlier page disclosed results", async () => {
    let { session, listFiles } = core({
      listFiles: async options => options.pageToken === "page-2"
        ? { files: [] }
        : { files: [file()], nextPageToken: "page-2" },
    });

    let cursor = await session.search({ namePrefix: "Quarterly" });
    expect((await cursor.next())?.map(entry => entry.id)).toEqual(["file-1"]);
    await expect(cursor.next()).resolves.toBeNull();
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it("refuses another file ID without calling Google for a file-scoped binding", async () => {
    let { session, getFile } = core({ scope: { kind: "file", fileId: "file-1" } });
    await expect(session.getEntry("file-2")).rejects.toThrow(/outside this Drive binding/);
    expect(getFile).not.toHaveBeenCalled();
  });

  it("lists an exact-file binding without scanning the connected account", async () => {
    let { session, listFiles, getFile, authorizations } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async id => file({ id, trashed: false }),
    });

    await expect((await session.list()).next())
      .resolves.toEqual([expect.objectContaining({ id: "file-1" })]);
    expect(getFile).toHaveBeenCalledWith("file-1");
    expect(listFiles).not.toHaveBeenCalled();
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], ["drive/file/file-1"]);
  });

  it("omits a trashed file from an exact-file listing", async () => {
    let { session, authorizations } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async () => file({ trashed: true }),
    });

    await expect((await session.list()).next()).resolves.toBeNull();
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], ["drive/file/file-1"]);
  });

  it("omits an exact file whose trash state is absent", async () => {
    let { session, authorizations } = core({
      scope: { kind: "file", fileId: "file-1" },
    });

    await expect((await session.list()).next()).resolves.toBeNull();
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], ["drive/file/file-1"]);
  });

  it("still returns a trashed exact file from getEntry", async () => {
    let { session, authorizations } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async () => file({ trashed: true }),
    });

    await expect(session.getEntry("file-1")).resolves
      .toEqual(expect.objectContaining({ id: "file-1" }));
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], ["drive/file/file-1"]);
  });

  it("rejects an exact-file listing when the provider returns a different id", async () => {
    let { session, listFiles } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async () => file({ id: "file-other" }),
    });

    await expect((await session.list()).next()).rejects.toThrow(/outside this Drive binding/);
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("refuses a file scope read when the provider returns another file", async () => {
    let { session, getFile, authorizations } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async () => file({ id: "file-other", name: "Spoofed name" }),
    });

    await expect(session.getScope()).rejects.toThrow(/outside this Drive binding/);
    expect(getFile).toHaveBeenCalledWith("file-1");
    expect(authorizations).toEqual([]);
  });

  // The level is the binding's own configuration, so reporting it reads nothing more and adds no
  // subresource: an account binding's scope is answered without asking Google.
  it("reports the binding's access with its scope", async () => {
    let readOnly = core();
    await expect(readOnly.session.getScope()).resolves.toEqual({ kind: "account", access: "read" });
    expect(readOnly.getFile).not.toHaveBeenCalled();
    expect(readOnly.authorizations).toEqual([]);

    let readWrite = core({ scope: { kind: "file", fileId: "file-1" }, access: "write" });
    await expect(readWrite.session.getScope()).resolves.toEqual({
      kind: "file", fileId: "file-1", name: "Quarterly plan", access: "write",
    });
    expect(readWrite.authorizations).toHaveLength(1);
    expectReported(readWrite.authorizations[0], ["drive/file/file-1"]);
  });
});


describe("Drive native sessions", () => {
  it.each([
    ["account Doc", { kind: "account" } as const, docMime, "Google Doc"],
    ["account Sheet", { kind: "account" } as const, sheetMime, "Google Sheet"],
    ["exact-file Doc", { kind: "file", fileId: "file-1" } as const,
      docMime, "Google Doc"],
    ["exact-file Sheet", { kind: "file", fileId: "file-1" } as const,
      sheetMime, "Google Sheet"],
  ])("opens an in-scope native %s", async (_name, scope, mimeType, description) => {
    let { session, getFile } = core({
      scope,
      getFile: async id => file({ id, mimeType }),
    });

    await expect(session.openNativeFile("file-1", mimeType, description))
      .resolves.toBe("file-1");
    expect(getFile).toHaveBeenCalledWith("file-1");
  });

  it("rejects a mismatched provider file ID before authorizing", async () => {
    let { session, authorizations } = core({
      getFile: async () => file({ id: "file-2", mimeType: docMime }),
    });

    await expect(session.openNativeFile("file-1", docMime, "Google Doc"))
      .rejects.toThrow(/outside this Drive binding/);
    expect(authorizations).toEqual([]);
  });

  it.each([403, 404])("reports no requirement for an account-scope %s probe", async status => {
    let { session, authorizations, events } = core({
      getFile: async () => { throw new DriveApiRequestError(status); },
    });

    await expect(session.openNativeFile("file-1", docMime, "Google Doc"))
      .rejects.toThrow("The requested Drive file is unavailable to the connected account.");
    expect(events).toEqual(["authorize"]);
    expect(authorizations).toEqual([{
      title: "Check Google Drive file access",
      description: "Check whether the connected account can access Drive file file-1.",
      subresources: [],
    }]);
  });

  it("rejects another exact-file ID before calling Google", async () => {
    let { session, getFile } = core({ scope: { kind: "file", fileId: "file-1" } });

    await expect(session.openNativeFile("file-2", docMime, "Google Doc"))
      .rejects.toThrow(/outside this Drive binding/);
    expect(getFile).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong native type", sheetMime, undefined],
    ["folder", "application/vnd.google-apps.folder", undefined],
    ["blob", "application/pdf", undefined],
    ["shortcut", "application/vnd.google-apps.shortcut", { targetId: "target-1" }],
  ])("observes a %s before rejecting its MIME type", async (_name, mimeType, shortcutDetails) => {
    let { session, authorizations, events } = core({
      getFile: async id => file({ id, mimeType, shortcutDetails }),
    });

    await expect(session.openNativeFile("file-1", docMime, "Google Doc"))
      .rejects.toThrow(/not a Google Doc/);
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], ["drive/file/file-1"]);
    expect(events).toEqual(["authorize"]);
  });

  it("never follows a shortcut target implicitly", async () => {
    let getFile = vi.fn(async (id: string) => file({
      id,
      mimeType: "application/vnd.google-apps.shortcut",
      shortcutDetails: { targetId: "target-1", targetMimeType: docMime },
    }));
    let { session } = core({ getFile });

    await expect(session.openNativeFile("shortcut-1", docMime, "Google Doc"))
      .rejects.toThrow(/not a Google Doc/);
    expect(getFile).toHaveBeenCalledTimes(1);
    expect(getFile).toHaveBeenCalledWith("shortcut-1");
  });

  it("reports the opened file's Drive metadata", async () => {
    let { session, authorizations } = core({
      getFile: async id => file({ id, mimeType: docMime }),
    });

    await session.openNativeFile("file-1", docMime, "Google Doc");

    expect(authorizations).toEqual([expect.objectContaining({
      title: "Open Google Doc from Google Drive",
    })]);
    expectReported(authorizations[0], ["drive/file/file-1"]);
  });

  // openNativeFile() already reported the Drive metadata, so each read reports only what it
  // reads: a native file as its own API names it, or the content of a file Drive downloads, a
  // PDF's text or any other file's bytes, which a collaborator needs leave to download to see.
  it.each([
    ["account Doc", { kind: "account" } as const, docMime, {}, "docs/document/file-1"],
    ["account Sheet", { kind: "account" } as const, sheetMime, {}, "sheets/spreadsheet/file-1"],
    ["account PDF", { kind: "account" } as const, pdfMime, { content: true },
      "drive/content/file-1"],
    ["account CSV", { kind: "account" } as const, "text/csv", { content: true },
      "drive/content/file-1"],
    ["exact-file Doc", { kind: "file", fileId: "file-1" } as const,
      docMime, {}, "docs/document/file-1"],
    ["exact-file PDF", { kind: "file", fileId: "file-1" } as const,
      pdfMime, { content: true }, "drive/content/file-1"],
  ])("reports only what an %s read reads", async (_name, scope, mimeType, options, expected) => {
    let { session, authorizations } = core({ scope });

    await expect(session.nativeRead("file-1", mimeType, options)(
      async () => "content",
      value => ({ title: "Read file", description: `Read ${value}.` }),
    )).resolves.toBe("content");
    expect(authorizations).toEqual([{
      title: "Read file", description: "Read content.", subresources: [expected],
    }]);
  });

  // Only a content read downloads a file through Drive, so any other read of a file with no
  // native API is refused rather than reported as the file's metadata alone.
  it("refuses a read of a non-native file that is not a content read", () => {
    let { session } = core();

    expect(() => session.nativeRead("file-1", pdfMime))
      .toThrow("Google Drive has no native read of application/pdf files.");
  });

  it("withholds a native read's value when authorization is denied", async () => {
    let { session } = core({ authorize: async () => { throw new Error("denied"); } });

    await expect(session.nativeRead("file-1", docMime)(
      async () => "content",
      () => ({ title: "Read file", description: "Read content." }),
    )).rejects.toThrow("denied");
  });
});

describe("Drive search validation", () => {
  it("requires at least one populated search filter", async () => {
    let { session } = core();
    await expect(session.search({ namePrefix: "   " })).rejects.toThrow(/at least one filter/);
  });

  it("requires strict RFC 3339 timestamps and an increasing range", async () => {
    let { session } = core();
    await expect(session.search({ modifiedAfter: "yesterday" })).rejects.toThrow(/RFC 3339/);
    await expect(session.search({
      modifiedAfter: "2026-02-01T00:00:00Z",
      modifiedBefore: "2026-01-01T00:00:00Z",
    })).rejects.toThrow(/modifiedAfter.*modifiedBefore/);
  });

  it("uses Drive relevance order only for full-text search", async () => {
    let { session, listFiles } = core({ files: [file({ id: "local" })] });
    await (await session.search({ fullTextContains: "budget" })).next();
    expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: null,
      corpus: { kind: "user" },
    }));
  });

  it("rejects search on a file-scoped binding without listing", async () => {
    let { session, listFiles } = core({ scope: { kind: "file", fileId: "file-1" } });
    await expect(session.search({ namePrefix: "plan" })).rejects.toThrow(/getEntry/);
    expect(listFiles).not.toHaveBeenCalled();
  });
});

describe("Drive observation authorization", () => {
  it("discloses no page when authorization is denied", async () => {
    let { session } = core({
      authorize: async () => {
        throw new Error("denied");
      },
    });

    await expect((await session.list()).next()).rejects.toThrow(/denied/);
  });

  it("includes the binding scope and a truncated query in the description", async () => {
    let longText = "salary-review-".repeat(8);
    let { session, authorizations } = core({ files: [file({ id: "local" })] });

    await (await session.search({ namePrefix: "plan", fullTextContains: longText })).next();
    let observation = authorizations[0];
    expect(observation.title).toBe("Read Google Drive metadata");
    expect(observation.title).not.toContain(longText);
    expect(observation.title).not.toContain("plan");
    expect(observation.description).toContain("the connected Drive account");
    expect(observation.description).toContain('name starts with "plan"');
    expect(observation.description).toContain("salary-review-");
    expect(observation.description).not.toContain(longText);
    expect(observation.description.length).toBeLessThanOrEqual(240);
  });
});


describe("positioned Drive folder session", () => {
  const root = folder("R", { parents: ["above"] });
  const nested = folder("A", { parents: ["R"] });
  const directDoc = child("D0", "R", { mimeType: docMime });
  const nestedDoc = child("D1", "A", { mimeType: docMime });
  const foreignDoc = child("X", "U", { mimeType: docMime });

  function positioned(
      nodes: DriveFile[],
      location: FolderLocation = { folderIds: ["R"] },
      listFiles?: (query: DriveListFilesOptions) => Promise<{
        files: DriveFile[];
        nextPageToken?: string;
      }>,
      overrides: {
        canComment?: (id: string) => Promise<boolean>;
        listComments?: (id: string, options?: { pageToken?: string }) => Promise<DriveCommentList>;
        access?: DriveBindingAccess;
      } = {},
  ) {
    const provider = tree(nodes);
    const queries: DriveListFilesOptions[] = [];
    const authorizations: ObservationDescription[] = [];
    const events: string[] = [];
    const scopeBatches: string[][] = [];
    const session = new DriveFolderSessionCore({
      api: {
        getFile: provider.getFile,
        getScopeNodes: async ids => {
          scopeBatches.push([...ids]);
          return provider.getScopeNodes(ids);
        },
        listFiles: async options => {
          let query = options ?? {};
          queries.push(query);
          if (listFiles) return listFiles(query);
          return {
            files: nodes.filter(node =>
              node.trashed === false && node.parents?.length === 1 &&
              (query.directParentIds ?? []).includes(node.parents[0]) &&
              node.mimeType !== FOLDER_MIME_TYPE),
          };
        },
        canComment: overrides.canComment ?? (async () => true),
        listComments: overrides.listComments ?? (async () => ({ comments: [] })),
      },
      location,
      access: overrides.access ?? "read",
      authorize: async description => {
        authorizations.push(description);
        events.push("authorize");
      },
    });
    return { session, provider, queries, authorizations, events, scopeBatches };
  }

  it("lists and searches only the positioned folder's direct children", async () => {
    const { session, queries } = positioned([root, nested, directDoc, nestedDoc, foreignDoc]);

    await expect((await session.list()).next()).resolves.toEqual([
      expect.objectContaining({ id: "D0", parentId: "R" }),
    ]);
    await expect((await session.search({ fullTextContains: "invoice" })).next())
      .resolves.toEqual([expect.objectContaining({ id: "D0" })]);
    expect(queries).toEqual([
      expect.objectContaining({ directParentIds: ["R"] }),
      expect.objectContaining({ directParentIds: ["R"], fullTextContains: "invoice" }),
    ]);
  });

  // One class serves both Drive session interfaces, so the RPC boundary validates the account
  // shapes and a folder capability can still be handed `directParentId`.
  it("refuses a caller-supplied parent on a folder listing", async () => {
    const { session, queries, events } = positioned([root, directDoc]);
    const options: DriveListOptions = { directParentId: "decoy" };

    await expect(session.list(options)).rejects.toThrow(/directParentId is not accepted/);
    expect(queries).toEqual([]);
    expect(events).toEqual([]);
  });

  it("refuses a caller-supplied parent on a folder search", async () => {
    const { session, queries, events } = positioned([root, directDoc]);
    const query: DriveSearchQuery = { namePrefix: "plan", directParentId: "decoy" };

    await expect(session.search(query)).rejects.toThrow(/directParentId is not accepted/);
    expect(queries).toEqual([]);
    expect(events).toEqual([]);
  });

  // An unpaged cursor must not tell the caller whether the saved path is still visible and
  // connected: that read is a disclosure, and nothing has authorized one yet.
  it("reads nothing about the saved path until the first page", async () => {
    const { session, provider, queries, events } = positioned([root, directDoc]);
    provider.byId.delete("R");

    const pager = await session.list();
    expect(queries).toEqual([]);
    expect(events).toEqual([]);
    await expect(pager.next()).rejects.toThrow(/outside this Drive binding/);
  });

  // A bound shared-drive folder still navigates through its own drive corpus; the picker's
  // cross-corpus discovery must not leak in here.
  it("lists a shared-drive folder through that drive's corpus alone", async () => {
    const sharedRoot = folder("SR", { driveId: "drive-1", parents: undefined });
    const sharedDoc = child("SD", "SR", { mimeType: docMime, driveId: "drive-1" });
    const { session, queries } = positioned([sharedRoot, sharedDoc], { folderIds: ["SR"] });

    await expect((await session.list()).next()).resolves.toEqual([
      expect.objectContaining({ id: "SD", driveId: "drive-1" }),
    ]);
    expect(queries).toEqual([expect.objectContaining({
      directParentIds: ["SR"], corpus: { kind: "drive", driveId: "drive-1" },
    })]);
  });

  it("navigates one checked child at a time", async () => {
    const { session } = positioned([root, nested, directDoc, nestedDoc, foreignDoc]);

    await expect(session.getEntry("D1")).rejects.toThrow(/outside this Drive binding/);
    await expect(session.openNativeFile("D1", docMime, "Google Doc"))
      .rejects.toThrow(/outside this Drive binding/);
    const location = await session.openFolder("A");
    const childSession = positioned([root, nested, directDoc, nestedDoc, foreignDoc], location).session;
    await expect(childSession.openNativeFile("D1", docMime, "Google Doc")).resolves.toBe("D1");
    await expect(childSession.getEntry("X")).rejects.toThrow(/outside this Drive binding/);
  });

  it("reports the positioned folder alongside each child it reads", async () => {
    const { session, authorizations } = positioned([root, nested, directDoc]);

    await session.getEntry("D0");
    await session.openNativeFile("D0", docMime, "Google Doc");
    await session.openFolder("A");
    await session.getScope();
    expect(authorizations).toHaveLength(4);
    expectReported(authorizations[0], ["drive/folder/R", "drive/file/D0"]);
    expectReported(authorizations[1], ["drive/folder/R", "drive/file/D0"]);
    expectReported(authorizations[2], ["drive/folder/R", "drive/folder/A"]);
    expectReported(authorizations[3], ["drive/folder/R"]);
  });

  // A child folder is a core of the same binding, so it reports the level it was built with.
  it("reports the binding's access with a positioned folder's scope", async () => {
    const readOnly = positioned([root]);
    await expect(readOnly.session.getScope()).resolves.toEqual({
      kind: "folder", folderId: "R", rootFolderId: "R", name: "R", access: "read",
    });
    expect(readOnly.authorizations).toHaveLength(1);
    expectReported(readOnly.authorizations[0], ["drive/folder/R"]);

    const readWrite =
      positioned([root, nested], { folderIds: ["R", "A"] }, undefined, { access: "write" });
    await expect(readWrite.session.getScope()).resolves.toEqual({
      kind: "folder", folderId: "A", rootFolderId: "R", name: "A", access: "write",
    });
    expect(readWrite.authorizations).toHaveLength(1);
    expectReported(readWrite.authorizations[0], ["drive/folder/A"]);
  });

  // Each read revalidates the child in the folder, so it reports both as well as what it reads:
  // a native file as its own API names it, or the content of a file Drive downloads.
  it.each([
    ["Doc", directDoc, {}, ["drive/folder/R", "drive/file/D0", "docs/document/D0"]],
    ["PDF", child("P", "R", { mimeType: pdfMime }), { content: true },
      ["drive/folder/R", "drive/file/P", "drive/content/P"]],
  ])("reports the folder, the child and what it reads on a %s read",
    async (_name, target, options, expected) => {
      const { session, authorizations } = positioned([root, target]);

      await expect(session.nativeRead(target.id, target.mimeType!, options)(
        async () => "content",
        value => ({ title: "Read file", description: `Read ${value}.` }),
      )).resolves.toBe("content");
      expect(authorizations).toEqual([{
        title: "Read file", description: "Read content.", subresources: expected,
      }]);
    });

  it("reports an unopenable child, or nothing when the refusal is account-relative", async () => {
    const objective = positioned([root, directDoc]);
    await expect(objective.session.openFolder("D0")).rejects.toThrow(/outside this Drive binding/);
    expect(objective.authorizations).toHaveLength(1);
    expectReported(objective.authorizations[0], ["drive/folder/R", "drive/file/D0"]);
    expect(objective.events).toEqual(["authorize"]);

    const unlistable = folder("U", { parents: ["R"], capabilities: { canListChildren: false } });
    const accountRelative = positioned([root, unlistable]);
    await expect(accountRelative.session.openFolder("U"))
      .rejects.toThrow(/outside this Drive binding/);
    expect(accountRelative.authorizations).toHaveLength(1);
    expectReported(accountRelative.authorizations[0], []);
    expect(accountRelative.events).toEqual(["authorize"]);
  });

  it("invalidates a saved path when one edge changes", async () => {
    const nodes = [root, nested, nestedDoc];
    const { session, provider } = positioned(nodes);
    const location = await session.openFolder("A");
    const childSession = positioned(nodes, location);
    provider.byId.set("A", folder("A", { parents: ["elsewhere"] }));
    childSession.provider.byId.set("A", folder("A", { parents: ["elsewhere"] }));

    await expect(childSession.session.getScope()).rejects.toThrow(/outside this Drive binding/);
  });

  it("accepts a listable shared-drive root through the folder validator", async () => {
    const sharedRoot = folder("drive-1", { driveId: "drive-1", parents: undefined });
    await expect(readFolderRoot("drive-1", async () => sharedRoot)).resolves.toBe(sharedRoot);
  });

  it("rejects a trashed direct child", async () => {
    const trashed = child("T", "R", { mimeType: docMime, trashed: true });
    const { session } = positioned([root, trashed]);

    await expect(session.getEntry("T")).rejects.toThrow(/outside this Drive binding/);
    await expect(session.openNativeFile("T", docMime, "Google Doc"))
      .rejects.toThrow(/outside this Drive binding/);
  });

  // Converting first would let a metadata failure answer whether the id is a direct child without
  // the file ever being reported for a later observer to be checked against.
  it("reports a direct child before its metadata can fail to convert", async () => {
    const malformed = child("M", "R", { mimeType: undefined });
    const { session, authorizations, events } = positioned([root, malformed]);

    await expect(session.getEntry("M")).rejects
      .toThrow("Google Drive omitted required file mimeType");
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], ["drive/folder/R", "drive/file/M"]);
    expect(events).toEqual(["authorize"]);
  });

  it("reports nothing for an invisible probe and skips a visible non-child", async () => {
    const visible = positioned([root, nested, nestedDoc]);
    await expect(visible.session.getEntry("D1")).rejects.toThrow(/outside this Drive binding/);
    expect(visible.events).toEqual([]);

    const invisible = positioned([root]);
    await expect(invisible.session.getEntry("gone")).rejects.toThrow(/outside this Drive binding/);
    expect(invisible.events).toEqual(["authorize"]);
    expectReported(invisible.authorizations[0], []);
  });

  it("propagates a missing Drive scope instead of recording an invisible child", async () => {
    const authorizations: ObservationDescription[] = [];
    const session = new DriveFolderSessionCore({
      api: {
        getScopeNodes: tree([root]).getScopeNodes,
        getFile: async () => { throw new DriveApiRequestError(403, "insufficientPermissions"); },
        listFiles: async () => ({ files: [] }),
        canComment: async () => true,
        listComments: async () => ({ comments: [] }),
      },
      location: { folderIds: ["R"] },
      access: "read",
      authorize: async description => { authorizations.push(description); },
    });

    await expect(session.getEntry("D0")).rejects.toMatchObject({
      status: 403, reason: "insufficientPermissions",
    });
    expect(authorizations).toEqual([]);
  });

  it("authorizes an empty folder search against the positioned folder", async () => {
    const { session, authorizations, events } =
      positioned([root], undefined, async () => ({ files: [] }));

    await expect((await session.search({ namePrefix: "missing" })).next()).resolves.toBeNull();
    expect(authorizations).toEqual([expect.objectContaining({
      title: "Read Google Drive metadata",
      description: expect.stringContaining('name starts with "missing"'),
    })]);
    expectReported(authorizations[0], ["drive/folder/R"]);
    expect(events).toEqual(["authorize"]);
  });

  // Polling N sibling folders one at a time costs a request each. The proof is unchanged: every
  // named folder must still be a listable direct child, so this only removes repeated requests.
  it("searches several proven child folders in one request", async () => {
    const second = folder("B", { parents: ["R"] });
    const secondDoc = child("D2", "B", { mimeType: docMime });
    const { session, queries, authorizations, events } =
      positioned([root, nested, second, nestedDoc, secondDoc]);

    await expect((await session.search({
      namePrefix: "D", childFolderIds: ["A", "B"],
    })).next()).resolves.toEqual([
      expect.objectContaining({ id: "D1" }),
      expect.objectContaining({ id: "D2" }),
    ]);
    expect(queries).toEqual([
      expect.objectContaining({ directParentIds: ["A", "B"], namePrefix: "D" }),
    ]);
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], [
      "drive/folder/R", "drive/folder/A", "drive/folder/B", "drive/file/D1", "drive/file/D2",
    ]);
    expect(events).toEqual(["authorize"]);
  });

  it("names every searched folder in the recorded description", async () => {
    const second = folder("B", { parents: ["R"] });
    const { session, authorizations } =
      positioned([root, nested, second, nestedDoc], undefined, async () => ({ files: [] }));

    await expect((await session.search({ namePrefix: "D", childFolderIds: ["A", "B"] })).next())
      .resolves.toBeNull();
    expect(authorizations).toEqual([expect.objectContaining({
      description: expect.stringContaining("parents A, B"),
    })]);
    expectReported(authorizations[0], ["drive/folder/R", "drive/folder/A", "drive/folder/B"]);
  });

  it("refuses a page carrying a file from outside the named folders", async () => {
    const { session } = positioned([root, nested, nestedDoc, foreignDoc], undefined,
      async () => ({ files: [nestedDoc, foreignDoc] }));

    await expect((await session.search({ namePrefix: "D", childFolderIds: ["A"] })).next())
      .rejects.toThrow(/outside this Drive binding/);
  });

  // Same laziness the positioned path has: an unpaged cursor must not disclose whether the named
  // folders are visible and connected.
  it("reads nothing about the named folders until the first page", async () => {
    const { session, queries, events } = positioned([root, nested, nestedDoc]);

    const pager = await session.search({ namePrefix: "D", childFolderIds: ["D1"] });
    expect(queries).toEqual([]);
    expect(events).toEqual([]);
    await expect(pager.next()).rejects.toThrow(/outside this Drive binding/);
    expect(queries).toEqual([]);
  });

  it("reports nothing for a named child folder this account cannot list", async () => {
    const unlistable = folder("B", { parents: ["R"], capabilities: { canListChildren: false } });
    const { session, queries, authorizations, events } = positioned([root, unlistable]);

    await expect((await session.search({ namePrefix: "D", childFolderIds: ["B"] })).next())
      .rejects.toThrow(/outside this Drive binding/);
    expect(events).toEqual(["authorize"]);
    expectReported(authorizations[0], []);
    expect(queries).toEqual([]);
  });

  it.each([[[]], [["  "]]])("refuses a child folder set naming nothing: %j", async folders => {
    const { session } = positioned([root, nested]);

    await expect(session.search({ namePrefix: "D", childFolderIds: folders }))
      .rejects.toThrow(/must name at least one folder/);
  });

  // Synchronously, not from the first page: the cursor is already in the caller's hands by then.
  it("refuses more child folders than one query carries", async () => {
    const { session, queries } = positioned([root, nested]);

    await expect(session.search({
      namePrefix: "D",
      childFolderIds: Array.from({ length: 51 }, (_, index) => `f${index}`),
    })).rejects.toThrow(/at most 50 folders; search them in batches/);
    expect(queries).toEqual([]);
  });

  // A direct child that is not a folder is an objective refusal, reported as a file exactly as
  // openFolder does; leaving it unreported lets a later collaborator inherit the probe.
  it("reports a non-folder named child before refusing it", async () => {
    const { session, authorizations, events } = positioned([root, directDoc]);

    await expect((await session.search({ namePrefix: "D", childFolderIds: ["D0"] })).next())
      .rejects.toThrow(/outside this Drive binding/);
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], ["drive/folder/R", "drive/file/D0"]);
    expect(events).toEqual(["authorize"]);
  });

  // The authorizer revalidates immediately after `buildEntries` with no provider read between, so
  // one page proves the path and the named folders once each side of the fetch, not three times.
  it("proves a page's scope once before the fetch and once after", async () => {
    const second = folder("B", { parents: ["R"] });
    const { session, scopeBatches } =
      positioned([root, nested, second, nestedDoc], undefined, async () => ({ files: [] }));

    await expect((await session.search({ namePrefix: "D", childFolderIds: ["A", "B"] })).next())
      .resolves.toBeNull();
    expect(scopeBatches).toEqual([["R"], ["A", "B"], ["R"], ["A", "B"]]);
  });

  // A file's comments are reported as the file is, and a folder binding's reads of a child report
  // the folder it was found in as well.
  it("reports the folder with a direct child's comments", async () => {
    const { session, authorizations } = positioned([root, directDoc], undefined, undefined, {
      listComments: async () => ({ comments: [record("c1")] }),
    });

    await expect(session.commentTarget("D0")).resolves
      .toEqual({ fileId: "D0", mimeType: docMime, folderIds: ["R"] });
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]).toMatchObject({
      title: "Open Google Drive comments",
      description: "Check current metadata for Drive file D0 to work with its comments.",
    });
    expectReported(authorizations[0], ["drive/folder/R", "drive/file/D0"]);

    await expect(session.commentPager("D0", plainPages).next())
      .resolves.toEqual([shown(record("c1"))]);
    expect(authorizations).toHaveLength(2);
    expect(authorizations[1].title).toBe("Read Google Drive comments");
    expectReported(authorizations[1], ["drive/folder/R", "drive/file/D0"]);
  });

  // The path a target returns is what a write saves and proves again when it is applied, so from
  // a child folder it is the whole path from the bound root, while the folder reported is the one
  // the file sits in.
  it("returns the whole path, and reports the child folder, for a file below the root", async () => {
    const { session, authorizations } =
      positioned([root, nested, nestedDoc], { folderIds: ["R", "A"] }, undefined, {
        listComments: async () => ({ comments: [record("c1")] }),
      });

    const target = await session.commentTarget("D1");
    expect(target).toEqual({ fileId: "D1", mimeType: docMime, folderIds: ["R", "A"] });
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], ["drive/folder/A", "drive/file/D1"]);

    await expect(session.commentPager("D1", plainPages).next())
      .resolves.toEqual([shown(record("c1"))]);
    expect(authorizations).toHaveLength(2);
    expectReported(authorizations[1], ["drive/folder/A", "drive/file/D1"]);

    // The path is the caller's own copy: changing it moves nothing in the core.
    target.folderIds?.push("elsewhere");
    await expect(session.commentTarget("D1")).resolves
      .toEqual({ fileId: "D1", mimeType: docMime, folderIds: ["R", "A"] });
    expectReported(authorizations[2], ["drive/folder/A", "drive/file/D1"]);
  });

  it("refuses a nested file's comments without reporting anything", async () => {
    const visible = positioned([root, nested, nestedDoc]);
    await expect(visible.session.commentTarget("D1")).rejects.toThrow(/outside this Drive binding/);
    expect(visible.events).toEqual([]);

    const invisible = positioned([root]);
    await expect(invisible.session.commentTarget("gone"))
      .rejects.toThrow(/outside this Drive binding/);
    expect(invisible.events).toEqual(["authorize"]);
    expectReported(invisible.authorizations[0], []);
  });

  it("stops a folder's comment listing once the file moves out, authorizing nothing more", async () => {
    const listComments = vi.fn(async (_id: string, options?: { pageToken?: string }) =>
      options?.pageToken
        ? { comments: [record("c2")] }
        : { comments: [record("c1")], nextPageToken: "p2" });
    const { session, authorizations, provider } =
      positioned([root, directDoc], undefined, undefined, { listComments });

    await session.commentTarget("D0");
    const pager = session.commentPager("D0", plainPages);
    expect((await pager.next())?.map(comment => comment.id)).toEqual(["c1"]);
    const authorized = authorizations.length;

    provider.byId.set("D0", { ...directDoc, parents: ["elsewhere"] });
    await expect(pager.next()).rejects.toThrow(/outside this Drive binding/);
    expect(listComments).toHaveBeenCalledTimes(1);
    expect(authorizations.slice(authorized).map(entry => entry.title))
      .not.toContain("Read Google Drive comments");
  });

  it("discloses no page of a folder's comments read while the file moved out", async () => {
    // The listing itself moves the file, so the page is fetched in scope and built out of it.
    const state: { provider?: ReturnType<typeof tree> } = {};
    const listComments = vi.fn(async () => {
      state.provider?.byId.set("D0", { ...directDoc, parents: ["elsewhere"] });
      return { comments: [record("c1")] };
    });
    const positionedCore = positioned([root, directDoc], undefined, undefined, { listComments });
    state.provider = positionedCore.provider;

    const pager = positionedCore.session.commentPager("D0", plainPages);
    await expect(pager.next()).rejects.toThrow(/outside this Drive binding/);
    expect(listComments).toHaveBeenCalledTimes(1);
    expect(positionedCore.authorizations.map(entry => entry.title))
      .not.toContain("Read Google Drive comments");
  });

  // A page read while the file was out of scope is never disclosed, so the document it quoted is
  // not reported with the page the retry reads, which shows no such comment.
  it("reports only what the retry shows after a page of a folder's comments was withheld", async () => {
    const state: { provider?: ReturnType<typeof tree>; reads: number } = { reads: 0 };
    const listComments = vi.fn(async () => {
      // The first listing moves the file out, so its page is fetched in scope and built out of it.
      if (++state.reads === 1) {
        state.provider?.byId.set("D0", { ...directDoc, parents: ["elsewhere"] });
      }
      return { comments: [record("c1")] };
    });
    const quotingFirstRead: CommentPageReader = async fetch => {
      const page = await plainPages(fetch);
      return state.reads === 1 ? { ...page, quotesDocument: true } : page;
    };
    const positionedCore = positioned([root, directDoc], undefined, undefined, { listComments });
    state.provider = positionedCore.provider;

    const pager = positionedCore.session.commentPager("D0", quotingFirstRead);
    await expect(pager.next()).rejects.toThrow(/outside this Drive binding/);
    expect(positionedCore.authorizations).toEqual([]);

    positionedCore.provider.byId.set("D0", directDoc);
    await expect(pager.next()).resolves.toEqual([shown(record("c1"))]);
    expect(listComments).toHaveBeenCalledTimes(2);
    expect(positionedCore.authorizations).toHaveLength(1);
    expect(positionedCore.authorizations[0].title).toBe("Read Google Drive comments");
    expectReported(positionedCore.authorizations[0], ["drive/folder/R", "drive/file/D0"]);
  });
});

describe("Drive comment listing", () => {
  const REFUSED = "The connected account can only view Drive file file-1. Google shows a file's " +
    "comments only to accounts that can comment on it, so this file's comments cannot be read " +
    "or added to here.";

  // Whoever can open a file may see its comments, so the scope check and every page report the
  // file and no unit of the comments' own.
  it("reports the file, and nothing about comments, before disclosing any comment", async () => {
    let { session, authorizations, listComments } = core({
      listComments: async () => ({ comments: [record("c1")] }),
    });

    await expect(session.commentTarget("file-1")).resolves
      .toEqual({ fileId: "file-1", mimeType: "application/pdf" });
    let pager = session.commentPager("file-1", plainPages);
    expect(listComments).not.toHaveBeenCalled();
    await expect(pager.next()).resolves.toEqual([shown(record("c1"))]);

    expect(authorizations.map(entry => entry.title))
      .toEqual(["Open Google Drive comments", "Read Google Drive comments"]);
    expectReported(authorizations[0], ["drive/file/file-1"]);
    expect(authorizations[0].description)
      .toBe("Check current metadata for Drive file file-1 to work with its comments.");
    expectReported(authorizations[1], ["drive/file/file-1"]);
    expect(authorizations[1].description).toBe("Read 1 comment on Drive file file-1.");
  });

  // The file Drive answers with is the one the target names: an answer about another file proves
  // nothing about the one asked for.
  it("refuses a file Drive answers with another ID, reporting nothing", async () => {
    let { session, canComment, authorizations } =
      core({ getFile: async () => file({ id: "file-2" }) });

    await expect(session.commentTarget("file-1")).rejects.toThrow(/outside this Drive binding/);
    expect(canComment).not.toHaveBeenCalled();
    expect(authorizations).toEqual([]);
  });

  // That a file is invisible is an answer about the connected account, so an account binding
  // reports no requirement for it and passes on none of Drive's own reasons.
  it.each([
    ["a file the account may not open", new DriveApiRequestError(403, "insufficientFilePermissions")],
    ["a file that is not there", new DriveApiRequestError(404, "notFound")],
  ])("answers an account binding's comment call on %s as unavailable, reporting no requirement", async (_what, failure) => {
    let { session, canComment, listComments, authorizations } =
      core({ getFile: async () => { throw failure; } });

    await expect(session.commentTarget("file-1")).rejects.toThrow(
      new Error("The requested Drive file is unavailable to the connected account."));
    expect(canComment).not.toHaveBeenCalled();
    expect(listComments).not.toHaveBeenCalled();
    expect(authorizations).toEqual([{
      title: "Check Google Drive file access",
      description: "Check whether the connected account can access Drive file file-1.",
      subresources: [],
    }]);
  });

  // A token that lacks the scope says nothing of the file, so that is not an invisible file.
  it("passes on a missing Drive scope from a comment call's scope check, reporting nothing", async () => {
    let failure = new DriveApiRequestError(403, "insufficientPermissions");
    let { session, authorizations } = core({ getFile: async () => { throw failure; } });

    await expect(session.commentTarget("file-1")).rejects.toBe(failure);
    expect(authorizations).toEqual([]);
  });

  it.each([403, 404])("passes on Drive's error (%i) when a file binding's own file is gone, reporting nothing", async status => {
    let failure = new DriveApiRequestError(status);
    let { session, canComment, authorizations } = core({
      scope: { kind: "file", fileId: "file-1" }, getFile: async () => { throw failure; },
    });

    await expect(session.commentTarget("file-1")).rejects.toBe(failure);
    expect(canComment).not.toHaveBeenCalled();
    expect(authorizations).toEqual([]);
  });

  it("leaves the type out of a target Drive gives no type for", async () => {
    let { session, authorizations } =
      core({ getFile: async id => file({ id, mimeType: undefined }) });

    await expect(session.commentTarget("file-1")).resolves.toStrictEqual({ fileId: "file-1" });
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], ["drive/file/file-1"]);
  });

  it("reports an empty listing as it reports a page of comments", async () => {
    let { session, authorizations } = core();

    await expect(session.commentPager("file-1", plainPages).next()).resolves.toBeNull();
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]).toMatchObject({
      title: "Read Google Drive comments", description: "Read 0 comments on Drive file file-1.",
    });
    expectReported(authorizations[0], ["drive/file/file-1"]);
  });

  // The check is about the connected account alone: it prepares a listing or a write, and a
  // collaborator's own right to comment is never asked.
  it("lets a listing or a write through, observing nothing, when the account can comment", async () => {
    let { session, canComment, authorizations } = core();

    await expect(session.requireCommentable("file-1")).resolves.toBeUndefined();
    expect(canComment).toHaveBeenCalledWith("file-1");
    expect(authorizations).toEqual([]);
  });

  // Drive answers the listing of an account that can only view a file with no comments and no
  // error, which would read as a file without comments.
  it("refuses a file the account cannot comment on, saying why and reporting nothing", async () => {
    let { session, listComments, authorizations } = core({ canComment: async () => false });

    await expect(session.requireCommentable("file-1")).rejects.toThrow(new Error(REFUSED));
    expect(listComments).not.toHaveBeenCalled();
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]).toMatchObject({
      title: "Check Google Drive file access",
      description: "Check whether the connected account can comment on Drive file file-1.",
    });
    expectReported(authorizations[0], []);
  });

  // Only the answer "no" is a refusal. A read that fails gives no answer, so saying that the
  // account can only view the file would be untrue of a file it may be able to comment on.
  it.each([
    ["the file gone since its scope check", new DriveApiRequestError(404, "notFound")],
    ["a missing Drive scope", new DriveApiRequestError(403, "insufficientPermissions")],
    ["a rate limit", new DriveApiRequestError(403, "userRateLimitExceeded")],
    ["a server error", new DriveApiRequestError(500, "backendError")],
    ["a request that never answered", new TypeError("fetch failed")],
  ])("passes on a failure of the check itself, reporting nothing (%s)", async (_what, failure) => {
    let { session, authorizations } = core({ canComment: async () => { throw failure; } });

    await expect(session.requireCommentable("file-1")).rejects.toBe(failure);
    expect(authorizations).toEqual([]);
  });

  it("refuses another file of an exact-file binding without calling Google", async () => {
    let { session, getFile, canComment, authorizations } =
      core({ scope: { kind: "file", fileId: "file-1" } });

    await expect(session.commentTarget("file-2")).rejects.toThrow(/outside this Drive binding/);
    expect(getFile).not.toHaveBeenCalled();
    expect(canComment).not.toHaveBeenCalled();
    expect(authorizations).toEqual([]);
  });

  // A queued comment that quotes a Google Doc was checked against the document's text, so the
  // page that shows it depends on the document as the read that placed the quote did.
  it("reports the document on a page that shows a comment quoting it, and only on that page", async () => {
    let { session, authorizations } = core({
      listComments: async (_id, options) => {
        if (options?.pageToken === "p3") return { comments: [record("c3")] };
        if (options?.pageToken === "p2") return { comments: [record("c2")], nextPageToken: "p3" };
        return { comments: [record("c1")], nextPageToken: "p2" };
      },
    });
    let pages = 0;
    let quotingSecondPage: CommentPageReader = async fetch => {
      let page = await plainPages(fetch);
      return ++pages === 2 ? { ...page, quotesDocument: true } : page;
    };
    let pager = session.commentPager("file-1", quotingSecondPage);

    expect((await pager.next())?.map(comment => comment.id)).toEqual(["c1"]);
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], ["drive/file/file-1"]);

    expect((await pager.next())?.map(comment => comment.id)).toEqual(["c2"]);
    expect(authorizations).toHaveLength(2);
    expectReported(authorizations[1], ["drive/file/file-1", "docs/document/file-1"]);

    // The page after it shows no such comment, and reports the file alone again.
    expect((await pager.next())?.map(comment => comment.id)).toEqual(["c3"]);
    expect(authorizations).toHaveLength(3);
    expectReported(authorizations[2], ["drive/file/file-1"]);
  });

  // A refused page leaves the cursor where it was, so the retry reads the page again and must
  // report what it shows again.
  it("reports the document again when the page is read again after a refusal", async () => {
    let refusals = 1;
    let { session, listComments, authorizations } = core({
      listComments: async () => ({ comments: [record("c1")] }),
      authorize: async description => {
        if (description.title === "Read Google Drive comments" && refusals-- > 0) {
          throw new Error("refused");
        }
      },
    });
    let pager = session.commentPager("file-1", quotingPages);

    await expect(pager.next()).rejects.toThrow("refused");
    await expect(pager.next()).resolves.toEqual([shown(record("c1"))]);
    expect(listComments).toHaveBeenCalledTimes(2);
    expect(authorizations).toHaveLength(2);
    expectReported(authorizations[1], ["drive/file/file-1", "docs/document/file-1"]);

    await expect(pager.next()).resolves.toBeNull();
    expect(authorizations).toHaveLength(2);
  });

  it("passes on Drive's refusal to list a file's comments, disclosing no page", async () => {
    let refused = new DriveApiRequestError(403, "insufficientFilePermissions");
    let refusals = 1;
    let { session, authorizations } = core({
      listComments: async () => {
        if (refusals-- > 0) throw refused;
        return { comments: [record("c1")] };
      },
    });
    let pager = session.commentPager("file-1", plainPages);

    await expect(pager.next()).rejects.toBe(refused);
    expect(authorizations).toEqual([]);

    await expect(pager.next()).resolves.toEqual([shown(record("c1"))]);
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0].title).toBe("Read Google Drive comments");
    expectReported(authorizations[0], ["drive/file/file-1"]);
  });

  // One next() walks past an empty page, so a failure on the page after it follows a page already
  // read. Nothing of that call is disclosed, and the retry reads both pages again: what it reports
  // is what its own pages show.
  it("reports only what the retry shows after a later page of the same call failed", async () => {
    let failure = new DriveApiRequestError(500, "backendError");
    let failures = 1;
    let { session, listComments, authorizations } = core({
      listComments: async (_id, options) => {
        if (options?.pageToken !== "p2") return { comments: [], nextPageToken: "p2" };
        if (failures-- > 0) throw failure;
        return { comments: [record("c1")] };
      },
    });
    let reads = 0;
    let quotingFirstRead: CommentPageReader = async fetch => {
      let quotes = ++reads === 1;
      let page = await plainPages(fetch);
      return quotes ? { ...page, quotesDocument: true } : page;
    };
    let pager = session.commentPager("file-1", quotingFirstRead);

    await expect(pager.next()).rejects.toBe(failure);
    expect(authorizations).toEqual([]);

    await expect(pager.next()).resolves.toEqual([shown(record("c1"))]);
    expect(listComments).toHaveBeenCalledTimes(4);
    expect(authorizations).toHaveLength(1);
    expectReported(authorizations[0], ["drive/file/file-1"]);
  });

  // The cursor refuses a repeated page token once the page carrying it has been read, and
  // discloses nothing of that page. The retry reads the page again, and what it reports is what
  // the page shows then.
  it("reports only what the retry shows after Drive repeated a page token", async () => {
    let repeats = 1;
    let { session, listComments, authorizations } = core({
      listComments: async (_id, options) => {
        if (options?.pageToken !== "p2") return { comments: [record("c1")], nextPageToken: "p2" };
        return { comments: [record("c2")], ...(repeats-- > 0 ? { nextPageToken: "p2" } : {}) };
      },
    });
    let reads = 0;
    let quotingSecondRead: CommentPageReader = async fetch => {
      let quotes = ++reads === 2;
      let page = await plainPages(fetch);
      return quotes ? { ...page, quotesDocument: true } : page;
    };
    let pager = session.commentPager("file-1", quotingSecondRead);

    await expect(pager.next()).resolves.toEqual([shown(record("c1"))]);
    await expect(pager.next()).rejects.toThrow("Google Drive returned a repeated page token.");
    expect(authorizations).toHaveLength(1);

    await expect(pager.next()).resolves.toEqual([shown(record("c2"))]);
    expect(listComments).toHaveBeenCalledTimes(3);
    expect(authorizations).toHaveLength(2);
    expectReported(authorizations[1], ["drive/file/file-1"]);
  });
});
