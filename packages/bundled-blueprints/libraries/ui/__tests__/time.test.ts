// @vitest-environment node
import { describe, expect, it } from "vitest";

import { relativeTime } from "../src/time.ts";

describe("relativeTime", () => {
  const now = Date.UTC(2026, 8, 5, 12, 0, 0);
  const ago = (ms: number) => relativeTime(now - ms, now);

  it("says just now under 45 seconds, and for a timestamp in the future", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(44_000)).toBe("just now");
    expect(ago(-60_000)).toBe("just now");
  });

  it("rounds to minutes, hours and days", () => {
    expect(ago(45_000)).toBe("1 min ago");
    expect(ago(3 * 60_000)).toBe("3 min ago");
    expect(ago(59 * 60_000)).toBe("59 min ago");
    expect(ago(60 * 60_000)).toBe("1 h ago");
    expect(ago(23 * 3_600_000)).toBe("23 h ago");
    expect(ago(24 * 3_600_000)).toBe("1 d ago");
    expect(ago(29 * 86_400_000)).toBe("29 d ago");
  });

  it("falls back to the locale date from 30 days on", () => {
    const then = now - 30 * 86_400_000;
    expect(relativeTime(then, now)).toBe(new Date(then).toLocaleDateString());
  });

  it("defaults now to the clock", () => {
    expect(relativeTime(Date.now())).toBe("just now");
  });
});
