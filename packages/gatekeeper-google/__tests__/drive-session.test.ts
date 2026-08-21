import { describe, expect, it, vi } from "vitest";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { DriveSessionCore, driveFileToEntry } from "../src/drive-session";
import type { DriveFile } from "../src/drive-api";

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
} = {}) {
  let listFiles = vi.fn(async () => ({ files: overrides.files ?? [file()] }));
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
    expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({ corpora: "user" }));
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
      corpora: "drive", driveId: "drive-1",
    }));
    expect(prepared).toEqual([["local"]]);
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

  it("reads current shared-drive scope metadata and observes its root ID", async () => {
    let { session, prepared } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
    });
    await expect(session.getScope()).resolves.toEqual({
      kind: "sharedDrive", driveId: "drive-1", name: "Current shared drive",
    });
    expect(prepared).toEqual([["drive-1"]]);
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
    let { session, listFiles } = core({ files: [] });
    await (await session.search({ fullTextContains: "budget" })).next();
    expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({ orderBy: null }));
  });
});
