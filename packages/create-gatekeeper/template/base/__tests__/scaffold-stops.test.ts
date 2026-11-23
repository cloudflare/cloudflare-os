/// <reference types="node" />

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// `pnpm create-gatekeeper` wrote this package with invented answers wherever only the provider's
// documentation can say. Each is marked `STOP(<id>)`. Replace what the mark is on, then delete the
// mark; delete this test once it passes. Deleting a mark alone rarely passes: the invented values
// that can be told from real ones are looked for too. A status classification or a cache lifetime
// cannot, so those marks are the only record that the decision is open. `/items` is looked for
// only where a path starts with it, as the invented ones do: a real API has it further in.
// The invented signature header is not named for the provider: many a real one is.
const INVENTED = /\bSTOP\(([a-z-]+)\)|\.example\b|(?:["`^]\\?|ORIGIN\})\/items\b|items\.read|items\.write|rename-items|X-Example-Signature/;

it("has no decision left as the scaffold wrote it", () => {
  const src = join(import.meta.dirname, "..", "src");
  const stops = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
// #if openapi
    // Generated from the provider's description, whose own words are not the scaffold's to judge.
    .filter(entry => !entry.parentPath.startsWith(join(src, "openapi")))
// #endif
    .flatMap(entry => {
      const path = join(entry.parentPath, entry.name);
      return readFileSync(path, "utf8").split("\n")
        .flatMap((line, index) => INVENTED.test(line) ? [`${path.slice(src.length + 1)}:${index + 1} ${line.trim()}`] : []);
    });
  expect(stops).toEqual([]);
});
