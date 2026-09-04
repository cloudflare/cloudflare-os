import { describe, expect, it, vi } from "vitest";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { DriveSessionCore, driveFileToEntry, type DriveBindingScope } from "../src/drive-session";
import { readFolderRoot } from "../src/drive-folder-scope";
import {
  DriveApiRequestError, FOLDER_MIME_TYPE,
  type DriveFile, type DriveListFilesOptions, type DriveScopeNode,
} from "../src/drive-api";
import type { ObserverCheck } from "../src/observers";
import { driveObserverTracker } from "../src/drive-observers";
import { FakeKv } from "./fake-kv";
import type { DriveEntry } from "../src/drive-types";

const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
const docMime = "application/vnd.google-apps.document";
const sheetMime = "application/vnd.google-apps.spreadsheet";

const file = (overrides: Partial<DriveFile> = {}): DriveFile => ({
  id: "file-1",
  name: "Quarterly plan",
  mimeType: "application/pdf",
  modifiedTime: "2026-01-02T03:04:05Z",
  ...overrides,
});

function core(overrides: {
  scope?: DriveBindingScope;
  files?: DriveFile[];
  getFile?: (id: string) => Promise<DriveFile>;
  getDrive?: (id: string) => Promise<{ id: string; name: string }>;
  listFiles?: (options: DriveListFilesOptions) => Promise<{
    files: DriveFile[];
    nextPageToken?: string;
  }>;
  getScopeNodes?: (ids: readonly string[]) => Promise<(DriveScopeNode | undefined)[]>;
  prepareObservation?: (ids: string[]) => Promise<ObserverCheck<string>>;
  prepareWithheld?: () => ObserverCheck<string>;
  authorize?: (description: ObservationDescription) => Promise<void>;
} = {}) {
  let listFiles = vi.fn(overrides.listFiles ?? (async () => ({ files: overrides.files ?? [file()] })));
  let getFile = vi.fn(overrides.getFile ?? (async (id: string) => file({ id })));
  let getDrive = vi.fn(overrides.getDrive ??
    (async (id: string) => ({ id, name: "Current shared drive" })));
  let getScopeNodes = vi.fn(overrides.getScopeNodes ??
    (async (ids: readonly string[]) => ids.map(() => undefined)));
  let prepared: string[][] = [];
  let authorizations: ObservationDescription[] = [];
  let events: string[] = [];
  let session = new DriveSessionCore({
    api: { listFiles, getFile, getDrive, getScopeNodes },
    scope: overrides.scope ?? { kind: "account" },
    prepareObservation: overrides.prepareObservation ?? (async (ids: string[]) => {
      prepared.push(ids);
      return {
        excludeObservers: ["excluded"],
        pendingSets: ids,
        commit: () => events.push("commit"),
      };
    }),
    prepareWithheld: overrides.prepareWithheld ?? (() => ({
      excludeObservers: ["excluded"],
      pendingSets: [],
      commit: () => events.push("latch"),
      discard: () => events.push("unlatch"),
    })),
    authorize: async (description: ObservationDescription) => {
      authorizations.push(description);
      events.push("authorize");
      await overrides.authorize?.(description);
    },
  });
  return {
    session, listFiles, getFile, getDrive, getScopeNodes, prepared, authorizations, events,
  };
}

const FOLDER_ROOT = "folder-root";

const folder = (id: string, overrides: Partial<DriveFile> = {}): DriveFile =>
  file({ id, name: id, mimeType: FOLDER_MIME_TYPE, trashed: false, ...overrides });

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
      };
    }),
  };
}

/** A folder-scoped core over `nodes`, which must include the root itself. */
function folderCore(nodes: DriveFile[], overrides: Parameters<typeof core>[0] = {}) {
  let provider = tree(nodes);
  return {
    ...core({
      scope: { kind: "folder", folderId: FOLDER_ROOT },
      getFile: provider.getFile,
      getScopeNodes: provider.getScopeNodes,
      ...overrides,
    }),
    provider,
  };
}

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

