import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessTokenRequest } from "../../src/auth-retry";
import type { OfficeConversionResult, OfficeFileInspection } from "../../src/office-conversion";
import { GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, GOOGLE_SLIDES_MIME_TYPE } from "../../src/drive-session";
import { GatekeeperUserImpl, type UserAccount } from "../../src/google";
import {
  calendarPickerRank, hasCalendarPrivateAccessRole, hasCalendarWriteRole,
} from "../../src/calendar-api";
import {
  BigQueryConfiguratorUI, CalendarConfiguratorUI, DriveConfiguratorUI,
} from "../../src/google-configurators";
import type { GoogleAccessToken } from "../../src/google-api";
import { FOLDER_MIME_TYPE as FOLDER, SHORTCUT_MIME_TYPE as SHORTCUT } from "../../src/drive-api";
import {
  GOOGLE_DOC_RESOURCE, GOOGLE_DRIVE_RESOURCE, GOOGLE_SHEETS_RESOURCE, GOOGLE_SLIDES_RESOURCE,
  OFFICE_IMPORT_GRANT,
  SHARED_DRIVES_GRANT, resourceUrlPatternsToOAuthScopes,
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

  describe("Drive picker", () => {
    const picker = (holdsSharedDrivesGrant = true) => new DriveConfiguratorUI(
      async () => token("access-token"), async grant => grant !== SHARED_DRIVES_GRANT || holdsSharedDrivesGrant);

    /**
     * Answers each Drive request from `routes` by path, recording every URL asked for. A batch is
     * answered part by part from the `/files/<id>` routes.
     */
    const stubDrive = (routes: Record<string, unknown>) => {
      const calls: URL[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        calls.push(url);
        if (url.pathname === "/batch/drive/v3") return batchResponse(String(init?.body), routes);
        const path = url.pathname.replace(/^\/drive\/v3/, "");
        return path in routes
          ? Response.json(routes[path])
          : Response.json({ error: { code: 404, message: "File not found" } }, { status: 404 });
      }));
      return calls;
    };

    const batchResponse = (body: string, routes: Record<string, unknown>) => {
      const parts = [...body.matchAll(/GET \/drive\/v3\/files\/([^?]+)\?/g)].map(([, id], index) => {
        const file = routes[`/files/${decodeURIComponent(id)}`];
        return [
          "--batch", "Content-Type: application/http", `Content-ID: <response-item-${index}>`, "",
          file ? "HTTP/1.1 200 OK" : "HTTP/1.1 404 Not Found", "Content-Type: application/json", "",
          JSON.stringify(file ?? {}),
        ].join("\r\n");
      });
      return new Response(`${parts.join("\r\n")}\r\n--batch--\r\n`,
        { headers: { "Content-Type": "multipart/mixed; boundary=batch" } });
    };

    // My Drive's root can be bound only by its real ID: the folder scope refuses the `root` alias.
    it("opens on the account's groupings, with My Drive by its real ID", async () => {
      stubDrive({ "/files/root": { id: "0AMyRoot", name: "My Drive" } });

      await expect(picker().listDriveNodes("drive", "", null)).resolves.toEqual({
        nodes: [
          { id: "folder:0AMyRoot", title: "My Drive", kind: "folder", listable: true },
          { id: "shared-drives", title: "Shared drives", kind: "group" },
          { id: "shared-with-me", title: "Shared with me", kind: "group" },
          { id: "recent", title: "Recent", kind: "group" },
        ],
      });
    });

    // A reconnect from the picker's Allow access can sign the account in as someone else.
    it("reads My Drive's root afresh for every listing", async () => {
      const browser = picker();
      stubDrive({ "/files/root": { id: "alice-root", name: "My Drive" } });
      await browser.listDriveNodes("drive", "", null);
      stubDrive({ "/files/root": { id: "bob-root", name: "My Drive" } });

      await expect(browser.listDriveNodes("drive", "", null)).resolves.toMatchObject({
        nodes: expect.arrayContaining([expect.objectContaining({ id: "folder:bob-root" })]),
      });
    });

    it("lists a folder's children folders first, a shortcut standing for its target", async () => {
      const calls = stubDrive({
        "/files": {
          nextPageToken: "page-3",
          files: [
            { id: "sub", name: "Plans", mimeType: FOLDER, capabilities: { canListChildren: true } },
            { id: "locked", name: "Archive", mimeType: FOLDER, capabilities: { canListChildren: false } },
            {
              id: "doc", name: "Notes", mimeType: "application/vnd.google-apps.document",
              modifiedTime: "2026-10-01T10:00:00Z", size: "1536",
            },
            {
              id: "link", name: "Team folder", mimeType: SHORTCUT,
              shortcutDetails: { targetId: "team", targetMimeType: FOLDER },
            },
            { id: "dangling", name: "Gone", mimeType: SHORTCUT, shortcutDetails: {} },
          ],
        },
        "/files/team": { id: "team", mimeType: FOLDER, trashed: false, capabilities: { canListChildren: true } },
      });

      await expect(picker().listDriveNodes("folder:F1", "", "page-2")).resolves.toEqual({
        nodes: [
          { id: "folder:sub", title: "Plans", kind: "folder", listable: true },
          { id: "folder:locked", title: "Archive", kind: "folder", listable: false },
          {
            id: "doc:doc", title: "Notes", kind: "file", mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-10-01T10:00:00Z", size: 1536,
          },
          { id: "folder:team", title: "Team folder", kind: "folder", listable: true },
        ],
        nextCursor: "page-3",
      });
      expect(calls[0].searchParams.get("q")).toBe("trashed = false and 'F1' in parents");
      expect(calls[0].searchParams.get("corpora")).toBe("allDrives");
      expect(calls[0].searchParams.get("orderBy")).toBe("folder,name");
      expect(calls[0].searchParams.get("pageToken")).toBe("page-2");
    });

    // A shortcut outlives its target being deleted, unshared or trashed, and a listing says nothing
    // of the target, so what the shortcut offers is decided by the target as read.
    it("offers a shortcut only for a target that could be connected", async () => {
      const shortcut = (id: string, targetId: string, targetMimeType: string) =>
        ({ id, name: id, mimeType: SHORTCUT, shortcutDetails: { targetId, targetMimeType } });
      stubDrive({
        "/files": {
          files: [
            shortcut("Report", "q3", "application/pdf"),
            shortcut("Restricted", "limited", FOLDER),
            shortcut("Deleted", "gone", "application/pdf"),
            shortcut("Unshared", "unshared", FOLDER),
            shortcut("Binned", "trashed", "application/pdf"),
          ],
        },
        "/files/q3": { id: "q3", mimeType: "application/pdf", trashed: false },
        "/files/limited": { id: "limited", mimeType: FOLDER, trashed: false, capabilities: { canListChildren: false } },
        "/files/trashed": { id: "trashed", mimeType: "application/pdf", trashed: true },
      });

      await expect(picker().listDriveNodes("folder:F1", "", null)).resolves.toEqual({
        nodes: [
          { id: "file:q3", title: "Report", kind: "file", mimeType: "application/pdf" },
          { id: "folder:limited", title: "Restricted", kind: "folder", listable: false },
        ],
      });
    });

    it("lists the shared drives and what is shared with this account", async () => {
      const calls = stubDrive({
        "/drives": { drives: [{ id: "0ADrive", name: "Engineering" }] },
        "/files": { files: [{ id: "s1", name: "Budget", mimeType: "application/pdf" }] },
      });
      const browser = picker();

      await expect(browser.listDriveNodes("shared-drives", "", null)).resolves.toEqual({
        nodes: [{ id: "folder:0ADrive", title: "Engineering", kind: "sharedDrive" }],
      });
      await expect(browser.listDriveNodes("shared-with-me", "", null)).resolves.toEqual({
        nodes: [{ id: "file:s1", title: "Budget", kind: "file", mimeType: "application/pdf" }],
      });
      expect(calls[1].searchParams.get("q")).toBe("trashed = false and sharedWithMe = true");
    });

    // A native file connects as its editable type, and an Office file as the one it converts into.
    it("names Docs, Sheets and Slides files, native or Office, by the kind they connect as", async () => {
      stubDrive({
        "/files": {
          files: [
            { id: "d1", name: "Notes", mimeType: "application/vnd.google-apps.document" },
            { id: "d2", name: "Notes.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
            { id: "s1", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" },
            { id: "s2", name: "Budget.XLSM", mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12" },
            { id: "p1", name: "Deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
            { id: "f1", name: "Data.csv", mimeType: "text/csv" },
          ],
        },
      });

      const { nodes } = await picker().listDriveNodes("folder:F1", "", null);

      expect(nodes.map(node => node.id)).toEqual(
        ["doc:d1", "doc:d2", "sheets:s1", "sheets:s2", "slides:p1", "file:f1"]);
    });

    it("lists recent files, newest first, leaving folders to be browsed", async () => {
      const calls = stubDrive({
        "/files": {
          files: [
            { id: "d1", name: "Notes", mimeType: "application/vnd.google-apps.document" },
            {
              id: "link", name: "Team folder", mimeType: SHORTCUT,
              shortcutDetails: { targetId: "team", targetMimeType: FOLDER },
            },
          ],
        },
        "/files/team": { id: "team", mimeType: FOLDER, trashed: false, capabilities: { canListChildren: true } },
      });

      await expect(picker().listDriveNodes("recent", "", null)).resolves.toEqual({
        nodes: [{ id: "doc:d1", title: "Notes", kind: "file", mimeType: "application/vnd.google-apps.document" }],
      });
      // Folders before paging, so they cannot empty a page; a shortcut to one only once resolved.
      expect(calls[0].searchParams.get("q")).toBe(`trashed = false and mimeType != '${FOLDER}'`);
      expect(calls[0].searchParams.get("corpora")).toBe("user");
      expect(calls[0].searchParams.get("orderBy")).toBe("modifiedTime desc");
    });

    // `drives.list` needs `drive.readonly`, which browsing does not, so the picker asks for it.
    it("names the grant listing shared drives needs, without asking Drive, until the account holds it", async () => {
      const calls = stubDrive({ "/drives": { drives: [] } });

      await expect(picker(false).listDriveNodes("shared-drives", "", null))
        .resolves.toEqual({ nodes: [], needsGrant: SHARED_DRIVES_GRANT });
      expect(calls).toEqual([]);
    });

    // Search spans every corpus wherever the picker is open, so each result says whose it is.
    it("searches every drive by name, saying where each result lives", async () => {
      const calls = stubDrive({
        "/files": {
          files: [
            { id: "mine", name: "Team plans", mimeType: FOLDER, capabilities: { canListChildren: true } },
            { id: "theirs", name: "Team budget", owners: [{ displayName: "Ada" }] },
            { id: "in-drive", name: "Team drive notes", driveId: "drive-1" },
          ],
        },
      });

      const { nodes } = await picker().listDriveNodes("folder:F1", "Team", null);

      expect(nodes.map(node => [node.id, node.detail])).toEqual([
        ["folder:mine", "My Drive"],
        ["file:theirs", "Ada"],
        ["file:in-drive", "In a shared drive"],
      ]);
      expect(calls[0].searchParams.get("corpora")).toBe("allDrives");
      expect(calls[0].searchParams.get("q")).toBe("trashed = false and name contains 'Team'");
    });

    // Duplicate names are ordinary, and a shared file can be named to look like one of the user's
    // own, so without a differentiator the user cannot see which capability they are granting. A
    // unique name needs none.
    it("tells apart nodes whose names look the same", async () => {
      const long = "x".repeat(240);
      const names = ["Budget", "Budget\u200e", "budget\u200b", "Budget plan", `${long}A`, `${long}B`];
      stubDrive({
        "/files": {
          files: [
            ...names.map((name, index) => ({ id: `id${index}`, name })),
            { id: "1AbCdEfGhIjKlMnOpQrStUv_platform", name: "Engineering", driveId: "d1" },
          ],
        },
      });

      const { nodes } = await picker().listDriveNodes("drive", "Budget", null);

      expect(nodes.map(node => node.detail)).toEqual([
        "My Drive · id0", "My Drive · id1", "My Drive · id2", "My Drive", "My Drive · id4",
        "My Drive · id5", "In a shared drive",
      ]);
    });

    // The links Drive's and Docs' Copy link give out, and a browser's address bar, which adds the
    // signed-in account's index when there are several. A link finds the node the picker would list.
    it.each([
      ["a folder's sharing link", "https://drive.google.com/drive/folders/D2?usp=sharing", "folder:D2"],
      ["a folder from the address bar", "https://drive.google.com/drive/u/1/folders/D2", "folder:D2"],
      ["a file's sharing link", " https://drive.google.com/file/d/F7/view?usp=drive_link ", "file:F7"],
      ["a Google Doc's file sharing link", "https://drive.google.com/file/d/F9/view", "doc:F9"],
      ["a Google Doc's link", "https://docs.google.com/document/d/F9/edit?usp=sharing", "doc:F9"],
      ["a Google Sheet from the address bar", "https://docs.google.com/spreadsheets/u/0/d/F8/edit#gid=0", "sheets:F8"],
    ])("finds the node %s names, instead of searching for it by name", async (_, link, id) => {
      const calls = stubDrive({
        "/files/D2": { id: "D2", name: "Specs", mimeType: FOLDER, capabilities: { canListChildren: true } },
        "/files/F7": { id: "F7", name: "Q3.pdf", mimeType: "application/pdf" },
        "/files/F8": { id: "F8", name: "Q3", mimeType: "application/vnd.google-apps.spreadsheet" },
        "/files/F9": { id: "F9", name: "Q3", mimeType: "application/vnd.google-apps.document" },
        "/files/root": { id: "0AMyRoot", name: "My Drive", mimeType: FOLDER },
      });

      const { nodes } = await picker().listDriveNodes("folder:F1", link, null);

      expect(nodes.map(node => node.id)).toEqual([id]);
      expect(calls.map(url => url.pathname)).not.toContain("/drive/v3/files");
    });

    it("finds nothing for a Docs link to a file of another kind", async () => {
      stubDrive({ "/files/F7": { id: "F7", name: "Q3.pdf", mimeType: "application/pdf" } });

      await expect(picker().listDriveNodes("drive", "https://docs.google.com/document/d/F7/edit", null))
        .resolves.toEqual({ nodes: [] });
    });

    // An agent asking for a Drive file connection of a native file asked for read-only access.
    it("keeps a pre-filled Drive file id for a Google Doc, so it binds as a Drive file", async () => {
      stubDrive({
        "/files/F9": { id: "F9", name: "Q3", mimeType: "application/vnd.google-apps.document" },
        "/files/root": { id: "0AMyRoot", name: "My Drive", mimeType: FOLDER },
      });

      await expect(picker().getDriveNode("file:F9")).resolves.toMatchObject({ id: "file:F9", kind: "file" });
      await expect(picker().getDriveNode("doc:F9")).resolves.toMatchObject({ id: "doc:F9", kind: "file" });
      await expect(picker().getDriveNode("sheets:F9")).resolves.toBeNull();
    });

    it("finds nothing for a link to a node this account cannot see", async () => {
      const calls = stubDrive({});

      await expect(picker().listDriveNodes("drive", "https://drive.google.com/file/d/F0/view", null))
        .resolves.toEqual({ nodes: [] });
      expect(calls.map(url => url.pathname)).not.toContain("/drive/v3/files");
    });

    // A folder with limited access shows its name to a reader of a file inside it, but not its
    // children, so it can be shown on the path but not bound.
    it("finds a pre-filled file with the folders it lives in, and which of them it can list", async () => {
      const listable = { trashed: false, capabilities: { canListChildren: true } };
      stubDrive({
        "/files/F9": { id: "F9", name: "Q3.pdf", mimeType: "application/pdf", parents: ["A"] },
        "/files/A": {
          id: "A", name: "Archive", mimeType: FOLDER, parents: ["0AMyRoot"],
          trashed: false, capabilities: { canListChildren: false },
        },
        "/files/0AMyRoot": { id: "0AMyRoot", name: "My Drive", mimeType: FOLDER, ...listable },
        "/files/root": { id: "0AMyRoot", name: "My Drive", mimeType: FOLDER, ...listable },
      });

      await expect(picker().getDriveNode("file:F9")).resolves.toEqual({
        id: "file:F9", title: "Q3.pdf", kind: "file", mimeType: "application/pdf",
        path: [
          { id: "folder:0AMyRoot", title: "My Drive", listable: true },
          { id: "folder:A", title: "Archive", listable: false },
        ],
      });
    });

    it("places a pre-filled folder in its shared drive, without asking for My Drive", async () => {
      const calls = stubDrive({
        "/files/D2": {
          id: "D2", name: "Specs", mimeType: FOLDER, driveId: "0ADrive", parents: ["0ADrive"],
          capabilities: { canListChildren: true },
        },
        "/files/0ADrive": { id: "0ADrive", name: "Engineering", mimeType: FOLDER, driveId: "0ADrive" },
      });

      await expect(picker().getDriveNode("folder:D2")).resolves.toMatchObject({
        id: "folder:D2",
        path: [{ id: "shared-drives", title: "Shared drives" }, { id: "folder:0ADrive", title: "Engineering" }],
      });
      expect(calls.map(url => url.pathname)).not.toContain("/drive/v3/files/root");
    });

    // The walk costs a request per level, so it stops 20 folders up.
    it.each([
      ["shows the path of a node 20 folders down", 20, 20],
      ["leaves out the path of a node deeper than that", 21, undefined],
    ])("%s", async (_, depth, pathLength) => {
      const ids = Array.from({ length: depth }, (_, index) => `F${index}`);
      stubDrive({
        "/files/leaf": { id: "leaf", name: "Leaf.pdf", mimeType: "application/pdf", parents: [ids[0]] },
        ...Object.fromEntries(ids.map((id, index) => [`/files/${id}`, {
          id, name: id, mimeType: FOLDER, ...(index + 1 < depth ? { parents: [ids[index + 1]] } : {}),
        }])),
        "/files/root": { id: ids.at(-1), name: "My Drive", mimeType: FOLDER },
      });

      const node = await picker().getDriveNode("file:leaf");

      expect(node?.path?.length).toBe(pathLength);
    });

    // A partial path would show the node somewhere it is not.
    it("leaves out the path of a file shared from a folder this account cannot see", async () => {
      stubDrive({ "/files/S1": { id: "S1", name: "Shared", mimeType: "text/plain", parents: ["hidden"] } });

      const node = await picker().getDriveNode("file:S1");

      expect(node).toMatchObject({ id: "file:S1" });
      expect(node).not.toHaveProperty("path");
    });

    it("finds nothing for an id naming the wrong kind of node, or one this account cannot see", async () => {
      stubDrive({ "/files/D1": { id: "D1", name: "A folder", mimeType: FOLDER } });
      const browser = picker();

      await expect(browser.getDriveNode("file:D1")).resolves.toBeNull();
      await expect(browser.getDriveNode("folder:missing")).resolves.toBeNull();
      await expect(browser.getDriveNode("shared-drives")).resolves.toBeNull();
    });
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

/** The Drive picker's conversion calls, bound to one kind. */
type OfficeConfigurator = {
  inspectFile(fileId: string): Promise<OfficeFileInspection>;
  hasConversionAccess(): Promise<boolean>;
  convertFile(fileId: string, opts?: { reuse?: string }): Promise<OfficeConversionResult>;
};

type OfficeKindCase = {
  kind: "doc" | "sheets" | "slides";
  pattern: string;
  title: "Docs" | "Sheets" | "Slides";
  native: string;
  office: string;
  label: string;
  /** A second Office type of the kind, spelled as Drive spells it. */
  other: string;
};

const OFFICE_KIND_CASES: OfficeKindCase[] = [
  {
    kind: "sheets", pattern: GOOGLE_SHEETS_RESOURCE.urlPattern, title: "Sheets", native: GOOGLE_SHEET_MIME_TYPE,
    office: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "xlsx",
    other: "application/vnd.ms-excel.sheet.macroEnabled.12",
  },
  {
    kind: "doc", pattern: GOOGLE_DOC_RESOURCE.urlPattern, title: "Docs", native: GOOGLE_DOC_MIME_TYPE,
    office: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "docx", other: "application/msword",
  },
  {
    kind: "slides", pattern: GOOGLE_SLIDES_RESOURCE.urlPattern, title: "Slides", native: GOOGLE_SLIDES_MIME_TYPE,
    office: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    label: "pptx", other: "application/vnd.ms-powerpoint",
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
 * for the kind's type, reached through the RPC stub the iframe holds.
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
    inspectFile: async fileId => await stub.inspectFile(testCase.kind, fileId),
    hasConversionAccess: async () => await stub.hasConversionAccess(),
    convertFile: async (fileId, opts) => opts === undefined
      ? await stub.convertFile(testCase.kind, fileId) : await stub.convertFile(testCase.kind, fileId, opts),
  };
  return { ui, account, user, frame };
}

/**
 * The same configurator built directly rather than through the gatekeeper, for calls that reject:
 * workerd reports a rejection through a local RPC stub as uncaught even once it is handled.
 */
function directOfficeConfigurator(testCase: OfficeKindCase): OfficeConfigurator {
  let target = new DriveConfiguratorUI(async () => token("access-token"), async () => true);
  return {
    inspectFile: fileId => target.inspectFile(testCase.kind, fileId),
    hasConversionAccess: () => target.hasConversionAccess(),
    convertFile: (fileId, opts) => target.convertFile(testCase.kind, fileId, opts),
  };
}

const officeSource = (testCase: OfficeKindCase, overrides: Partial<FakeFile> = {}): FakeFile => ({
  id: "source-1", name: `Report.${testCase.label}`, mimeType: testCase.office,
  parents: ["folder-1"], modifiedTime: "2026-10-01T00:00:00.000Z", ...overrides,
});

describe.each(OFFICE_KIND_CASES)("the $title type's Office files", testCase => {
  it("are chosen in the Drive picker, which the type shares a card with", async () => {
    let { frame, user } = await startOfficeConfigurator(testCase);
    let drive = await user.startResourceConfigurator(GOOGLE_DRIVE_RESOURCE.urlPattern);

    expect(frame.iframeHtml).toBe(drive.iframeHtml);
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
    await expect(ui.inspectFile("source-1")).resolves.toEqual({ type: "office", canCopy: true });
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
