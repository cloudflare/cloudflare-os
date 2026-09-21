import { OBSERVATION_REFUSED_CODE } from "@gadgets/gatekeeper-kit/observers";
import { describe, expect, it, vi } from "vitest";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { DriveObservation } from "../src/drive-observers";
import {
  DriveFolderSessionCore, DriveSessionCore, driveFileToEntry, requireDriveBindingScope,
} from "../src/drive-session";
import { readFolderRoot, type FolderLocation } from "../src/drive-folder-scope";
import {
  DriveApiRequestError, FOLDER_MIME_TYPE,
  type DriveFile, type DriveListFilesOptions, type DriveScopeNode,
} from "../src/drive-api";
import type { DriveListOptions, DriveSearchQuery } from "../src/drive-types";
import type { ObserverCheck } from "../src/observers";
import { driveObserverTracker } from "../src/drive-observers";
import { FakeKv } from "./fake-kv";

const refusal = () =>
  Object.assign(new Error("refused"), { code: OBSERVATION_REFUSED_CODE });

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
  scope?: { kind: "account" } | { kind: "file"; fileId: string };
  files?: DriveFile[];
  getFile?: (id: string) => Promise<DriveFile>;
  listFiles?: (options: DriveListFilesOptions) => Promise<{
    files: DriveFile[];
    nextPageToken?: string;
  }>;
  getScopeNodes?: (ids: readonly string[]) => Promise<(DriveScopeNode | undefined)[]>;
  prepareObservation?: (
    observations: DriveObservation[],
  ) => Promise<ObserverCheck<DriveObservation>>;
  prepareWithheld?: () => ObserverCheck<DriveObservation>;
  authorize?: (description: ObservationDescription) => Promise<void>;
} = {}) {
  let listFiles = vi.fn(overrides.listFiles ?? (async () => ({ files: overrides.files ?? [file()] })));
  let getFile = vi.fn(overrides.getFile ?? (async (id: string) => file({ id })));
  let getScopeNodes = vi.fn(overrides.getScopeNodes ??
    (async (ids: readonly string[]) => ids.map(() => undefined)));
  let prepared: string[][] = [];
  let units: DriveObservation[][] = [];
  let authorizations: ObservationDescription[] = [];
  let events: string[] = [];
  let session = new DriveSessionCore({
    api: { listFiles, getFile, getScopeNodes },
    scope: overrides.scope ?? { kind: "account" },
    prepareObservation: overrides.prepareObservation ?? (async observations => {
      prepared.push(observations.map(observation => observation.fileId));
      units.push([...observations]);
      return {
        excludeObservers: ["excluded"],
        pendingSets: observations,
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
  return { session, listFiles, getFile, getScopeNodes, prepared, units, authorizations, events };
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
  it("lists the connected account and authorizes every returned file before committing", async () => {
    let { session, listFiles, prepared, authorizations, events } = core();
    let page = await (await session.list()).next();

    expect(page?.map(entry => entry.id)).toEqual(["file-1"]);
    expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({ corpus: { kind: "user" } }));
    expect(prepared).toEqual([["file-1"]]);
    expect(authorizations[0].excludeObservers).toEqual(["excluded"]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  it("audits and rejects an empty account search", async () => {
    let { session, prepared, authorizations, events } = core({ files: [] });

    let cursor = await session.search({ namePrefix: "missing" });
    await expect(cursor.next()).rejects
      .toThrow(new Error("An empty Drive search cannot be shared safely."));

    expect(prepared).toEqual([]);
    expect(authorizations).toEqual([expect.objectContaining({
      title: "Search Google Drive metadata",
      description: expect.stringContaining('name starts with "missing"'),
      excludeObservers: ["excluded"],
    })]);
    expect(authorizations[0]).not.toHaveProperty("containsRestrictedData");
    expect(authorizations[0].description).not.toContain("0");
    // The read registers no file ID, so nothing could ever verify a later observer against it:
    // the audit lands, then admission latches closed, and only then is the caller refused.
    expect(events).toEqual(["authorize", "latch"]);
  });

  // The overseer can record the observation and lose the response, so an unmarked failure leaves
  // the outcome unknown and the fence must stand.
  it("latches admission when an empty search's audit fails ambiguously", async () => {
    let { session, events } = core({
      files: [],
      authorize: async () => { throw new Error("connection lost"); },
    });

    await expect((await session.search({ namePrefix: "missing" })).next())
      .rejects.toThrow("connection lost");
    expect(events).toEqual(["authorize", "latch"]);
  });

  it("leaves admission open when the overseer marks the audit refused", async () => {
    let { session, events } = core({
      files: [],
      authorize: async () => { throw refusal(); },
    });

    await expect((await session.search({ namePrefix: "missing" })).next())
      .rejects.toThrow("refused");
    expect(events).toEqual(["authorize", "unlatch"]);
  });

  // An empty slice with pages still ahead is this call's budget running out, not a negative
  // answer: fencing it would close collaborator admission for good over nothing disclosed.
  it("keeps admission open when the page budget slices a listing", async () => {
    let page = 0;
    let { session, events } = core({
      listFiles: async () => ({ files: [], nextPageToken: `page-${++page}` }),
    });

    await expect((await session.search({ namePrefix: "missing" })).next()).resolves.toEqual([]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  // A file unit proves only metadata access, so it cannot stand for "this account can list the
  // folder": a metadata-only observer would pass it vacuously.
  it("records a listable parent folder as a folder observation", async () => {
    let { session, units, events } = core({ getFile: async id => folder(id) });

    await session.list({ directParentId: "F" });
    expect(units).toEqual([[{ kind: "folder", fileId: "F" }]]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  it("fences a live parent folder this account cannot list", async () => {
    let { session, units, events } = core({
      getFile: async id => folder(id, { capabilities: { canListChildren: false } }),
    });

    await expect(session.list({ directParentId: "F" }))
      .rejects.toThrow("directParentId must identify a folder whose children can be listed");
    expect(units).toEqual([]);
    expect(events).toEqual(["authorize", "latch"]);
  });

  it.each([
    ["a non-folder", (id: string) => file({ id })],
    ["a trashed folder", (id: string) => folder(id, { trashed: true })],
  ])("refuses %s parent as an objective disclosure", async (_label, getFile) => {
    let { session, units, events } = core({ getFile: async id => getFile(id) });

    await expect(session.list({ directParentId: "F" }))
      .rejects.toThrow("directParentId must identify a folder whose children can be listed");
    expect(units).toEqual([[{ kind: "file", fileId: "F" }]]);
    expect(events).toEqual(["authorize", "commit"]);
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

  it("refuses a file scope read when the provider returns another file", async () => {
    let { session, getFile, prepared } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async () => file({ id: "file-other", name: "Spoofed name" }),
    });

    await expect(session.getScope()).rejects.toThrow(/outside this Drive binding/);
    expect(getFile).toHaveBeenCalledWith("file-1");
    expect(prepared).toEqual([]);
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
  ) {
    const provider = tree(nodes);
    const queries: DriveListFilesOptions[] = [];
    const observations: DriveObservation[][] = [];
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
      },
      location,
      prepareObservation: async units => {
        observations.push([...units]);
        return { pendingSets: units, commit: () => events.push("commit") };
      },
      prepareWithheld: () => ({ pendingSets: [], commit: () => events.push("latch") }),
      authorize: async description => {
        authorizations.push(description);
        events.push("authorize");
      },
    });
    return { session, provider, queries, observations, authorizations, events, scopeBatches };
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

  it("fences an unopenable child only when the refusal is owner-relative", async () => {
    const objective = positioned([root, directDoc]);
    await expect(objective.session.openFolder("D0")).rejects.toThrow(/outside this Drive binding/);
    expect(objective.observations).toEqual([[
      { kind: "folder", fileId: "R" }, { kind: "file", fileId: "D0" },
    ]]);
    expect(objective.events).toEqual(["authorize", "commit"]);

    const unlistable = folder("U", { parents: ["R"], capabilities: { canListChildren: false } });
    const ownerRelative = positioned([root, unlistable]);
    await expect(ownerRelative.session.openFolder("U"))
      .rejects.toThrow(/outside this Drive binding/);
    expect(ownerRelative.observations).toEqual([]);
    expect(ownerRelative.events).toEqual(["authorize", "latch"]);
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
  // the file ever being recorded for a later observer to be checked against.
  it("records a direct child before its metadata can fail to convert", async () => {
    const malformed = child("M", "R", { mimeType: undefined });
    const { session, observations, events } = positioned([root, malformed]);

    await expect(session.getEntry("M")).rejects
      .toThrow("Google Drive omitted required file mimeType");
    expect(observations).toEqual([[
      { kind: "folder", fileId: "R" }, { kind: "file", fileId: "M" },
    ]]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  it("fences an invisible probe but not a visible non-child", async () => {
    const visible = positioned([root, nested, nestedDoc]);
    await expect(visible.session.getEntry("D1")).rejects.toThrow(/outside this Drive binding/);
    expect(visible.events).toEqual([]);

    const invisible = positioned([root]);
    await expect(invisible.session.getEntry("gone")).rejects.toThrow(/outside this Drive binding/);
    expect(invisible.events).toEqual(["authorize", "latch"]);
  });

  it("audits and rejects an empty folder search", async () => {
    const { session, authorizations, events } =
      positioned([root], undefined, async () => ({ files: [] }));

    await expect((await session.search({ namePrefix: "missing" })).next())
      .rejects.toThrow("An empty Drive search cannot be shared safely.");
    expect(authorizations).toEqual([expect.objectContaining({
      title: "Search Google Drive metadata",
      description: expect.stringContaining('name starts with "missing"'),
    })]);
    expect(events).toEqual(["authorize", "latch"]);
  });

  it("keeps admission open when the page budget slices a folder listing", async () => {
    let page = 0;
    const { session, observations, events } = positioned([root], undefined,
      async () => ({ files: [], nextPageToken: `page-${++page}` }));

    await expect((await session.search({ namePrefix: "missing" })).next()).resolves.toEqual([]);
    expect(observations).toEqual([[{ kind: "folder", fileId: "R" }]]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  // Polling N sibling folders one at a time costs a request each. The proof is unchanged: every
  // named folder must still be a listable direct child, so this only removes repeated requests.
  it("searches several proven child folders in one request", async () => {
    const second = folder("B", { parents: ["R"] });
    const secondDoc = child("D2", "B", { mimeType: docMime });
    const { session, queries, observations, events } =
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
    expect(observations).toEqual([[
      { kind: "folder", fileId: "R" },
      { kind: "folder", fileId: "A" },
      { kind: "folder", fileId: "B" },
      { kind: "file", fileId: "D1" },
      { kind: "file", fileId: "D2" },
    ]]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  it("names every searched folder in the recorded description", async () => {
    const second = folder("B", { parents: ["R"] });
    const { session, authorizations } =
      positioned([root, nested, second, nestedDoc], undefined, async () => ({ files: [] }));

    await expect((await session.search({ namePrefix: "D", childFolderIds: ["A", "B"] })).next())
      .rejects.toThrow(/empty Drive search/);
    expect(authorizations).toEqual([expect.objectContaining({
      description: expect.stringContaining("parents A, B"),
    })]);
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

  it("fences a named child folder this account cannot list", async () => {
    const unlistable = folder("B", { parents: ["R"], capabilities: { canListChildren: false } });
    const { session, queries, events } = positioned([root, unlistable]);

    await expect((await session.search({ namePrefix: "D", childFolderIds: ["B"] })).next())
      .rejects.toThrow(/outside this Drive binding/);
    expect(events).toEqual(["authorize", "latch"]);
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

  // A direct child that is not a folder is an objective refusal, recorded as a file unit exactly
  // as openFolder does; leaving it unrecorded lets a later collaborator inherit the probe.
  it("records a non-folder named child before refusing it", async () => {
    const { session, observations, events } = positioned([root, directDoc]);

    await expect((await session.search({ namePrefix: "D", childFolderIds: ["D0"] })).next())
      .rejects.toThrow(/outside this Drive binding/);
    expect(observations).toEqual([[
      { kind: "folder", fileId: "R" }, { kind: "file", fileId: "D0" },
    ]]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  // The authorizer revalidates immediately after `buildEntries` with no provider read between, so
  // one page proves the path and the named folders once each side of the fetch, not three times.
  it("proves a page's scope once before the fetch and once after", async () => {
    const second = folder("B", { parents: ["R"] });
    const { session, scopeBatches } =
      positioned([root, nested, second, nestedDoc], undefined, async () => ({ files: [] }));

    await expect((await session.search({ namePrefix: "D", childFolderIds: ["A", "B"] })).next())
      .rejects.toThrow(/empty Drive search/);
    expect(scopeBatches).toEqual([["R"], ["A", "B"], ["R"], ["A", "B"]]);
  });
});