describe("Drive session scope", () => {
  it("lists the connected account and authorizes every returned file before committing", async () => {
    let { session, listFiles, prepared, authorizations, events } = core();
    let page = await (await session.list()).next();

    expect(page?.map(entry => entry.id)).toEqual(["file-1"]);
    expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({ corpus: { kind: "user" } }));
    expect(prepared).toEqual([["file-1"]]);
    expect(authorizations[0].excludeObservers).toEqual(["excluded"]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  it.each([
    ["account", { kind: "account" }],
    ["shared drive", { kind: "sharedDrive", driveId: "drive-1" }],
  ] as const)("audits and rejects an empty %s search", async (_label, scope) => {
    let { session, prepared, authorizations, events } = core({ scope, files: [] });

    let cursor = await session.search({ namePrefix: "missing" });
    await expect(cursor.next()).rejects
      .toThrow(new Error("An empty Drive search cannot be shared safely."));

    expect(prepared).toEqual([]);
    expect(authorizations).toEqual([expect.objectContaining({
      title: "Search Google Drive metadata",
      description: expect.stringContaining('name starts with "missing"'),
      excludeObservers: ["excluded"],
    })]);
    expect(authorizations[0]).not.toHaveProperty("prohibitAllSharing");
    expect(authorizations[0].description).not.toContain("0");
    // The read registers no file ID, so nothing could ever verify a later observer against it:
    // the audit lands, then admission latches closed, and only then is the caller refused.
    expect(events).toEqual(["authorize", "latch"]);
  });

  it("leaves admission open when the empty search is itself refused", async () => {
    let { session, events } = core({
      files: [],
      authorize: async () => { throw new Error("denied"); },
    });

    await expect((await session.search({ namePrefix: "missing" })).next())
      .rejects.toThrow("denied");
    expect(events).toEqual(["authorize", "unlatch"]);
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

  it("pins shared-drive reads and drops a foreign result before observation", async () => {
    let local = file({ id: "local", driveId: "drive-1" });
    let foreign = file({ id: "foreign", driveId: "drive-2" });
    let { session, listFiles, prepared } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      files: [local, foreign],
    });

    let page = await (await session.list()).next();
    expect(page?.map(entry => entry.id)).toEqual(["local"]);
    expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({
      corpus: { kind: "drive", driveId: "drive-1" },
    }));
    expect(prepared).toEqual([["local"]]);
  });

  it("re-applies the shared-drive corpus pin on every page", async () => {
    let { session, listFiles } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      listFiles: async options => options.pageToken === "page-2"
        ? { files: [file({ id: "local-2", driveId: "drive-1" })] }
        : { files: [file({ id: "local-1", driveId: "drive-1" })], nextPageToken: "page-2" },
    });

    let cursor = await session.list();
    expect((await cursor.next())?.map(entry => entry.id)).toEqual(["local-1"]);
    expect((await cursor.next())?.map(entry => entry.id)).toEqual(["local-2"]);
    expect(listFiles).toHaveBeenNthCalledWith(1, expect.objectContaining({
      corpus: { kind: "drive", driveId: "drive-1" },
    }));
    expect(listFiles).toHaveBeenNthCalledWith(2, expect.objectContaining({
      corpus: { kind: "drive", driveId: "drive-1" },
      pageToken: "page-2",
    }));
  });

  it("refuses a direct lookup outside a shared drive before authorizing it", async () => {
    let { session, prepared, authorizations } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async id => file({ id, driveId: "drive-2" }),
    });

    await expect(session.getEntry("foreign")).rejects.toThrow(/outside this Drive binding/);
    expect(prepared).toEqual([]);
    expect(authorizations).toEqual([]);
  });

  it.each([403, 404])(
    "does not reveal whether the account can read a shared-drive probe rejected with %d",
    async status => {
      let { session, prepared } = core({
        scope: { kind: "sharedDrive", driveId: "drive-1" },
        getFile: async () => { throw new DriveApiRequestError(status); },
      });

      let outside = new Error("The requested file is outside this Drive binding.");
      await expect(session.getEntry("foreign")).rejects.toThrow(outside);
      await expect(session.list({ directParentId: "foreign" })).rejects.toThrow(outside);
      expect(prepared).toEqual([]);
    },
  );

  it("preserves a shared-drive provider outage", async () => {
    let { session } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async () => { throw new DriveApiRequestError(500); },
    });

    await expect(session.getEntry("file-1")).rejects
      .toThrow("Google Drive API request failed: 500");
  });

  it.each([
    "dailyLimitExceeded",
    "rateLimitExceeded",
    "userRateLimitExceeded",
  ])("preserves a shared-drive quota failure reported as %s", async reason => {
    let error = new DriveApiRequestError(403, reason);
    let { session } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async () => { throw error; },
    });

    await expect(session.getEntry("file-1")).rejects.toThrow(error);
  });

  it("refuses another file ID without calling Google for a file-scoped binding", async () => {
    let { session, getFile } = core({ scope: { kind: "file", fileId: "file-1" } });
    await expect(session.getEntry("file-2")).rejects.toThrow(/outside this Drive binding/);
    expect(getFile).not.toHaveBeenCalled();
  });

  it("lists an exact-file binding without scanning the connected account", async () => {
    let { session, listFiles, getFile, prepared } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async id => file({ id, trashed: false }),
    });

    await expect((await session.list()).next())
      .resolves.toEqual([expect.objectContaining({ id: "file-1" })]);
    expect(getFile).toHaveBeenCalledWith("file-1");
    expect(listFiles).not.toHaveBeenCalled();
    expect(prepared).toEqual([["file-1"]]);
  });

  it("omits a trashed file from an exact-file listing", async () => {
    let { session, prepared } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async () => file({ trashed: true }),
    });

    await expect((await session.list()).next()).resolves.toBeNull();
    expect(prepared).toEqual([["file-1"]]);
  });

  it("omits an exact file whose trash state is absent", async () => {
    let { session, prepared } = core({
      scope: { kind: "file", fileId: "file-1" },
    });

    await expect((await session.list()).next()).resolves.toBeNull();
    expect(prepared).toEqual([["file-1"]]);
  });

  it("still returns a trashed exact file from getEntry", async () => {
    let { session, prepared } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async () => file({ trashed: true }),
    });

    await expect(session.getEntry("file-1")).resolves
      .toEqual(expect.objectContaining({ id: "file-1" }));
    expect(prepared).toEqual([["file-1"]]);
  });

  it("rejects an exact-file listing when the provider returns a different id", async () => {
    let { session, listFiles } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async () => file({ id: "file-other" }),
    });

    await expect((await session.list()).next()).rejects.toThrow(/outside this Drive binding/);
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("reads current shared-drive scope metadata and observes its root ID", async () => {
    let { session, getDrive, prepared } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
    });
    await expect(session.getScope()).resolves.toEqual({
      kind: "sharedDrive", driveId: "drive-1", name: "Current shared drive",
    });
    expect(getDrive).toHaveBeenCalledWith("drive-1");
    expect(prepared).toEqual([["drive-1"]]);
  });

  it("refuses a shared-drive scope read when the provider returns another drive", async () => {
    let { session, getDrive, prepared } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getDrive: async () => ({ id: "drive-other", name: "Spoofed name" }),
    });

    await expect(session.getScope()).rejects.toThrow(/outside this Drive binding/);
    expect(getDrive).toHaveBeenCalledTimes(1);
    expect(getDrive).toHaveBeenCalledWith("drive-1");
    expect(prepared).toEqual([]);
  });

  it("refuses a file scope read when the provider returns another file", async () => {
    let { session, getFile, prepared } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async () => file({ id: "file-other", name: "Spoofed name" }),
    });

    await expect(session.getScope()).rejects.toThrow(/outside this Drive binding/);
    expect(getFile).toHaveBeenCalledWith("file-1");
    expect(prepared).toEqual([]);
  });

  it("treats the shared-drive root id as in scope", async () => {
    let { session, prepared } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      files: [file({ id: "drive-1", name: "Drive root", mimeType: FOLDER_MIME_TYPE })],
    });

    let page = await (await session.list()).next();
    expect(page?.map(entry => entry.id)).toEqual(["drive-1"]);
    expect(prepared).toEqual([["drive-1"]]);
  });

  it("drops a My Drive file when the provider ignores the shared-drive corpus", async () => {
    let { session, prepared, authorizations } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      files: [file({ id: "mydrive-file" })],
    });

    await expect((await session.list()).next()).resolves.toBeNull();
    expect(prepared).toEqual([[]]);
    expect(authorizations).toHaveLength(1);
  });
});

