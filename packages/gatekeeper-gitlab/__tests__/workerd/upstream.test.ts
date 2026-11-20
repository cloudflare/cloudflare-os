// The points written for what the Durable Objects send to GitLab: an operation that walks a
// listing page after page writes its requests as one sum, the account's token refresh is counted
// under its own name, and a job's log is counted by how the binding's reading of it ends. The
// metrics read the Worker's bindings from `cloudflare:workers`, whose `env` this suite shares with
// the Durable Objects, so a dataset set on it here records what they write.

import { env as bindings } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import * as fx from "../fixtures/gitlab-docs.js";
import { FakeGitLab, hooks, json, projectProps, seedAccount, tokenResponse, unwrap } from "./fake-gitlab.js";

const ambient = bindings as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
let points: AnalyticsEngineDataPoint[];

beforeEach(() => {
  points = [];
  ambient.METRICS = { writeDataPoint: point => { if (point) points.push(point); } };
  ambient.SUBSERVICE_METRICS = "true";
});

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
  vi.unstubAllGlobals();
});

// A written point's value in one column.
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// The points written since the last look for the operation `name`, as each one's source, service,
// outcome, HTTP status and how many calls it stands for.
function written(name: string) {
  return points.splice(0)
    .filter(point => column(point, SUBSERVICE_V1_SLOTS.operation) === name)
    .map(point => [
      SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, COMMON_SLOTS.outcome,
      SUBSERVICE_V1_SLOTS.httpStatus, SUBSERVICE_V1_SLOTS.calls,
    ].map(slot => column(point, slot)));
}

const PROJECT = "group/sub/project";
/** The project's path, which the binding reads only to pin its id. */
const PATH = "group%2Fsub%2Fproject";
/** Where the binding reads the project once pinned: by its id. */
const P = String(fx.projectResponse.data.id);

/** A listing of two one-row pages, linked by `x-next-page` as GitLab links them. */
function twoPages(first: unknown, second: unknown) {
  return (request: { url: URL }) => request.url.searchParams.get("page") === "1"
    ? json([first], { headers: { "x-next-page": "2" } })
    : json([second], { headers: { "x-next-page": "" } });
}

function fakeProject(): FakeGitLab {
  const gitlab = new FakeGitLab();
  gitlab.on("GET", new RegExp(`^/api/v4/projects/(?:${PATH}|${P})$`), () => json({
    ...fx.projectResponse.data, path_with_namespace: PROJECT, web_url: `https://gitlab.example.com/${PROJECT}`,
  }));
  gitlab.on("GET", /^\/api\/v4\/user$/, () => json(fx.currentUserResponse.data));
  return gitlab;
}

describe("the points of an operation that walks a listing", () => {
  it("writes the pages of a discussion's walk as one point", async () => {
    const gitlab = fakeProject();
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues/1$`), () => json(fx.issueResponse.data));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues/1/discussions`),
      twoPages(fx.issueDiscussionsResponse.data[0], fx.issueDiscussionsResponse.data[1]));
    gitlab.install();
    const props = projectProps(await seedAccount(), PROJECT);

    await unwrap(await hooks().discussionAll("summed-discussion", props, "issue", "1", 50));

    expect(gitlab.count("GET", /issues\/1\/discussions/)).toBe(2);
    expect(written("discussions.list")).toEqual([["gatekeeper.gitlab.api", "gitlab", "success", 200, 2]]);
  });

  it("writes the remote pages one cursor page reads as one point", async () => {
    const gitlab = fakeProject();
    const second = { ...fx.issueResponse.data, id: 2, iid: 2, created_at: "2016-01-04T15:31:51.081Z" };
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues\\?`), twoPages(fx.issueResponse.data, second));
    gitlab.install();
    const props = projectProps(await seedAccount(), PROJECT);

    expect(await unwrap(await hooks().listIssuesAll("summed-cursor", props, 20))).toHaveLength(2);

    expect(gitlab.count("GET", new RegExp(`^/api/v4/projects/${P}/issues\\?`))).toBe(2);
    expect(written("issues.list")).toEqual([["gatekeeper.gitlab.api", "gitlab", "success", 200, 2]]);
  });
});

describe("the points of the account's token requests", () => {
  it("counts the refresh of an expired grant under its own name", async () => {
    const gitlab = new FakeGitLab();
    gitlab.on("POST", /^\/oauth\/token/, () => json(tokenResponse(1)));
    gitlab.install();
    const id = await seedAccount({ expiresInMs: 0 });

    expect(await unwrap(await hooks().accountToken(id))).toBe("access-1");

    expect(gitlab.count("POST", /^\/oauth\/token/)).toBe(1);
    expect(written("token.refresh")).toEqual([["gatekeeper.gitlab.api", "gitlab", "success", 200, 1]]);
  });
});

describe("the point of a job's log", () => {
  it("counts a log whose transfer is cut off part-way as no success, fails the read as its reader does, and reads the log anew when asked again", async () => {
    const gitlab = fakeProject();
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/jobs/8$`), () => json({ ...fx.jobResponse.data, id: 8, status: "success" }));
    let cut = true;
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/jobs/8/trace$`), () => cut
      // A line of the log, and then the failure of its transfer.
      ? new Response(new ReadableStream<Uint8Array>({
        start: controller => controller.enqueue(new TextEncoder().encode("line 1\n")),
        pull: controller => controller.error(new TypeError("connection lost")),
      }))
      : new Response("line 1\nline 2\n"));
    gitlab.install();
    const props = projectProps(await seedAccount(), PROJECT);
    const readLog = [{ method: "getJob", args: ["8"] }, { method: "readLog" }];

    expect(await hooks().session("log-point", props, readLog)).toEqual({ error: "connection lost" });
    expect(gitlab.count("GET", /jobs\/8\/trace$/)).toBe(1);
    expect(written("jobs.trace")).toEqual([["gatekeeper.gitlab.api", "gitlab", "error", 200, 1]]);

    cut = false;
    expect(await unwrap(await hooks().session("log-point", props, readLog))).toMatchObject({
      lines: [{ number: 1, text: "line 1" }, { number: 2, text: "line 2" }], totalLines: 2, complete: true,
    });
    expect(gitlab.count("GET", /jobs\/8\/trace$/)).toBe(2);
    expect(written("jobs.trace")).toEqual([["gatekeeper.gitlab.api", "gitlab", "success", 200, 1]]);
  });
});
