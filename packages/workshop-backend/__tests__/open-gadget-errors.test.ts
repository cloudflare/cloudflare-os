import { describe, expect, it } from "vite-plus/test";
import {
  createOpenGadgetError,
  getOpenGadgetErrorCode,
  OPEN_GADGET_ERROR_CODES,
} from "@gadgets/workshop-shared/api";

describe("open gadget errors", () => {
  it.each([
    [OPEN_GADGET_ERROR_CODES.workspaceNotFound, "Workspace not found."],
    [OPEN_GADGET_ERROR_CODES.workspaceAccessDenied, "You don't have access to this workspace."],
  ] as const)(
    "creates an enumerable %s code with a readable message",
    (code, message) => {
      let error = createOpenGadgetError(code);

      expect(error.message).toBe(message);
      expect(error.code).toBe(code);
      expect(Object.keys(error)).toContain("code");
      expect(getOpenGadgetErrorCode(error)).toBe(code);
    },
  );

  it.each(Object.values(OPEN_GADGET_ERROR_CODES))(
    "does not infer %s from an error message",
    (code) => {
      expect(getOpenGadgetErrorCode(new Error(code))).toBeUndefined();
    },
  );

  it("does not classify unexpected errors", () => {
    expect(getOpenGadgetErrorCode(new Error("storage unavailable"))).toBeUndefined();
    expect(getOpenGadgetErrorCode({ code: "UNKNOWN" })).toBeUndefined();
  });
});