describe("Drive parent folder probe", () => {
  it("rejects a parent from another shared drive before listing", async () => {
    let { session, listFiles, getFile, prepared, authorizations } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async id => file({ id, driveId: "drive-2", mimeType: FOLDER_MIME_TYPE }),
    });

    await expect(session.list({ directParentId: "folder-x" }))
      .rejects.toThrow(/outside this Drive binding/);
    expect(getFile).toHaveBeenCalledWith("folder-x");
    expect(listFiles).not.toHaveBeenCalled();
    expect(prepared).toEqual([]);
    expect(authorizations).toEqual([]);
  });

  it("observes a readable non-folder parent before disclosing its type", async () => {
    let { session, listFiles, getFile, prepared, authorizations, events } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async id => file({ id, driveId: "drive-1", mimeType: "application/pdf" }),
    });

    await expect(session.list({ directParentId: "file-x" }))
      .rejects.toThrow(/must identify a folder/);
    expect(getFile).toHaveBeenCalledWith("file-x");
    expect(listFiles).not.toHaveBeenCalled();
    expect(prepared).toEqual([["file-x"]]);
    expect(authorizations).toEqual([expect.objectContaining({
      title: "Check Google Drive folder",
      excludeObservers: ["excluded"],
    })]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  it("does not disclose a readable non-folder parent when observation is denied", async () => {
    let { session, listFiles, prepared, authorizations, events } = core({
      getFile: async id => file({ id, mimeType: "application/pdf" }),
      authorize: async () => { throw new Error("denied"); },
    });

    await expect(session.list({ directParentId: "file-x" })).rejects.toThrow("denied");
    expect(listFiles).not.toHaveBeenCalled();
    expect(prepared).toEqual([["file-x"]]);
    expect(authorizations).toHaveLength(1);
    expect(events).toEqual(["authorize"]);
  });

  it("rejects a parent probe on a file-scoped binding without calling Google", async () => {
    let { session, getFile, listFiles } = core({ scope: { kind: "file", fileId: "file-1" } });

    await expect(session.list({ directParentId: "folder-x" }))
      .rejects.toThrow(/outside this Drive binding/);
    expect(getFile).not.toHaveBeenCalled();
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("observes the parent-folder probe before listing its children", async () => {
    let { session, authorizations, events } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      files: [file({ id: "child-1", driveId: "drive-1", parents: ["folder-1"] })],
      getFile: async id => file({ id, driveId: "drive-1", mimeType: FOLDER_MIME_TYPE }),
    });

    await (await session.list({ directParentId: "folder-1" })).next();
    expect(authorizations[0].title).toBe("Check Google Drive folder");
    expect(authorizations[1].title).toBe("Read Google Drive metadata");
    expect(events).toEqual(["authorize", "commit", "authorize", "commit"]);
  });

  it("rejects search when the parent is outside the shared drive", async () => {
    let { session, listFiles, prepared, authorizations } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async id => file({ id, driveId: "drive-2", mimeType: FOLDER_MIME_TYPE }),
    });

    await expect(session.search({ directParentId: "folder-x" }))
      .rejects.toThrow(/outside this Drive binding/);
    expect(listFiles).not.toHaveBeenCalled();
    expect(prepared).toEqual([]);
    expect(authorizations).toEqual([]);
  });
});

