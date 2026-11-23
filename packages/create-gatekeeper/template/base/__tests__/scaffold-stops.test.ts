/// <reference types="node" />

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// `pnpm create-gatekeeper` wrote this package with invented answers wherever only the provider's
// documentation can say. Each is marked `STOP(<id>)`. Replace what the mark is on, then delete the
// mark; delete this test once it passes. Deleting a mark alone rarely passes: the invented values
// that can be told from real ones are looked for too. A status classification or a cache lifetime
// cannot, so those marks are the only record that the decision is open. `/items` is looked for
// only where a path starts with it, as the invented ones do: a real API has it further in.
// The invented signature header is not named for the provider: many a real one is.
const STOP = /\bSTOP\([a-z-]+\)/;
const INVENTED = /\.example\b|(?:["`^]\\?|ORIGIN\})\/items\b|items\.read|items\.write|rename-items|X-Example-Signature/;

it("has no decision left as the scaffold wrote it", () => {
  const root = join(import.meta.dirname, "..");
  const src = join(root, "src");
  const sources = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(ts|tsx|svg)$/.test(entry.name))
// #if openapi
    // Generated from the provider's description, whose own words are not the scaffold's to judge.
    .filter(entry => !entry.parentPath.startsWith(join(src, "openapi")))
// #endif
    .map(entry => join(entry.parentPath, entry.name));
  // What an operator and a reader see of the package is the scaffold's too, until it is rewritten.
  // Only its marks are looked for there: setup steps may well name a host at `.example`. A package
  // that needs no deploy inputs has no file of them.
  const files = [...sources, join(root, "README.md"), join(root, "deploy-inputs.json")].filter(path => existsSync(path));
  const stops = files.flatMap(path => readFileSync(path, "utf8").split("\n").flatMap((line, index) =>
    STOP.test(line) || /\.tsx?$/.test(path) && INVENTED.test(line) ? [`${path.slice(root.length + 1)}:${index + 1} ${line.trim()}`] : []));
  expect(stops).toEqual([]);
});
