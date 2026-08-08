import { describe, expect, it } from "vitest";
import type { DeliverySummary } from "../src/types";
import { describeDelivery, formatBytes, formatRelative, statusLabel } from "./format";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function delivery(overrides: Partial<DeliverySummary> = {}): DeliverySummary {
  return {
    deliveryId: "d1",
    endpointId: "e1",
    receivedAt: NOW,
    method: "POST",
    bodyBytes: 100,
    outcome: "delivered",
    attempts: 1,
    ...overrides,
  };
}

describe("statusLabel", () => {
  it("names a not-yet-enabled endpoint in the user's terms, not the storage flag's", () => {
    expect(statusLabel("disabled")).toBe("Not enabled");
    expect(statusLabel("active")).toBe("Active");
    expect(statusLabel("failing")).toBe("Needs attention");
  });
});

describe("formatRelative", () => {
  it("collapses sub-minute ages to 'just now'", () => {
    expect(formatRelative(NOW - 30_000, NOW)).toBe("just now");
    // A clock skew that puts a delivery in the future must not render as negative.
    expect(formatRelative(NOW + 5_000, NOW)).toBe("just now");
  });

  it("steps through minutes, hours, and days", () => {
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatRelative(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatRelative(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
  });

  it("switches to an absolute date past a week", () => {
    expect(formatRelative(NOW - 30 * 86_400_000, NOW)).not.toMatch(/ago/);
  });
});

describe("formatBytes", () => {
  it("scales units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("describeDelivery", () => {
  it("reports a clean delivery without an attempt count", () => {
    expect(describeDelivery(delivery())).toBe("Delivered");
    expect(describeDelivery(delivery({ attempts: 3 }))).toBe("Delivered after 3 attempts");
  });

  it("distinguishes a first queueing from a retry", () => {
    expect(describeDelivery(delivery({ outcome: "queued", attempts: 0 }))).toBe("Queued");
    expect(
      describeDelivery(delivery({ outcome: "queued", attempts: 2, error: "callback threw" })),
    ).toBe("Retrying (attempt 2: callback threw)");
  });

  it("surfaces the failure reason on a dead delivery", () => {
    expect(
      describeDelivery(delivery({ outcome: "failed", attempts: 8, error: "callback threw" })),
    ).toBe("Failed after 8 attempts: callback threw");
  });
});