describe("Drive native sessions", () => {
  it.each([
    ["account Doc", { kind: "account" } as const, docMime, "Google Doc"],
    ["account Sheet", { kind: "account" } as const, sheetMime, "Google Sheet"],
    ["shared-drive Doc", { kind: "sharedDrive", driveId: "drive-1" } as const,
      docMime, "Google Doc"],
    ["shared-drive Sheet", { kind: "sharedDrive", driveId: "drive-1" } as const,
      sheetMime, "Google Sheet"],
    ["exact-file Doc", { kind: "file", fileId: "file-1" } as const,
      docMime, "Google Doc"],
    ["exact-file Sheet", { kind: "file", fileId: "file-1" } as const,
      sheetMime, "Google Sheet"],
  ])("opens an in-scope native %s", async (_name, scope, mimeType, description) => {
    let { session, getFile } = core({
      scope,
      getFile: async id => file({
        id,
        mimeType,
        ...(scope.kind === "sharedDrive" ? { driveId: scope.driveId } : {}),
      }),
    });

    await expect(session.openNativeFile("file-1", mimeType, description))
      .resolves.toBe("file-1");
    expect(getFile).toHaveBeenCalledWith("file-1");
  });

  it("rejects a mismatched provider file ID before authorizing", async () => {
    let { session, prepared, authorizations } = core({
      getFile: async () => file({ id: "file-2", mimeType: docMime }),
    });

    await expect(session.openNativeFile("file-1", docMime, "Google Doc"))
      .rejects.toThrow(/outside this Drive binding/);
    expect(prepared).toEqual([]);
    expect(authorizations).toEqual([]);
  });

  // Excluding today's observers is not enough: nothing durable would stop a collaborator admitted
  // afterwards from inheriting the history, so the probed id is tracked like any other read.
  it.each([403, 404])(
    "tracks an account-scope %s probe so later observers are checked against it",
    async status => {
      let { session, prepared, authorizations, events } = core({
        getFile: async () => { throw new DriveApiRequestError(status); },
      });

      await expect(session.openNativeFile("file-1", docMime, "Google Doc"))
        .rejects.toBeInstanceOf(DriveApiRequestError);
      expect(prepared).toEqual([["file-1"]]);
      expect(events).toEqual(["authorize", "commit"]);
      expect(authorizations).toEqual([{
        title: "Check Google Drive file access",
        description: "Check whether the connected account can access Drive file file-1.",
        excludeObservers: ["excluded"],
      }]);
    },
  );

  // Through the real tracker: the probe is what a collaborator who joins afterwards is measured
  // against, which is the only thing that keeps them out of the history that holds its result.
  it("locks out a collaborator admitted after a failed probe", async () => {
    let kv = new FakeKv();
    let track = driveObserverTracker<string>(kv, { kind: "account" },
      async (_verifier, fileIds) => ({ baselineAllowed: true, allowed: fileIds.map(() => false) }));
    let session = new DriveSessionCore({
      api: {
        listFiles: async () => ({ files: [] }),
        getFile: async () => { throw new DriveApiRequestError(404); },
        getDrive: async (id: string) => ({ id, name: "Current shared drive" }),
        getScopeNodes: async ids => ids.map(() => undefined),
      },
      scope: { kind: "account" },
      prepareObservation: fileIds => track.prepareObservation(fileIds),
      prepareWithheld: () => track.prepareWithheld(),
      authorize: async () => {},
    });

    await expect(session.openNativeFile("file-1", docMime, "Google Doc"))
      .rejects.toBeInstanceOf(DriveApiRequestError);

    await expect(track.addObserver("late", "verifier"))
      .rejects.toThrow(/cannot access Drive data this workspace has read/);
    expect([...track.observers()]).toEqual([]);
  });

  it("rejects another exact-file ID before calling Google", async () => {
    let { session, getFile } = core({ scope: { kind: "file", fileId: "file-1" } });

    await expect(session.openNativeFile("file-2", docMime, "Google Doc"))
      .rejects.toThrow(/outside this Drive binding/);
    expect(getFile).not.toHaveBeenCalled();
  });

  it("rejects a foreign shared-drive file without authorizing or tracking it", async () => {
    let { session, prepared, authorizations } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async id => file({ id, driveId: "drive-2", mimeType: docMime }),
    });

    await expect(session.openNativeFile("foreign", docMime, "Google Doc"))
      .rejects.toThrow(/outside this Drive binding/);
    expect(prepared).toEqual([]);
    expect(authorizations).toEqual([]);
  });

  it.each([403, 404])(
    "normalizes a %s shared-drive probe failure without authorizing or tracking it",
    async status => {
      let { session, prepared, authorizations } = core({
        scope: { kind: "sharedDrive", driveId: "drive-1" },
        getFile: async () => { throw new DriveApiRequestError(status); },
      });

      await expect(session.openNativeFile("foreign", docMime, "Google Doc"))
        .rejects.toThrow(new Error("The requested file is outside this Drive binding."));
      expect(prepared).toEqual([]);
      expect(authorizations).toEqual([]);
    },
  );
  it.each([
    ["wrong native type", sheetMime, undefined],
    ["folder", "application/vnd.google-apps.folder", undefined],
    ["blob", "application/pdf", undefined],
    ["shortcut", "application/vnd.google-apps.shortcut", { targetId: "target-1" }],
  ])("observes a %s before rejecting its MIME type", async (_name, mimeType, shortcutDetails) => {
    let { session, prepared, authorizations, events } = core({
      getFile: async id => file({ id, mimeType, shortcutDetails }),
    });

    await expect(session.openNativeFile("file-1", docMime, "Google Doc"))
      .rejects.toThrow(/not a Google Doc/);
    expect(prepared).toEqual([["file-1"]]);
    expect(authorizations).toEqual([expect.objectContaining({ excludeObservers: ["excluded"] })]);
    expect(events).toEqual(["authorize", "commit"]);
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

  it("forwards observer exclusions and commits only after authorization", async () => {
    let { session, authorizations, events } = core({
      getFile: async id => file({ id, mimeType: docMime }),
    });

    await session.openNativeFile("file-1", docMime, "Google Doc");

    expect(authorizations).toEqual([expect.objectContaining({
      title: "Open Google Doc from Google Drive",
      excludeObservers: ["excluded"],
    })]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  it("leaves a denied file observation pending rather than observed", async () => {
    let state = "unknown";
    let { session } = core({
      getFile: async id => file({ id, mimeType: docMime }),
      prepareObservation: async ids => {
        state = "pending";
        return { pendingSets: ids, commit: () => { state = "observed"; } };
      },
      authorize: async () => { throw new Error("denied"); },
    });

    await expect(session.openNativeFile("file-1", docMime, "Google Doc"))
      .rejects.toThrow("denied");
    expect(state).toBe("pending");
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
    let { session, listFiles } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      files: [file({ id: "local", driveId: "drive-1" })],
    });
    await (await session.search({ fullTextContains: "budget" })).next();
    expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: null,
      corpus: { kind: "drive", driveId: "drive-1" },
    }));
  });

  it("rejects search on a file-scoped binding without listing", async () => {
    let { session, listFiles } = core({ scope: { kind: "file", fileId: "file-1" } });
    await expect(session.search({ namePrefix: "plan" })).rejects.toThrow(/getEntry/);
    expect(listFiles).not.toHaveBeenCalled();
  });
});

describe("Drive observation authorization", () => {
  it("does not commit an observation when authorization is denied", async () => {
    let { session, events } = core({
      authorize: async () => {
        throw new Error("denied");
      },
    });

    await expect((await session.list()).next()).rejects.toThrow(/denied/);
    expect(events).toEqual(["authorize"]);
  });

  it("includes the binding scope and a truncated query in the description", async () => {
    let longText = "salary-review-".repeat(8);
    let { session, authorizations } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      files: [file({ id: "local", driveId: "drive-1" })],
    });

    await (await session.search({ namePrefix: "plan", fullTextContains: longText })).next();
    let observation = authorizations[0];
    expect(observation.title).toBe("Read Google Drive metadata");
    expect(observation.title).not.toContain(longText);
    expect(observation.title).not.toContain("plan");
    expect(observation.description).toContain("shared drive drive-1");
    expect(observation.description).toContain('name starts with "plan"');
    expect(observation.description).toContain("salary-review-");
    expect(observation.description).not.toContain(longText);
    expect(observation.description.length).toBeLessThanOrEqual(240);
  });
});

