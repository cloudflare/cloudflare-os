import { describe, expect, it, vi } from "vitest";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  DRIVE_OBSERVATION_PREFIX, DriveSessionCore, driveFileToEntry, driveObserverTracker,
  type DriveAccessVerdicts, type DriveBindingScope,
} from "../src/drive-session";
import type { DriveFile, DriveListFilesOptions } from "../src/drive-api";
import { FakeKv } from "./fake-kv";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

const file = (overrides: Partial<DriveFile> = {}): DriveFile => ({
  id: "file-1",
  name: "Quarterly plan",
  mimeType: "application/pdf",
  modifiedTime: "2026-01-02T03:04:05Z",
  ...overrides,
});

function core(overrides: {
  scope?: { kind: "account" } | { kind: "sharedDrive"; driveId: string } |
    { kind: "file"; fileId: string };
  files?: DriveFile[];
  getFile?: (id: string) => Promise<DriveFile>;
  getDrive?: (id: string) => Promise<{ id: string; name: string }>;
  listFiles?: (options: DriveListFilesOptions) => Promise<{
    files: DriveFile[];
    nextPageToken?: string;
  }>;
  authorize?: (description: ObservationDescription) => Promise<void>;
} = {}) {
  let listFiles = vi.fn(overrides.listFiles ?? (async () => ({ files: overrides.files ?? [file()] })));
  let getFile = vi.fn(overrides.getFile ?? (async (id: string) => file({ id })));
  let getDrive = vi.fn(overrides.getDrive ??
    (async (id: string) => ({ id, name: "Current shared drive" })));
  let prepared: string[][] = [];
  let authorizations: ObservationDescription[] = [];
  let events: string[] = [];
  let session = new DriveSessionCore({
    api: { listFiles, getFile, getDrive },
    scope: overrides.scope ?? { kind: "account" },
    prepareObservation: async (ids: string[]) => {
      prepared.push(ids);
      return {
        excludeObservers: ["excluded"],
        pendingSets: ids,
        commit: () => events.push("commit"),
      };
    },
    authorize: async (description: ObservationDescription) => {
      authorizations.push(description);
      events.push("authorize");
      await overrides.authorize?.(description);
    },
  });
  return { session, listFiles, getFile, getDrive, prepared, authorizations, events };
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

  it("refuses another file ID without calling Google for a file-scoped binding", async () => {
    let { session, getFile } = core({ scope: { kind: "file", fileId: "file-1" } });
    await expect(session.getEntry("file-2")).rejects.toThrow(/outside this Drive binding/);
    expect(getFile).not.toHaveBeenCalled();
  });

  it("lists an exact-file binding without scanning the connected account", async () => {
    let { session, listFiles, getFile, prepared } = core({
      scope: { kind: "file", fileId: "file-1" },
    });

    await expect((await session.list()).next())
      .resolves.toEqual([expect.objectContaining({ id: "file-1" })]);
    expect(getFile).toHaveBeenCalledWith("file-1");
    expect(listFiles).not.toHaveBeenCalled();
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
    expect(prepared).toEqual([]);
    expect(authorizations).toEqual([]);
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

  it("rejects a non-folder parent after confirming it is in scope", async () => {
    let { session, listFiles, getFile, prepared, authorizations } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async id => file({ id, driveId: "drive-1", mimeType: "application/pdf" }),
    });

    await expect(session.list({ directParentId: "file-x" }))
      .rejects.toThrow(/must identify a folder/);
    expect(getFile).toHaveBeenCalledWith("file-x");
    expect(listFiles).not.toHaveBeenCalled();
    expect(prepared).toEqual([]);
    expect(authorizations).toEqual([]);
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

describe("Drive search validation", () => {
  it("requires at least one populated search filter", async () => {
    let { session } = core();
    await expect(session.search({ nameContains: "   " })).rejects.toThrow(/at least one filter/);
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
    await expect(session.search({ nameContains: "plan" })).rejects.toThrow(/getEntry/);
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

    await (await session.search({ nameContains: "plan", fullTextContains: longText })).next();
    let observation = authorizations[0];
    expect(observation.title).toBe("Read Google Drive metadata");
    expect(observation.title).not.toContain(longText);
    expect(observation.title).not.toContain("plan");
    expect(observation.description).toContain("shared drive drive-1");
    expect(observation.description).toContain("plan");
    expect(observation.description).toContain("salary-review-");
    expect(observation.description).not.toContain(longText);
    expect(observation.description.length).toBeLessThanOrEqual(240);
  });
});

describe("driveObserverTracker", () => {
  function tracker(scope: DriveBindingScope, verdicts: (ids: readonly string[]) => DriveAccessVerdicts) {
    let kv = new FakeKv();
    let asked: string[][] = [];
    let track = driveObserverTracker<"verifier">(kv, scope, async (_verifier, fileIds) => {
      asked.push([...fileIds]);
      return verdicts(fileIds);
    });
    return { kv, asked, track };
  }

  const allow = (ids: readonly string[]): DriveAccessVerdicts =>
    ({ baselineAllowed: true, allowed: ids.map(() => true) });
  const deny = (ids: readonly string[]): DriveAccessVerdicts =>
    ({ baselineAllowed: true, allowed: ids.map(() => false) });

  it("seeds a file binding with its bound file, so a joiner is verified against it", async () => {
    let { kv, asked, track } = tracker({ kind: "file", fileId: "file-1" }, allow);

    expect([...kv.entries.keys()]).toEqual([`${DRIVE_OBSERVATION_PREFIX}file-1`]);
    await track.addObserver("obs", "verifier");
    expect(asked).toEqual([["file-1"]]);
  });

  it("seeds a shared-drive binding with its root", async () => {
    let { asked, track } = tracker({ kind: "sharedDrive", driveId: "drive-1" }, allow);

    await track.addObserver("obs", "verifier");
    expect(asked).toEqual([["drive-1"]]);
  });

  it("seeds an account binding with nothing", async () => {
    let { kv, asked, track } = tracker({ kind: "account" }, allow);

    expect([...kv.entries.keys()]).toEqual([]);
    await track.addObserver("obs", "verifier");
    expect(asked).toEqual([[]]);
  });

  it("refuses - and records no observer for - a joiner denied the bound file", async () => {
    let { kv, track } = tracker({ kind: "file", fileId: "file-1" }, deny);

    await expect(track.addObserver("obs", "verifier"))
      .rejects.toThrow(/cannot access Drive file file-1/);
    expect([...track.observers()]).toEqual([]);
    expect([...kv.entries.keys()]).toEqual([`${DRIVE_OBSERVATION_PREFIX}file-1`]);
  });

  it("refuses a joiner holding no Drive grant at all", async () => {
    let { track } = tracker({ kind: "file", fileId: "file-1" },
      ids => ({ baselineAllowed: false, allowed: ids.map(() => false) }));

    await expect(track.addObserver("obs", "verifier"))
      .rejects.toThrow(/has not granted Google Drive access/);
  });

  it("percent-encodes an ID that would otherwise collide with the key grammar", async () => {
    let { kv, asked, track } = tracker({ kind: "file", fileId: "a:b/c" }, allow);

    expect([...kv.entries.keys()]).toEqual([`${DRIVE_OBSERVATION_PREFIX}a%3Ab%2Fc`]);
    await track.addObserver("obs", "verifier");
    expect(asked).toEqual([["a:b/c"]]);
  });
});
