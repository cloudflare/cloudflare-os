import { env } from "cloudflare:workers";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { subserviceTally, type SubserviceCallInput } from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_API_SOURCE, googleService, recordCall, summedInto } from "../src/call-metrics";

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src");

const CALL: SubserviceCallInput = {
  source: GOOGLE_API_SOURCE, service: "google-drive", operation: "GET", outcome: "success",
  httpStatus: 200,
};

// Makes a call after an await, as a client deep in the work does.
async function later(operation: string): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 1));
  recordCall({ ...CALL, operation });
}

describe("googleService", () => {
  // The base URL each client builds its requests on, as the file that holds it writes it.
  it.each([
    ["google-api.ts", "https://gmail.googleapis.com/gmail/v1/users/me/", "google-gmail"],
    ["google-api.ts", "https://www.googleapis.com/oauth2/v3/userinfo", "google-oauth"],
    ["google-api.ts", "https://oauth2.googleapis.com/token", "google-oauth"],
    ["google-api.ts", "https://oauth2.googleapis.com/revoke", "google-oauth"],
    ["drive-api.ts", "https://www.googleapis.com/drive/v3", "google-drive"],
    ["drive-api.ts", "https://www.googleapis.com/batch/drive/v3", "google-drive"],
    ["calendar-api.ts", "https://www.googleapis.com/calendar/v3", "google-calendar"],
    ["docs-api.ts", "https://docs.googleapis.com/v1/documents", "google-docs"],
    ["sheets-api.ts", "https://sheets.googleapis.com/v4/spreadsheets", "google-sheets"],
    ["slides-api.ts", "https://slides.googleapis.com/v1/presentations", "google-slides"],
    ["chat-api.ts", "https://chat.googleapis.com/v1", "google-chat"],
    ["chat-api.ts", "https://people.googleapis.com/v1", "google-people"],
    ["bigquery-api.ts", "https://bigquery.googleapis.com/bigquery/v2", "google-bigquery"],
    ["chat-hooks.ts", "https://workspaceevents.googleapis.com/v1", "google-events"],
  ])("%s: %s is %s", (file, base, service) => {
    expect(readFileSync(join(SOURCE_DIR, file), "utf8")).toContain(base);
    expect(googleService(base)).toBe(service);
    expect(googleService(`${base}/1aBcD:batchUpdate?fields=id&q=name`)).toBe(service);
  });

  it("names Drive's upload endpoint, one segment down like its batch endpoint", () => {
    expect(googleService("https://www.googleapis.com/upload/drive/v3/files?uploadType=media"))
        .toBe("google-drive");
  });

  it.each([
    "https://lh3.googleusercontent.com/a/thumbnail",
    "https://www.googleapis.com/storage/v1/b",
    "https://www.googleapis.com/batch",
    "https://www.googleapis.com/",
    "https://www.googleapis.com/constructor/v1",
    "https://gmail.googleapis.com.example.com/gmail/v1/users/me/profile",
    "https://example.com/drive/v3/files",
    "/drive/v3/files",
    "",
  ])("%j is google-other", url => {
    expect(googleService(url)).toBe("google-other");
  });
});

describe("recordCall", () => {
  let ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
  let points: AnalyticsEngineDataPoint[];
  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => { points.push(point!); } };
    ambient.SUBSERVICE_METRICS = "true";
  });
  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
  });

  // The `calls` column of each point written, beside its operation.
  function written(): [unknown, unknown][] {
    return points.map(point => [point.blobs![9], point.doubles![4]]);
  }

  it("writes a call at once outside `summedInto`", () => {
    recordCall(CALL);
    expect(written()).toEqual([["GET", 1]]);
  });

  it("sums the calls made in `summedInto`, across an await and in a nested call", async () => {
    let tally = subserviceTally();
    let answer = await summedInto(tally, async () => {
      recordCall(CALL);
      await later("GET");
      await Promise.all([later("GET"), later("POST")]);
      return "answer";
    });
    expect(answer).toBe("answer");
    expect(written()).toEqual([]);

    tally.flush();
    expect(written()).toEqual([["GET", 3], ["POST", 1]]);
  });

  it("keeps apart the calls of two tallies at once, and of work under neither", async () => {
    let first = subserviceTally();
    let second = subserviceTally();
    await Promise.all([
      summedInto(first, () => later("GET")),
      summedInto(second, async () => { await later("POST"); await later("POST"); }),
      later("DELETE"),
    ]);
    expect(written()).toEqual([["DELETE", 1]]);

    first.flush();
    second.flush();
    expect(written()).toEqual([["DELETE", 1], ["GET", 1], ["POST", 2]]);
  });
});
