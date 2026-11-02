// The configurator frame is compiled on its own and can't import the gatekeeper, so it holds
// copies of the resource types' URL patterns. This keeps the copies, and the frame tests' host,
// equal to the patterns the gatekeeper declares.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_PATTERNS } from "./frame-host";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const declared = [...source("confluence.ts").matchAll(/urlPattern: "([^"]+)"/g)].map(match => match[1]);
const copied = [...source("configurator/confluence-configurator-ui.tsx").matchAll(/^const (?:SITE|SPACE|PAGE)_PATTERN = "([^"]+)";$/gm)].map(match => match[1]);

describe("the frame's copies of the resource URL patterns", () => {
  it("are the gatekeeper's", () => {
    expect(declared).toHaveLength(3);
    expect(copied).toEqual(declared);
    expect(ALL_PATTERNS).toEqual(declared);
  });
});
