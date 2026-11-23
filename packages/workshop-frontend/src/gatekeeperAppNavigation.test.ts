import { describe, expect, it } from "vitest";
import {
  MAX_GATEKEEPER_APP_PATH_LENGTH,
  MAX_GATEKEEPER_APP_PROMPT_LENGTH,
  normalizeGatekeeperAppPrompt,
  parseGatekeeperAppPath,
  parseGatekeeperAppWorkspaceTarget,
} from "./gatekeeperAppNavigation";

const WORKSPACE_ID = "a".repeat(64);

describe("parseGatekeeperAppWorkspaceTarget", () => {
  it("accepts a workspace ID with an optional gadget", () => {
    expect(parseGatekeeperAppWorkspaceTarget(WORKSPACE_ID, undefined)).toEqual({
      workspaceId: WORKSPACE_ID,
    });
    expect(parseGatekeeperAppWorkspaceTarget(WORKSPACE_ID, 0)).toEqual({
      workspaceId: WORKSPACE_ID,
      gadgetId: 0,
    });
  });

  it.each([
    ["", undefined],
    ["../admin", undefined],
    [WORKSPACE_ID.toUpperCase(), undefined],
    [`${WORKSPACE_ID}a`, undefined],
    [WORKSPACE_ID, -1],
    [WORKSPACE_ID, 1.5],
    [WORKSPACE_ID, 9_007_199_254_740_992],
    [WORKSPACE_ID, "1"],
  ])("rejects (%s, %s)", (workspaceId, gadgetId) => {
    expect(() => parseGatekeeperAppWorkspaceTarget(workspaceId, gadgetId)).toThrow(
      "Invalid gatekeeper app workspace target",
    );
  });
});

describe("normalizeGatekeeperAppPrompt", () => {
  it("trims a bounded visible prompt", () => {
    expect(normalizeGatekeeperAppPrompt("  Set up a daily brief.  ")).toBe("Set up a daily brief.");
  });

  it("rejects empty and oversized prompts", () => {
    expect(() => normalizeGatekeeperAppPrompt("   ")).toThrow("cannot be empty");
    expect(() =>
      normalizeGatekeeperAppPrompt("x".repeat(MAX_GATEKEEPER_APP_PROMPT_LENGTH + 1)),
    ).toThrow("too long");
  });
});

describe("parseGatekeeperAppPath", () => {
  it.each([
    "/",
    "/collections/c1",
    "/collections/c1/files/guides/a b#?%.md",
    `/${"x".repeat(MAX_GATEKEEPER_APP_PATH_LENGTH - 1)}`,
  ])("accepts %s", (path) => {
    expect(parseGatekeeperAppPath(path)).toBe(path);
  });

  it.each([
    "",
    "collections",
    "//",
    "/a//b",
    "/a/",
    "/a/./b",
    "/a/../b",
    "/a\u0000b",
    "/a\u007fb",
    42,
    undefined,
  ])("rejects %j", (path) => {
    expect(() => parseGatekeeperAppPath(path)).toThrow("Invalid gatekeeper app path");
  });

  it("rejects a path over the length limit", () => {
    expect(() => parseGatekeeperAppPath(`/${"x".repeat(MAX_GATEKEEPER_APP_PATH_LENGTH)}`))
      .toThrow("too long");
  });
});
