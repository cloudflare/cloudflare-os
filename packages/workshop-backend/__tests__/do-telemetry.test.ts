import { describe, expect, it } from "vitest";
import { isDoResetError } from "../src/do-telemetry";

// Synthetic errors shaped like workerd's tagged rejections (jsg/util.c++). Local aborts reject
// flagless (pinned by the "user-DO reset flags" integration test), so the predicate is
// exercised here with the production shapes.
function resetError(flags: Record<string, unknown>): Error {
  return Object.assign(new Error("Durable Object reset."), flags);
}

describe("isDoResetError", () => {
  it("matches the durableObjectReset flag", () => {
    expect(isDoResetError(resetError({ durableObjectReset: true }))).toBe(true);
  });

  it("matches the retryable flag (connection lost)", () => {
    expect(isDoResetError(resetError({ retryable: true }))).toBe(true);
  });

  it("matches the production storage-timeout shape (overloaded reset)", () => {
    expect(isDoResetError(
      resetError({ remote: true, overloaded: true, durableObjectReset: true }))).toBe(true);
  });

  it("rejects overload without a reset (live object shedding load)", () => {
    expect(isDoResetError(resetError({ remote: true, overloaded: true }))).toBe(false);
  });

  it("rejects unflagged and malformed values", () => {
    expect(isDoResetError(new Error("some app error"))).toBe(false);
    expect(isDoResetError(resetError({ durableObjectReset: "yes" }))).toBe(false);
    expect(isDoResetError(resetError({ retryable: 1 }))).toBe(false);
    expect(isDoResetError(null)).toBe(false);
    expect(isDoResetError(undefined)).toBe(false);
    expect(isDoResetError("boom")).toBe(false);
  });
});
