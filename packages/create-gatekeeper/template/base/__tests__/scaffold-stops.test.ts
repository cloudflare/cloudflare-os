/// <reference types="node" />

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// `pnpm create-gatekeeper` wrote this package with invented answers wherever only the provider's
// documentation can say. Each is marked `STOP(<id>)`. Replace what the mark is on, then delete the
// mark; delete this test once it passes. Deleting a mark alone doesn't pass: the invented values
// are looked for too.
const INVENTED = /\bSTOP\(([a-z-]+)\)|\.example\b|items\.read|items\.write|rename-items|X-Acme-Signature/;

it("has no decision left as the scaffold wrote it", () => {
  const src = join(import.meta.dirname, "..", "src");
  const stops = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .flatMap(entry => {
      const path = join(entry.parentPath, entry.name);
      return readFileSync(path, "utf8").split("\n")
        .flatMap((line, index) => INVENTED.test(line) ? [`${path.slice(src.length + 1)}:${index + 1} ${line.trim()}`] : []);
    });
  expect(stops).toEqual([]);
});
