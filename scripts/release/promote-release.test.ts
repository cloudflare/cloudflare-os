// The promote guard's pure logic (scripts/release/promote-release.ts): which release ids are
// order-comparable, and when an already-published release supersedes the candidate. The R2
// round trip itself is exercised by the deploy e2e pipeline, not here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ciRunNumber, supersededBy } from "./promote-release.ts";

test("ciRunNumber parses CI ids and rejects everything else", () => {
  assert.equal(ciRunNumber("r000123-abc1234"), 123);
  assert.equal(ciRunNumber("r1-abc1234"), 1);
  assert.equal(ciRunNumber("dev-mdxk3f2a"), null);
  assert.equal(ciRunNumber("release-42"), null);
  assert.equal(ciRunNumber("r-abc1234"), null);
});

test("a higher published run number supersedes the candidate", () => {
  assert.equal(
    supersededBy("r000123-abc1234", ["r000122-aaaaaaa", "r000124-bbbbbbb"]),
    "r000124-bbbbbbb");
});

test("equal or lower run numbers do not supersede", () => {
  assert.equal(supersededBy("r000123-abc1234", ["r000123-abc1234", "r000122-aaaaaaa"]), null);
  assert.equal(supersededBy("r000123-abc1234", []), null);
});

test("non-CI ids never participate in ordering, on either side", () => {
  // dev releases carry no ordering claim relative to CI candidates...
  assert.equal(supersededBy("r000123-abc1234", ["dev-zzzzzzzz"]), null);
  // ...and a dev candidate is never superseded (nothing is comparable to it).
  assert.equal(supersededBy("dev-mdxk3f2a", ["r999999-abc1234"]), null);
});
