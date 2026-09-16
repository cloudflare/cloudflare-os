import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessTokenRequest } from "../../src/auth-retry";
import {
  BigQueryConfiguratorUI, CalendarConfiguratorUI, DriveFolderConfiguratorUI,
} from "../../src/google-configurators";
import type { GoogleAccessToken } from "../../src/google-api";

const token = (value: string): GoogleAccessToken => ({
  token: value,
  expires: new Date(Date.now() + 3600_000),
});

afterEach(() => vi.unstubAllGlobals());

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

  it("includes listable folders and shared-drive roots", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      files: [
        {
          id: "metadata-only", name: "Metadata only",
          capabilities: { canListChildren: false },
        },
        {
          id: "usable", name: "Usable",
          capabilities: { canListChildren: true },
        },
        {
          id: "drive-1", driveId: "drive-1", name: "Team Drive",
          capabilities: { canListChildren: true },
        },
      ],
    })));

    await expect(new DriveFolderConfiguratorUI(
      async () => token("access-token"), async () => true,
    ).listDriveFolders(""))
      .resolves.toEqual([
        { value: "usable", title: "Usable", subtitle: "My Drive" },
        { value: "drive-1", title: "Team Drive", subtitle: "In a shared drive" },
      ]);
  });

  it("refuses shared-drive discovery before optional consent", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const ui = new DriveFolderConfiguratorUI(
      async () => token("access-token"), async () => false,
    );

    await expect(ui.listSharedDrives("")).rejects.toThrow(
      "Enable Workspace Shared Drive discovery above, then try again.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists every shared-drive page after optional consent", async () => {
    const calls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      calls.push(url);
      return url.searchParams.has("pageToken")
        ? Response.json({ drives: [{ id: "drive-2", name: "Two" }] })
        : Response.json({
          drives: [{ id: "drive-1", name: "One" }], nextPageToken: "next",
        });
    }));
    const ui = new DriveFolderConfiguratorUI(
      async () => token("access-token"), async () => true,
    );

    await expect(ui.listSharedDrives("team")).resolves.toEqual([
      { value: "drive-1", title: "One", subtitle: "Workspace Shared Drive" },
      { value: "drive-2", title: "Two", subtitle: "Workspace Shared Drive" },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].searchParams.get("q")).toBe("name contains 'team'");
    expect(calls[1].searchParams.get("pageToken")).toBe("next");
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
