import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { maybeJson, parseJson } from "./json.ts";

describe("parseJson", () => {
  // The engine's own message quotes the text, which a producer would then write into its artifact.
  it("names what was not JSON and quotes none of it", () => {
    assert.throws(() => parseJson("sk-live", "the registry's answer"),
      (error: Error) => error.message.includes("the registry's answer") && !error.message.includes("sk-live"));
    assert.deepEqual(parseJson('{"a":null}', "the registry's answer"), { a: null });
    assert.equal(parseJson("null", "the registry's answer"), null);
    assert.equal(maybeJson("sk-live"), undefined);
  });
});
