import { expect, it } from "vitest";
import configurator from "../src/configurator/acme-configurator-ui";
import { itemUrl, parseResourceUrl } from "../src/acme-urls";

// The configurator frame is compiled alone, so it holds a copy of the link grammar in
// src/acme-urls.ts. This keeps the copies in step: each reads the link a user pastes, and what the
// frame builds is what the server parses.
it("builds the link the server parses", () => {
  const pasted = `${itemUrl("abc-123")}/history`;
  const url = configurator.resourceUrl({ values: { itemUrl: pasted }, ui: undefined as never });
  expect(url).toBe(itemUrl("abc-123"));
  for (const link of [pasted, url]) expect(parseResourceUrl(link)).toEqual({ itemId: "abc-123" });
});
