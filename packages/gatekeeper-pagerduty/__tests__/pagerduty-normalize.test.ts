// An alert's details as the agent reads them: PagerDuty sends a monitoring tool's details as a
// JSON object or as plain text, and both reach the agent.

import { describe, expect, it } from "vitest";
import { toAlert, type WireAlert } from "../src/pagerduty-normalize";

const alert = (details: unknown): WireAlert =>
  ({ id: "PALRT01", status: "triggered", created_at: "2026-11-06T00:00:00Z", body: { details } });

describe("an alert's details", () => {
  it.each([
    ["keeps a JSON object", { disk: "95%" }, { disk: "95%" }],
    ["keeps plain text", "Disk on db-1 is 95% full", "Disk on db-1 is 95% full"],
    ["has none for empty text", "", null],
    ["has none when PagerDuty sends none", undefined, null],
  ])("%s", (_name, details, expected) => {
    expect(toAlert(alert(details)).details).toEqual(expected);
  });
});