// Drive has no folder corpus and no recursive ancestor predicate, so every one of these outcomes
// is decided by the gatekeeper's own `parents` walk rather than by anything the provider enforces.
describe("Drive folder scope", () => {
  const root = folder(FOLDER_ROOT, { parents: ["outside-folder"] });

  describe("membership", () => {
    it.each([
      ["the root itself", FOLDER_ROOT, [root]],
      ["a direct child", "kid", [root, child("kid", FOLDER_ROOT)]],
      ["a deep descendant", "deep",
        [root, folder("mid", { parents: [FOLDER_ROOT] }), child("deep", "mid")]],
      ["a subfolder inside a shared drive", "kid", [
        folder(FOLDER_ROOT, { parents: ["drive-1"], driveId: "drive-1" }),
        child("kid", FOLDER_ROOT, { driveId: "drive-1" }),
      ]],
    ])("admits %s", async (_label, fileId, nodes) => {
      let { session } = folderCore(nodes);
      expect((await session.getEntry(fileId)).id).toBe(fileId);
    });

    it.each([
      ["a sibling of the root", "sibling", [root, child("sibling", "outside-folder")]],
      ["the root's own parent", "outside-folder",
        [root, folder("outside-folder", { parents: ["grandparent"] })]],
      ["a file whose parent is unreadable", "orphan", [root, child("orphan", "hidden")]],
      ["a file with no parents at all", "loose", [root, file({ id: "loose", trashed: false })]],
      ["a file with an empty parent array", "loose",
        [root, file({ id: "loose", parents: [], trashed: false })]],
      // Drive gives a file one current parent; anything else is a shape this cannot decide.
      ["a file claiming two parents", "shared",
        [root, file({ id: "shared", parents: [FOLDER_ROOT, "elsewhere"], trashed: false })]],
      ["a trashed descendant", "gone",
        [root, child("gone", FOLDER_ROOT, { trashed: true })]],
      ["a descendant behind a trashed folder", "deep",
        [root, folder("mid", { parents: [FOLDER_ROOT], trashed: true }), child("deep", "mid")]],
      // A shortcut is a file of its own; it is listed, never followed, and cannot carry a chain.
      ["a descendant behind a shortcut", "deep", [
        root,
        file({ id: "link", mimeType: SHORTCUT_MIME_TYPE, parents: [FOLDER_ROOT], trashed: false }),
        child("deep", "link"),
      ]],
      ["a chain that cycles before reaching the root", "deep", [
        root,
        folder("a", { parents: ["b"] }),
        folder("b", { parents: ["a"] }),
        child("deep", "a"),
      ]],
    ])("refuses %s", async (_label, fileId, nodes) => {
      let { session } = folderCore(nodes);
      await expect(session.getEntry(fileId))
        .rejects.toThrow("The requested file is outside this Drive binding.");
    });

    // Both storage domains cap nesting at 100 levels, so a chain longer than that never terminates
    // at a legal root and must be abandoned rather than walked forever.
    it("refuses a chain deeper than Drive's own nesting limit", async () => {
      let chain = Array.from({ length: 120 },
        (_, index) => folder(`n${index}`, { parents: [index === 0 ? FOLDER_ROOT : `n${index - 1}`] }));
      let { session } = folderCore([root, ...chain, child("deep", "n119")]);

      await expect(session.getEntry("deep"))
        .rejects.toThrow("The requested file is outside this Drive binding.");
    });

    it("admits a descendant at the deepest legal nesting", async () => {
      let chain = Array.from({ length: 98 },
        (_, index) => folder(`n${index}`, { parents: [index === 0 ? FOLDER_ROOT : `n${index - 1}`] }));
      let { session } = folderCore([root, ...chain, child("deep", "n97")]);

      expect((await session.getEntry("deep")).id).toBe("deep");
    });

    // Membership is same-domain by construction: a chain that crosses between My Drive and a shared
    // drive is walking through a hierarchy the binding's corpus never covered.
    it("refuses a descendant whose chain changes storage domain", async () => {
      let { session } = folderCore([
        root,
        folder("mid", { parents: [FOLDER_ROOT], driveId: "drive-1" }),
        child("deep", "mid", { driveId: "drive-1" }),
      ]);

      await expect(session.getEntry("deep"))
        .rejects.toThrow("The requested file is outside this Drive binding.");
    });

    // The walk reads one ancestor level per round trip, so a move landing mid-walk leaves the
    // chain that would authorize the read already stale. Both direct operations go through the
    // same proof, and neither may disclose or audit anything off it.
    it.each([
      ["getEntry", (session: DriveSessionCore) => session.getEntry("deep")],
      ["openNativeFile",
        (session: DriveSessionCore) => session.openNativeFile("deep", docMime, "Google Doc")],
    ])("refuses %s when the chain changed during the ancestry walk", async (_label, operate) => {
      let provider = tree([
        root, folder("mid", { parents: [FOLDER_ROOT] }), child("deep", "mid", { mimeType: docMime }),
      ]);
      let walked = false;
      let { session, authorizations } = core({
        scope: { kind: "folder", folderId: FOLDER_ROOT },
        getFile: provider.getFile,
        getScopeNodes: async ids => {
          let nodes = await provider.getScopeNodes(ids);
          // "mid" leaves the subtree right after the walk read it, before the recheck re-reads it.
          if (!walked) {
            walked = true;
            provider.byId.set("mid", folder("mid", { parents: ["elsewhere"] }));
          }
          return nodes;
        },
      });

      await expect(operate(session))
        .rejects.toThrow("The requested file is outside this Drive binding.");
      expect(authorizations).toEqual([]);
    });
  });

  describe("root validation", () => {
    const badRoots: [string, DriveFile][] = [
      ["a root that is not a folder", file({ id: FOLDER_ROOT, trashed: false })],
      ["a shortcut standing in for the root",
        file({ id: FOLDER_ROOT, mimeType: SHORTCUT_MIME_TYPE, trashed: false })],
      ["a trashed root", folder(FOLDER_ROOT, { trashed: true })],
      // A shared drive's root carries the drive's own ID and is the Shared Drive resource.
      ["a shared drive's own root", folder(FOLDER_ROOT, { driveId: FOLDER_ROOT })],
      // The provider answering for another file would decide membership from the wrong facts.
      ["a root the provider echoes as another file", folder("someone-else")],
    ];

    it.each(badRoots)("refuses %s", async (_label, node) => {
      let { session } = folderCore([node]);
      await expect(session.getScope())
        .rejects.toThrow("The requested file is outside this Drive binding.");
    });

    // `describe()` runs before any session exists, so both entry points share one validator rather
    // than letting a hand-built resource URL mint a presentable binding that refuses every call.
    it.each(badRoots)("refuses %s through the validator describe() shares", async (_label, node) => {
      await expect(readFolderRoot(FOLDER_ROOT, async () => node))
        .rejects.toThrow("The requested file is outside this Drive binding.");
    });

    // The alias resolves per account, so it names no stable authority to confine anything to.
    it("refuses the account-relative alias at both entry points, contacting Drive at neither",
      async () => {
        let { session, getFile } = core({ scope: { kind: "folder", folderId: "root" } });
        await expect(session.getScope())
          .rejects.toThrow("The requested file is outside this Drive binding.");
        expect(getFile).not.toHaveBeenCalled();

        let fetch = vi.fn();
        await expect(readFolderRoot("root", fetch))
          .rejects.toThrow("The requested file is outside this Drive binding.");
        expect(fetch).not.toHaveBeenCalled();
      });

    it("reports the folder's current name against its immutable ID", async () => {
      let { session } = folderCore([folder(FOLDER_ROOT, { name: "Renamed", parents: ["above"] })]);

      expect(await session.getScope())
        .toEqual({ kind: "folder", folderId: FOLDER_ROOT, name: "Renamed" });
    });

    // The folder above the binding is outside it; naming it would disclose one level of hierarchy
    // the grant never covered.
    it("withholds the root's own parent", async () => {
      let { session } = folderCore([root, child("kid", FOLDER_ROOT)]);

      expect(await session.getEntry(FOLDER_ROOT)).not.toHaveProperty("parentId");
      expect(await session.getEntry("kid")).toMatchObject({ parentId: FOLDER_ROOT });
    });
  });

  describe("listing", () => {
    const page = (files: DriveFile[], nextPageToken?: string) =>
      ({ files, ...(nextPageToken ? { nextPageToken } : {}) });

    it("selects the corpus the root lives in and asks for a bounded page", async () => {
      let nodes = [
        folder(FOLDER_ROOT, { parents: ["drive-1"], driveId: "drive-1" }),
        child("kid", FOLDER_ROOT, { driveId: "drive-1" }),
      ];
      let { session, listFiles } = folderCore(nodes, {
        listFiles: async () => page([nodes[1]]),
      });

      await (await session.list()).next();
      expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({
        corpus: { kind: "drive", driveId: "drive-1" }, pageSize: 100,
      }));
    });

    it("uses the user corpus for a folder in My Drive", async () => {
      let { session, listFiles } = folderCore([root, child("kid", FOLDER_ROOT)], {
        listFiles: async () => page([child("kid", FOLDER_ROOT)]),
      });

      await (await session.list()).next();
      expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({ corpus: { kind: "user" } }));
    });

    it("returns only proven descendants, in the order the provider gave them", async () => {
      let nodes = [
        root,
        folder("mid", { parents: [FOLDER_ROOT] }),
        child("deep", "mid"),
        child("kid", FOLDER_ROOT),
        child("sibling", "outside-folder"),
      ];
      let { session } = folderCore(nodes, {
        listFiles: async () => page([nodes[4], nodes[2], nodes[3]]),
      });

      expect((await (await session.list()).next())?.map(entry => entry.id))
        .toEqual(["deep", "kid"]);
    });

    // The corpus scan returns the bound folder like any other row, and it proves as a member so
    // `getEntry` can read it. No test had ever put it in a provider page, so a listing disclosed
    // the folder as one of its own children and inflated every count by one.
    it("omits the bound folder from its own listing", async () => {
      let nodes = [root, folder("mid", { parents: [FOLDER_ROOT] }), child("kid", FOLDER_ROOT)];
      let { session } = folderCore(nodes, { listFiles: async () => page(nodes) });

      expect((await (await session.list()).next())?.map(entry => entry.id))
        .toEqual(["mid", "kid"]);
    });

    it("omits the bound folder from a search that matches folders", async () => {
      let nodes = [root, folder("mid", { parents: [FOLDER_ROOT] })];
      let { session } = folderCore(nodes, { listFiles: async () => page(nodes) });

      let cursor = await session.search({ mimeTypes: [FOLDER_MIME_TYPE] });
      expect((await cursor.next())?.map(entry => entry.id)).toEqual(["mid"]);
    });

    // The counterpart: excluding it from listings must not make the bound folder unreadable, and
    // its own parent stays withheld because that folder is outside the binding.
    it("still reads the bound folder's own metadata through getEntry", async () => {
      let { session } = folderCore([root]);

      let entry = await session.getEntry(FOLDER_ROOT);
      expect(entry.id).toBe(FOLDER_ROOT);
      expect(entry.parentId).toBeUndefined();
    });

    // The whole page filtering out is not a negative answer: one provider page per call is the
    // subrequest budget, and the results are on the next one.
    it("yields an empty page while results remain, then the results, then null", async () => {
      let nodes = [root, child("kid", FOLDER_ROOT), child("sibling", "outside-folder")];
      let { session } = folderCore(nodes, {
        listFiles: async ({ pageToken }) =>
          pageToken === "p2" ? page([nodes[1]]) : page([nodes[2]], "p2"),
      });

      let cursor = await session.list();
      expect(await cursor.next()).toEqual([]);
      expect((await cursor.next())?.map(entry => entry.id)).toEqual(["kid"]);
      expect(await cursor.next()).toBeNull();
    });

    // Membership is a post-filter, so a small folder in a large drive walks past many pages. One
    // audit record per scanned page would bury the listing that actually disclosed something.
    it("audits the listing, not every page the scan walked past", async () => {
      let nodes = [root, child("kid", FOLDER_ROOT), child("sibling", "outside-folder")];
      let { session, authorizations } = folderCore(nodes, {
        listFiles: async ({ pageToken }) =>
          pageToken === "p2" ? page([nodes[1]]) : page([nodes[2]], "p2"),
      });

      let cursor = await session.list();
      expect(await cursor.next()).toEqual([]);
      expect(authorizations).toEqual([]);
      expect((await cursor.next())?.map(entry => entry.id)).toEqual(["kid"]);
      expect(authorizations).toHaveLength(1);
    });

    // The terminal one is a real answer about the folder, so it still gets a record.
    it("audits a listing that ends with nothing in scope", async () => {
      let sibling = child("sibling", "outside-folder");
      let { session, authorizations } = folderCore([root, sibling], {
        listFiles: async () => page([sibling]),
      });

      expect(await (await session.list()).next()).toBeNull();
      expect(authorizations).toHaveLength(1);
      expect(authorizations[0].description).toContain("for 0 Drive");
    });

    // The withheld latch is permanent, so it must not fire on an emptiness the root's own
    // disappearance manufactured.
    it("refuses rather than latching when the root vanished during an empty search", async () => {
      let provider = tree([root]);
      let { session, events, authorizations } = core({
        scope: { kind: "folder", folderId: FOLDER_ROOT },
        getFile: provider.getFile,
        getScopeNodes: provider.getScopeNodes,
        listFiles: async () => {
          provider.byId.set(FOLDER_ROOT, folder(FOLDER_ROOT, { trashed: true }));
          return page([]);
        },
      });

      await expect((await session.search({ namePrefix: "anything" })).next())
        .rejects.toThrow("The requested file is outside this Drive binding.");
      expect(events).not.toContain("latch");
      expect(authorizations).toEqual([]);
    });

    // A root that changed drive is still a valid root, so only the pinned corpus catches it — and
    // the negative result was computed against the corpus the folder has left.
    it("refuses rather than latching when the root changed drive during an empty search", async () => {
      let provider = tree([root]);
      let { session, events, authorizations } = core({
        scope: { kind: "folder", folderId: FOLDER_ROOT },
        getFile: provider.getFile,
        getScopeNodes: provider.getScopeNodes,
        listFiles: async () => {
          provider.byId.set(FOLDER_ROOT,
            folder(FOLDER_ROOT, { parents: ["drive-1"], driveId: "drive-1" }));
          return page([]);
        },
      });

      await expect((await session.search({ namePrefix: "anything" })).next())
        .rejects.toThrow("moved to another drive");
      expect(events).not.toContain("latch");
      expect(authorizations).toEqual([]);
    });

    // A page token is only valid against the corpus that produced it, so a root that changes
    // domain mid-pagination has nowhere safe to resume.
    it("aborts a cursor whose root moved to another drive", async () => {
      let current = folder(FOLDER_ROOT, { parents: ["above"] });
      let provider = tree([current, child("kid", FOLDER_ROOT)]);
      let { session } = core({
        scope: { kind: "folder", folderId: FOLDER_ROOT },
        getFile: provider.getFile,
        getScopeNodes: provider.getScopeNodes,
        listFiles: async () => page([child("kid", FOLDER_ROOT)], "p2"),
      });

      let cursor = await session.list();
      expect((await cursor.next())?.map(entry => entry.id)).toEqual(["kid"]);
      provider.byId.set(FOLDER_ROOT,
        folder(FOLDER_ROOT, { parents: ["drive-1"], driveId: "drive-1" }));

      await expect(cursor.next()).rejects.toThrow(/moved to another drive/);
    });

    // The earliest hops of a page's proof are the stalest thing authorizing its disclosure, so the
    // recheck immediately before disclosure is what catches a move that landed during the walk.
    it("discards a page whose chain changed under it, without advancing the cursor", async () => {
      let provider = tree([root, folder("mid", { parents: [FOLDER_ROOT] }), child("deep", "mid")]);
      let calls = 0;
      let requested: (string | undefined)[] = [];
      let { session, authorizations } = core({
        scope: { kind: "folder", folderId: FOLDER_ROOT },
        getFile: provider.getFile,
        getScopeNodes: async ids => {
          // The walk resolves "mid" first; the recheck re-reads the whole path afterwards.
          if (++calls === 2) provider.byId.set("mid", folder("mid", { parents: ["elsewhere"] }));
          return provider.getScopeNodes(ids);
        },
        listFiles: async ({ pageToken }) => {
          requested.push(pageToken);
          return page([child("deep", "mid")], "p2");
        },
      });

      let cursor = await session.list();
      await expect(cursor.next())
        .rejects.toThrow("The requested file is outside this Drive binding.");
      expect(authorizations).toEqual([]);

      provider.byId.set("mid", folder("mid", { parents: [FOLDER_ROOT] }));
      expect((await cursor.next())?.map(entry => entry.id)).toEqual(["deep"]);
      expect(requested).toEqual([undefined, undefined]);
    });

    it("names the folder and its descendants in the observation", async () => {
      let { session, authorizations } = folderCore([root, child("kid", FOLDER_ROOT)], {
        listFiles: async () => page([child("kid", FOLDER_ROOT)]),
      });

      await (await session.list()).next();
      expect(authorizations[0].description)
        .toContain(`folder ${FOLDER_ROOT} and its descendants`);
    });
  });

  describe("native reads", () => {
    const nativeDoc = (parent: string) =>
      child("doc-1", parent, { mimeType: docMime });

    it("opens a native descendant and refuses one outside the subtree", async () => {
      let inside = folderCore([root, nativeDoc(FOLDER_ROOT)]);
      await expect(inside.session.openNativeFile("doc-1", docMime, "Google Doc"))
        .resolves.toBe("doc-1");

      let outside = folderCore([root, nativeDoc("outside-folder")]);
      await expect(outside.session.openNativeFile("doc-1", docMime, "Google Doc"))
        .rejects.toThrow("The requested file is outside this Drive binding.");
    });

    it("proves the file before the provider is contacted at all", async () => {
      let { session } = folderCore([root, nativeDoc("outside-folder")]);
      let fetched = vi.fn(async () => "content");

      await expect(session.nativeRead("doc-1", docMime)(fetched, () => ({
        title: "Read Google Doc content", description: "Read the body.",
      }))).rejects.toThrow("The requested file is outside this Drive binding.");
      expect(fetched).not.toHaveBeenCalled();
    });

    it("refuses a file whose native type no longer matches", async () => {
      let { session } = folderCore([root, child("doc-1", FOLDER_ROOT, { mimeType: "application/pdf" })]);
      let fetched = vi.fn(async () => "content");

      await expect(session.nativeRead("doc-1", docMime)(fetched, () => ({
        title: "Read Google Doc content", description: "Read the body.",
      }))).rejects.toThrow("The requested file is outside this Drive binding.");
      expect(fetched).not.toHaveBeenCalled();
    });

    // The move lands while the Docs API call is in flight, so only a check after the read catches
    // it — and the content must not be authorized, let alone returned.
    it("discards content when the file left the subtree during the read", async () => {
      let provider = tree([root, nativeDoc(FOLDER_ROOT)]);
      let { session, authorizations } = core({
        scope: { kind: "folder", folderId: FOLDER_ROOT },
        getFile: provider.getFile,
        getScopeNodes: provider.getScopeNodes,
      });

      await expect(session.nativeRead("doc-1", docMime)(async () => {
        provider.byId.set("doc-1", nativeDoc("outside-folder"));
        return "secret";
      }, () => ({ title: "Read Google Doc content", description: "Read the body." })))
        .rejects.toThrow("The requested file is outside this Drive binding.");
      expect(authorizations).toEqual([]);
    });

    it("authorizes and returns content that survived both checks", async () => {
      let { session, authorizations, prepared, events } =
        folderCore([root, nativeDoc(FOLDER_ROOT)]);

      await expect(session.nativeRead("doc-1", docMime)(async () => "body", () => ({
        title: "Read Google Doc content", description: "Read the body.",
      }))).resolves.toBe("body");
      expect(prepared).toEqual([["doc-1"]]);
      expect(authorizations).toEqual([expect.objectContaining({
        title: "Read Google Doc content", excludeObservers: ["excluded"],
      })]);
      expect(events).toEqual(["authorize", "commit"]);
    });

    // An immutable scope cannot move under the session, so it pays for no revalidation.
    it("makes no scope calls for a binding whose scope cannot change", async () => {
      let { session, getFile, getScopeNodes } = core({ scope: { kind: "file", fileId: "doc-1" } });

      await expect(session.nativeRead("doc-1", docMime)(async () => "body", () => ({
        title: "Read Google Doc content", description: "Read the body.",
      }))).resolves.toBe("body");
      expect(getFile).not.toHaveBeenCalled();
      expect(getScopeNodes).not.toHaveBeenCalled();
    });
  });

  describe("failure modes", () => {
    // A quota, outage, or account-wide block reported as a scope denial would look like the file
    // left the folder, and the caller would go looking for a move that never happened.
    it.each([
      ["a quota refusal", new DriveApiRequestError(403, "userRateLimitExceeded")],
      // The root read happens on every folder operation, so this is the one users would hit.
      ["an account-wide policy block", new DriveApiRequestError(403, "domainPolicy")],
      ["a server error", new DriveApiRequestError(500)],
    ])("surfaces %s rather than a scope denial", async (_label, error) => {
      let { session } = core({
        scope: { kind: "folder", folderId: FOLDER_ROOT },
        getFile: async () => { throw error; },
      });

      await expect(session.getEntry("kid")).rejects.toBe(error);
    });

    it("turns an inaccessible root into the generic refusal", async () => {
      let { session } = core({
        scope: { kind: "folder", folderId: FOLDER_ROOT },
        getFile: async () => { throw new DriveApiRequestError(404); },
      });

      await expect(session.getEntry("kid"))
        .rejects.toThrow("The requested file is outside this Drive binding.");
    });

    // Hidden ancestors and rejected neighbours are enforcement input, never disclosure: neither may
    // consume observer cardinality or appear in anything the caller or the audit trail sees.
    it("tracks and names only what it disclosed", async () => {
      let nodes = [
        root,
        folder("secret-mid", { parents: [FOLDER_ROOT] }),
        child("deep", "secret-mid"),
        child("private-neighbour", "outside-folder"),
      ];
      let { session, prepared, authorizations } = folderCore(nodes, {
        listFiles: async () => ({ files: [nodes[3], nodes[2]] }),
      });

      await (await session.list()).next();
      expect(prepared).toEqual([["deep"]]);
      let described = JSON.stringify(authorizations);
      expect(described).not.toContain("secret-mid");
      expect(described).not.toContain("private-neighbour");
      expect(described).not.toContain("outside-folder");
    });
  });

  // The end-to-end contract over a realistic fixture: a direct file, a nested one, and a sibling
  // outside the root, spread over pages so both cursors have to be drained past an empty slice.
  describe("draining a folder subtree", () => {
    const nodes = [
      root,
      child("direct-file", FOLDER_ROOT),
      folder("nested", { parents: [FOLDER_ROOT] }),
      child("nested-file", "nested"),
      child("sibling", "outside-folder"),
    ];

    /** Serves the sibling alone, then the two in-scope files, then ends. */
    const paged = async ({ pageToken }: DriveListFilesOptions) => {
      if (pageToken === undefined) return { files: [nodes[4]], nextPageToken: "p2" };
      if (pageToken === "p2") return { files: [nodes[1], nodes[3]], nextPageToken: "p3" };
      return { files: [] };
    };

    async function drain(cursor: { next(): Promise<DriveEntry[] | null> }): Promise<string[]> {
      let ids: string[] = [];
      for (let call = 0; call < 10; call++) {
        let page = await cursor.next();
        if (page === null) return ids;
        ids.push(...page.map(entry => entry.id));
      }
      throw new Error("cursor did not terminate");
    }

    it.each([
      ["list", async (session: DriveSessionCore) => session.list()],
      ["full-text search",
        async (session: DriveSessionCore) => session.search({ fullTextContains: "plan" })],
    ])("returns every descendant and no neighbour through %s", async (_label, open) => {
      let { session } = folderCore(nodes, { listFiles: paged });

      expect(await drain(await open(session))).toEqual(["direct-file", "nested-file"]);
    });
  });
});
