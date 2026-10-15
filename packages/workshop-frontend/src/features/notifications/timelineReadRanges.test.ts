import { expect, it } from "vitest";
import { timelineReadRanges } from "./timelineReadRanges";

it("places catalog gaps before the next visible row without changing its mark-unread position", () => {
  expect(
    timelineReadRanges(
      [9, 11],
      [
        { sequence: 9, type: "message" },
        { sequence: 10, type: "catalogChange" },
        { sequence: 11, type: "message" },
        { sequence: 12, type: "catalogChange" },
      ],
    ),
  ).toEqual([
    { start: 9, end: 9, previousEnd: 8 },
    { start: 11, end: 11, previousEnd: 9 },
  ]);
});

it("includes folded work and checkpoint bookkeeping but not decorative labels", () => {
  expect(
    timelineReadRanges(
      [2, undefined, 7],
      [
        { sequence: 2, type: "message" },
        { sequence: 3, type: "action" },
        { sequence: 4, type: "changes" },
        { sequence: 5, type: "catalogChange" },
        { sequence: 7, type: "message" },
        { sequence: 8, type: "changes" },
      ],
    ),
  ).toEqual([
    { start: 2, end: 4, previousEnd: 1 },
    undefined,
    { start: 7, end: 8, previousEnd: 4 },
  ]);
});

it("keeps ranges ordered when older pages arrive", () => {
  expect(
    timelineReadRanges(
      [0, 3],
      [
        { sequence: 0, type: "message" },
        { sequence: 1, type: "catalogChange" },
        { sequence: 3, type: "message" },
      ],
    ),
  ).toEqual([
    { start: 0, end: 0, previousEnd: -1 },
    { start: 3, end: 3, previousEnd: 0 },
  ]);
  expect(timelineReadRanges([], [])).toEqual([]);
});
