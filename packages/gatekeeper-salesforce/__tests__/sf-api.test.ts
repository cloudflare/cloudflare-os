import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModifiedWhere,
  cursorFromRecords,
  formatSyncCursor,
  parseSyncCursor,
  resolveSfUrl,
  SalesforceClient,
  type SalesforceAccessToken,
} from "../src/sf-api.js";
import type { SfRecord } from "../src/salesforce-types.js";

const seedToken: SalesforceAccessToken = {
  accessToken: "token",
  instanceUrl: "https://example.my.salesforce.com",
  apiVersion: "v60.0",
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
};

const auth = {
  clientId: "client",
  username: "user@example.com",
  privateKeyPem: "-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----",
  loginUrl: "https://login.salesforce.com",
};

describe("resolveSfUrl", () => {
  it("joins nextRecordsUrl absolute paths without double-prefixing the API version", () => {
    const next = "/services/data/v60.0/query/01gXX-2000";
    expect(resolveSfUrl("https://example.my.salesforce.com", "v60.0", next)).toBe(
      "https://example.my.salesforce.com/services/data/v60.0/query/01gXX-2000",
    );
  });

  it("prefixes relative query paths with services/data/{version}", () => {
    expect(resolveSfUrl("https://example.my.salesforce.com/", "v60.0", "/query?q=SELECT")).toBe(
      "https://example.my.salesforce.com/services/data/v60.0/query?q=SELECT",
    );
  });

  it("passes through absolute http(s) URLs", () => {
    const full = "https://example.my.salesforce.com/services/data/v60.0/query/01gXX";
    expect(resolveSfUrl("https://other.salesforce.com", "v60.0", full)).toBe(full);
  });
});

describe("sync cursor helpers", () => {
  it("parses and formats composite cursors", () => {
    expect(parseSyncCursor(null)).toBeNull();
    expect(parseSyncCursor("2026-08-01T10:00:00.000Z")).toEqual({
      modstamp: "2026-08-01T10:00:00.000Z",
    });
    expect(parseSyncCursor("2026-08-01T10:00:00.000Z|001xx000000ABC")).toEqual({
      modstamp: "2026-08-01T10:00:00.000Z",
      id: "001xx000000ABC",
    });
    expect(formatSyncCursor("2026-08-01T10:00:00.000Z", "001xx000000ABC")).toBe(
      "2026-08-01T10:00:00.000Z|001xx000000ABC",
    );
  });

  it("builds a tie-safe WHERE clause", () => {
    expect(buildModifiedWhere(null)).toBeUndefined();
    expect(buildModifiedWhere({ modstamp: "2026-08-01T10:00:00.000Z" })).toBe(
      "SystemModstamp >= 2026-08-01T10:00:00.000Z",
    );
    expect(
      buildModifiedWhere({ modstamp: "2026-08-01T10:00:00.000Z", id: "001xx000000ABC" }),
    ).toBe(
      "(SystemModstamp > 2026-08-01T10:00:00.000Z OR " +
        "(SystemModstamp = 2026-08-01T10:00:00.000Z AND Id > '001xx000000ABC'))",
    );
  });

  it("advances the cursor from the last ordered record", () => {
    const records: SfRecord[] = [
      { Id: "001aa", SystemModstamp: "2026-08-01T10:00:00.000Z" },
      { Id: "001bb", SystemModstamp: "2026-08-01T10:00:00.000Z" },
    ];
    expect(cursorFromRecords(records)).toEqual({
      modstamp: "2026-08-01T10:00:00.000Z",
      id: "001bb",
    });
    expect(cursorFromRecords([], { modstamp: "x", id: "y" })).toEqual({
      modstamp: "x",
      id: "y",
    });
  });
});

describe("SalesforceClient pagination + getDeleted", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("paginates without a SOQL LIMIT that caps the total result set", async () => {
    const soqls: string[] = [];
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/query?q=")) {
          const q = decodeURIComponent(url.split("q=")[1] ?? "");
          soqls.push(q);
          expect(q).not.toMatch(/\bLIMIT\b/i);
          return new Response(
            JSON.stringify({
              done: false,
              totalSize: 3,
              records: [
                { Id: "001aa0000000001", SystemModstamp: "2026-08-01T10:00:00.000Z" },
                { Id: "001aa0000000002", SystemModstamp: "2026-08-01T10:00:01.000Z" },
              ],
              nextRecordsUrl: "/services/data/v60.0/query/01gXX-2000",
            }),
            { status: 200 },
          );
        }
        if (url.includes("/services/data/v60.0/query/01gXX-2000")) {
          expect(url).toBe(
            "https://example.my.salesforce.com/services/data/v60.0/query/01gXX-2000",
          );
          expect(url).not.toContain("/services/data/v60.0/services/data/");
          return new Response(
            JSON.stringify({
              done: true,
              records: [{ Id: "001aa0000000003", SystemModstamp: "2026-08-01T10:00:02.000Z" }],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const client = new SalesforceClient(auth, 200, seedToken);
    const { records, truncated } = await client.queryAll("Id, SystemModstamp", "Account");
    expect(truncated).toBe(false);
    expect(records).toHaveLength(3);
    expect(soqls[0]).toContain("ORDER BY SystemModstamp ASC");
    expect(soqls[0]).not.toMatch(/\bLIMIT\b/i);
    expect(urls.some((u) => u.includes("/services/data/v60.0/query/01gXX-2000"))).toBe(true);
  });

  it("getDeleted returns IDs for the recycle-bin window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        expect(url).toContain("/sobjects/Account/deleted/");
        expect(url).toContain("start=");
        expect(url).toContain("end=");
        return new Response(
          JSON.stringify({
            deletedRecords: [
              { id: "001del000000001", deletedDate: "2026-08-02T12:00:00.000+0000" },
            ],
            latestDateCovered: "2026-08-02T12:00:00.000+0000",
          }),
          { status: 200 },
        );
      }),
    );

    const client = new SalesforceClient(auth, 200, seedToken);
    const deleted = await client.getDeleted(
      "Account",
      "2026-08-01T00:00:00.000Z",
      "2026-08-03T00:00:00.000Z",
    );
    expect(deleted).toEqual([
      { id: "001del000000001", deletedDate: "2026-08-02T12:00:00.000+0000" },
    ]);
  });
});
