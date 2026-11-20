// An operation that pages, batches or loops over requests runs in `googleUpstream.summed`: its
// requests are written as one point per kind once it settles, however many it makes.

import { afterEach, describe, expect, it, vi } from "vitest";
import { BigQueryApi } from "../src/bigquery-api";
import { GoogleCalendarApi } from "../src/calendar-api";
import { ChatApi } from "../src/chat-api";
import { describeConversation } from "../src/chat-names";
import { DriveApi } from "../src/drive-api";
import { driveThreads } from "../src/drive-comments";
import { readPermissions } from "../src/drive-sharing";
import { GmailApi } from "../src/google-api";
import { GoogleSlidesApi } from "../src/slides-api";
import { unbindWrittenCalls, writtenCalls } from "./written-calls";

const token = async () => "token";

// Stubs a fetch that answers `pages` requests in turn, each with `page` and all but the last with
// the token of a next page.
function paging(pages: number, page: object) {
  let answered = 0;
  vi.stubGlobal("fetch", async () =>
    Response.json({ ...page, ...(++answered < pages ? { nextPageToken: `page-${answered + 1}` } : {}) }));
}

describe("an operation that pages or batches", () => {
  afterEach(() => {
    unbindWrittenCalls();
    vi.unstubAllGlobals();
  });

  it.each([
    ["calendars", "google-calendar", "calendarList.list", { items: [] },
      () => new GoogleCalendarApi(token).listCalendars()],
    ["a calendar's events", "google-calendar", "events.list", { items: [] },
      () => new GoogleCalendarApi(token).listEvents("primary", { timeMin: new Date(0), timeMax: new Date(1) })],
    ["BigQuery projects", "google-bigquery", "projects.list", { projects: [] },
      () => new BigQueryApi(token).listProjects()],
    ["a project's datasets", "google-bigquery", "datasets.list", { datasets: [] },
      () => new BigQueryApi(token).listDatasets("project")],
    ["a dataset's tables", "google-bigquery", "tables.list", { tables: [] },
      () => new BigQueryApi(token).listTables("project", "dataset")],
    ["a conversation's members", "google-chat", "members.list", { memberships: [] },
      () => new ChatApi(token).audienceIn("spaces/AAAA")],
    ["a file's permissions", "google-drive", "permissions.list", { permissions: [] },
      () => readPermissions(new DriveApi(token), "file-1")],
    ["a comment's replies", "google-drive", "replies.list", { replies: [] },
      () => driveThreads({ api: new DriveApi(token), scope: () => ({ kind: "account" }) }).replies("file-1", "comment-1")],
    ["group chats matching some people", "google-chat", "spaces.findGroupChats", { spaces: [] },
      () => new ChatApi(token).findGroupChat(["users/1"])],
  ] as const)("writes the pages of %s as one point", async (_what, service, operation, page, list) => {
    let written = writtenCalls();
    paging(3, page);

    await list();

    expect(written()).toEqual([[service, operation, "success", 200, 3]]);
  });

  it("writes the pages of drafts searched for a pending one as one point", async () => {
    let written = writtenCalls();
    let pages = 0;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      let { pathname } = new URL(input);
      // The message the draft would hold is found, and no draft of three pages holds it.
      if (pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "abc123", threadId: "def456" }] });
      if (pathname.endsWith("/messages/abc123")) {
        return Response.json({ id: "abc123", payload: { headers: [{ name: "Message-ID", value: "<draft@example.com>" }] } });
      }
      return Response.json({
        drafts: [{ id: `draft${pages}`, message: { id: "other", threadId: "def456" } }],
        ...(++pages < 3 ? { nextPageToken: `page-${pages + 1}` } : {}),
      });
    });

    expect(await new GmailApi("me@example.com", token).findDraftByRfcMessageId("<draft@example.com>")).toBeUndefined();

    expect(written.of("drafts.list")).toEqual([["google-gmail", "drafts.list", "success", 200, 3]]);
  });

  it("writes the reads of a deck's slides as one point", async () => {
    let written = writtenCalls();
    vi.stubGlobal("fetch", async (url: string | URL) =>
      Response.json({ objectId: new URL(url).pathname.split("/").at(-1) }));

    let slides = await new GoogleSlidesApi(token).getSlides("deck-1", ["slide-1", "slide-2"], ["slide-1", "slide-2"]);

    expect([...slides.keys()]).toEqual(["slide-1", "slide-2"]);
    expect(written()).toEqual([["google-slides", "pages.get", "success", 200, 2]]);
  });

  it("writes the batches a read of many Drive files is sent in as one point", async () => {
    let written = writtenCalls();
    // Every file of a batch is answered as one this account cannot see.
    vi.stubGlobal("fetch", async (_url: string | URL, init: RequestInit = {}) => {
      let parts = [...String(init.body).matchAll(/^GET \/drive\/v3\/files\//gm)].map((_file, index) => [
        "--batch", "Content-Type: application/http", `Content-ID: <response-item-${index}>`, "",
        "HTTP/1.1 404 Not Found", "Content-Type: application/json", "", "{}",
      ].join("\r\n"));
      return new Response(`${parts.join("\r\n")}\r\n--batch--\r\n`,
        { headers: { "Content-Type": "multipart/mixed; boundary=batch" } });
    });
    let fileIds = Array.from({ length: 101 }, (_file, index) => `file-${index}`);

    let nodes = await new DriveApi(token).getScopeNodes(fileIds);

    expect(nodes).toEqual(fileIds.map(() => undefined));
    expect(written()).toEqual([["google-drive", "files.get.batch", "success", 200, 2]]);
  });

  it("writes the polls of a BigQuery query as one point, beside the query", async () => {
    let written = writtenCalls();
    let job = { jobReference: { projectId: "project", jobId: "job-1" } };
    let polls = 0;
    vi.stubGlobal("fetch", async (_url: string | URL, init: RequestInit = {}) =>
      Response.json({ ...job, jobComplete: init.method === "GET" && ++polls === 2 }));

    await new BigQueryApi(token).query("project", "SELECT 1");

    expect(written()).toEqual([
      ["google-bigquery", "queries.create", "success", 200, 1],
      ["google-bigquery", "queries.get", "success", 200, 2],
    ]);
  });

  it("writes the pages of members a conversation is named from as one point", async () => {
    let written = writtenCalls();
    paging(2, { memberships: [] });

    await describeConversation(
      new ChatApi(token), { id: "spaces/AAAA", type: "directMessage", supportsThreads: false }, "users/1");

    expect(written.of("members.list")).toEqual([["google-chat", "members.list", "success", 200, 2]]);
  });

  it("writes a request made outside such an operation at once, one point each", async () => {
    let written = writtenCalls();
    paging(1, {});
    let chat = new ChatApi(token);

    // The answer names no space, so each read is thrown, and counted, as the failure it is.
    await chat.getSpace("spaces/AAAA").catch(() => {});
    await chat.getSpace("spaces/AAAA").catch(() => {});

    expect(written()).toEqual([
      ["google-chat", "spaces.get", "error", 200, 1], ["google-chat", "spaces.get", "error", 200, 1],
    ]);
  });
});
