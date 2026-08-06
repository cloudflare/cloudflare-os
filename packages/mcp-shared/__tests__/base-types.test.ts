import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { MCP_BASE_TYPES } from "../src/base-types.js";

describe("MCP_BASE_TYPES", () => {
  it("matches types.d.ts exactly", () => {
    // `base-types.ts` exists only because a Worker's Text module rule cannot resolve an import across
    // a package boundary. `types.d.ts` is the copy TypeScript actually checks, so if they diverge the
    // agents get a type surface nobody reviewed. Editing one and not the other fails here.
    const authoritative = readFileSync(join(import.meta.dirname, "../src/types.d.ts"), "utf8");
    expect(MCP_BASE_TYPES).toBe(authoritative);
  });
});
