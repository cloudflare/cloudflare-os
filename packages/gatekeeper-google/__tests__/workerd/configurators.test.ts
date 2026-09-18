import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessTokenRequest } from "../../src/auth-retry";
import {
  calendarPickerRank, hasCalendarPrivateAccessRole, hasCalendarWriteRole,
} from "../../src/calendar-api";
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
