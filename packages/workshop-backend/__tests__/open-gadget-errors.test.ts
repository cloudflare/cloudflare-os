import { describe, expect, it } from "vitest";
import { deserialize, serialize } from "capnweb";
import {
  createOpenGadgetError,
  getOpenGadgetErrorCode,
  OPEN_GADGET_ERROR_CODES,
} from "@gadgets/workshop-shared/api";

describe("open gadget errors", () => {
  it("classifies a serialized code independently of its message", () => {
    const error = createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
    error.message = "Workspace access changed.";

    const received = deserialize(serialize(error)) as Error;

    expect(getOpenGadgetErrorCode(received)).toBe(
      OPEN_GADGET_ERROR_CODES.workspaceAccessDenied,
    );
  });

  it("does not infer a known code from its default message", () => {
    expect(
      getOpenGadgetErrorCode(new Error("You don't have access to this workspace.")),
    ).toBeUndefined();
  });

  it("does not classify unexpected errors", () => {
    expect(getOpenGadgetErrorCode(new Error("storage unavailable"))).toBeUndefined();
    expect(getOpenGadgetErrorCode({ code: "UNKNOWN" })).toBeUndefined();
  });
});
