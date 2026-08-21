// The restricted-data flag on persisted observation records must be readable under both its
// current name and its pre-rename one: records written before the rename (commit 6b778a18) carry
// `prohibitAllSharing`, are never rewritten, and anchor the producer-scoped removal guard and
// assertNewSharingAllowed -- a legacy record read as unflagged would let a legacy-latched
// workspace share past a removed producer.

import { describe, it, expect } from "vitest";
import { observationContainsRestrictedData } from "../src/overseer.js";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";

function description(flags: Record<string, unknown>): ObservationDescription {
  return { title: "t", description: "d", ...flags } as ObservationDescription;
}

describe("observationContainsRestrictedData", () => {
  it("reads the current field name", () => {
    expect(observationContainsRestrictedData(description({ containsRestrictedData: true })))
        .toBe(true);
  });

  it("reads the pre-rename field name on legacy records", () => {
    expect(observationContainsRestrictedData(description({ prohibitAllSharing: true })))
        .toBe(true);
  });

  it("is false when neither name is present", () => {
    expect(observationContainsRestrictedData(description({}))).toBe(false);
  });

  it("is true when both names are present", () => {
    expect(observationContainsRestrictedData(
        description({ containsRestrictedData: true, prohibitAllSharing: true }))).toBe(true);
  });

  it("is false for an explicit legacy false", () => {
    expect(observationContainsRestrictedData(description({ prohibitAllSharing: false })))
        .toBe(false);
  });
});
