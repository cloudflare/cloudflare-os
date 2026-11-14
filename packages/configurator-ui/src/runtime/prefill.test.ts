import { describe, expect, it } from "vitest";
import type { ConfiguratorUISpec } from "../index.ts";
import { defaultValuesFromResourceUrl, prefill } from "./prefill.ts";

// The host decides to prefill with `matchesResourceUrlPattern`, which tries both slash forms, and
// the server mints the capability from a parser that also accepts both. Extraction sits between
// them, so a strict match here lands the caller on the right configurator with an empty field.
describe("defaultValuesFromResourceUrl", () => {
  const pattern = "https://drive.google.com/drive/folders/:folderId";

  it("extracts named groups with or without a trailing slash, before a query too", () => {
    for (const url of [
      "https://drive.google.com/drive/folders/FOLDER123",
      "https://drive.google.com/drive/folders/FOLDER123/",
      "https://drive.google.com/drive/folders/FOLDER123//",
      "https://drive.google.com/drive/folders/FOLDER123/?usp=sharing",
    ]) {
      expect(defaultValuesFromResourceUrl(url, pattern)).toEqual({ folderId: "FOLDER123" });
    }
  });

  it("decodes an encoded group and ignores a wildcard", () => {
    expect(defaultValuesFromResourceUrl(
      "https://docs.google.com/document/d/doc%2F1/edit",
      "https://docs.google.com/document/d/:docId/*",
    )).toEqual({ docId: "doc/1" });
  });

  it("returns nothing for a URL the pattern does not describe", () => {
    expect(defaultValuesFromResourceUrl("https://drive.google.com/drive/my-drive", pattern)).toEqual({});
  });
});

const spec = (overrides: Partial<ConfiguratorUISpec<null>> = {}): ConfiguratorUISpec<null> => ({
  initial: { folderId: null, mode: "read" },
  resourceUrl: () => "",
  render: () => null,
  ...overrides,
});

describe("prefill", () => {
  const initialResource = {
    resourceUrl: "https://drive.google.com/drive/folders/F1",
    resourceUrlPattern: "https://drive.google.com/drive/folders/:folderId",
  };
  const context = { ui: null };

  it("opens on the initial values with the resource's values on top, each shown as typed", async () => {
    expect(await prefill(spec(), context, async () => initialResource)).toEqual({
      values: { folderId: "F1", mode: "read" },
      queries: { folderId: "F1" },
    });
  });

  it("asks the spec to map the URL when it can", async () => {
    const mapped = spec({ initialValuesFromResourceUrl: async ({ resourceUrl }) => ({ mode: resourceUrl }) });
    expect((await prefill(mapped, context, async () => initialResource)).values)
      .toEqual({ folderId: null, mode: initialResource.resourceUrl });
  });

  it("opens blank when there is no resource or it cannot be read", async () => {
    const blank = { values: { folderId: null, mode: "read" }, queries: {} };
    expect(await prefill(spec(), context, async () => null)).toEqual(blank);
    expect(await prefill(spec(), context, () => Promise.reject(new Error("gone")))).toEqual(blank);
    const throwing = spec({ initialValuesFromResourceUrl: () => { throw new Error("unparseable"); } });
    expect(await prefill(throwing, context, async () => initialResource)).toEqual(blank);
  });
});
