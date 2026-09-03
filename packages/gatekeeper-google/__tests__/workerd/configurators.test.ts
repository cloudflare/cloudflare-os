import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessTokenRequest } from "../../src/auth-retry";
import { BigQueryConfiguratorUI, CalendarConfiguratorUI } from "../../src/google-configurators";
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
