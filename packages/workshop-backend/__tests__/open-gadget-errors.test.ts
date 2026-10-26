import { describe, expect, it } from "vitest";
import {
  createOpenWorkspaceError,
  getOpenWorkspaceErrorCode,
  OPEN_WORKSPACE_ERROR_CODES,
} from "@gadgets/workshop-shared/api";

describe("open gadget errors", () => {
  it.each([
    [OPEN_WORKSPACE_ERROR_CODES.workspaceNotFound, "Workspace not found."],
    [OPEN_WORKSPACE_ERROR_CODES.workspaceAccessDenied, "You don't have access to this workspace."],
    [
      OPEN_WORKSPACE_ERROR_CODES.shareLinksDisabled,
      "Share links are disabled for this workspace because it contains sensitive data. " +
          "The owner must add each person directly.",
    ],
  ] as const)(
    "creates an enumerable %s code with a readable message",
    (code, message) => {
      let error = createOpenWorkspaceError(code);

      expect(error.message).toBe(message);
      expect(error.code).toBe(code);
      expect(Object.keys(error)).toContain("code");
      expect(getOpenWorkspaceErrorCode(error)).toBe(code);
    },
  );

  it.each(Object.values(OPEN_WORKSPACE_ERROR_CODES))(
    "does not infer %s from an error message",
    (code) => {
      expect(getOpenWorkspaceErrorCode(new Error(code))).toBeUndefined();
    },
  );

  it("does not classify unexpected errors", () => {
    expect(getOpenWorkspaceErrorCode(new Error("storage unavailable"))).toBeUndefined();
    expect(getOpenWorkspaceErrorCode({ code: "UNKNOWN" })).toBeUndefined();
  });
});
