import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleSheetsApi, validateWrite } from "./sheets-api";

afterEach(() => vi.unstubAllGlobals());

describe("Google Sheets writes", () => {
  it("validates bounded rectangular update and append matrices", () => {
    expect(validateWrite("'Freshness'!A1:B2", [["URL", "Score"], ["/a", 10]], true))
      .toMatchObject({ cellCount: 4 });
    expect(validateWrite("'Freshness'!A1:B100", [["/a", 10]], false))
      .toMatchObject({ cellCount: 2 });
    expect(() => validateWrite("A1:B2", [[1, 2]], true)).toThrow(/exactly fill/);
    expect(() => validateWrite("A:B", [[1, 2]], false)).toThrow(/unbounded/);
    expect(() => validateWrite("A1:B2", [[1], [2, 3]], true)).toThrow(/rectangular/);
    expect(() => validateWrite("A1:A1", [["x".repeat(101 * 1024)]], true))
      .toThrow(/smaller approval actions/);
  });

  it("uses the official values update contract", async () => {
    let requests: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Response.json({ updatedCells: 4 });
    }));
    let api = new GoogleSheetsApi(async () => "token");
    await api.updateRange("sheet-1", "Data!A1:B2", [["a", "b"], [1, 2]], "userEntered");

    expect(requests).toHaveLength(1);
    let request = requests[0];
    expect(request.url).toContain("/sheet-1/values/Data!A1%3AB2");
    expect(request.url).toContain("valueInputOption=USER_ENTERED");
    expect(request.init?.method).toBe("PUT");
    expect(JSON.parse(String(request.init?.body))).toEqual({
      range: "Data!A1:B2",
      majorDimension: "ROWS",
      values: [["a", "b"], [1, 2]],
    });
  });

  it("uses the official values append contract and inserts rows", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      request = { url, init };
      return Response.json({ updates: { updatedCells: 2 } });
    }));
    let api = new GoogleSheetsApi(async () => "token");
    await api.appendRows("sheet-1", "Data!A1:B100", [["/new", 20]]);

    expect(request?.url).toContain("/sheet-1/values/Data!A1%3AB100:append");
    expect(request?.url).toContain("valueInputOption=RAW");
    expect(request?.url).toContain("insertDataOption=INSERT_ROWS");
    expect(request?.init?.method).toBe("POST");
  });
});
