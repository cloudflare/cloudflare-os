import { expect, it } from "vitest";
import type { AiChatMessage, AiChatMessageBody } from "@gadgets/workshop-shared/api";
import { timelineReadRanges } from "./timelineReadRanges";

const message = (sequence: number, body: AiChatMessageBody = {type: "message", message: "Visible"}): AiChatMessage =>
  ({chatId: 1, sequence, timestamp: new Date(), author: {type: "agent", id: "test", name: "Test"}, ...body});

it("places catalog gaps before the next visible row without changing its mark-unread position", () => {
  expect(
    timelineReadRanges(
      [9, 11],
      [
        message(9),
        message(10, {type: "catalogChange", resources: []}),
        message(11),
        message(12, {type: "catalogChange", resources: []}),
      ],
    ),
  ).toEqual([
    { start: 9, end: 9, unreadEnd: 9, previousUnreadEnd: 8 },
    { start: 11, end: 11, unreadEnd: 11, previousUnreadEnd: 9 },
  ]);
});

it("includes folded work and checkpoint bookkeeping but not decorative labels", () => {
  expect(
    timelineReadRanges(
      [2, undefined, 7],
      [
        message(2),
        message(3, {type: "action", actionId: 1}),
        message(4, {type: "changes"}),
        message(5, {type: "catalogChange", resources: []}),
        message(7),
        message(8, {type: "changes"}),
      ],
    ),
  ).toEqual([
    { start: 2, end: 4, unreadEnd: 2, previousUnreadEnd: 1 },
    undefined,
    { start: 7, end: 8, unreadEnd: 7, previousUnreadEnd: 2 },
  ]);
});

it("keeps ranges ordered when older pages arrive", () => {
  expect(
    timelineReadRanges(
      [0, 3],
      [
        message(0),
        message(1, {type: "catalogChange", resources: []}),
        message(3),
      ],
    ),
  ).toEqual([
    { start: 0, end: 0, unreadEnd: 0, previousUnreadEnd: -1 },
    { start: 3, end: 3, unreadEnd: 3, previousUnreadEnd: 0 },
  ]);
  expect(timelineReadRanges([], [])).toEqual([]);
});

it("keeps bookkeeping and reasoning after a read response out of unread navigation", () => {
  expect(timelineReadRanges([0, 3, 5], [
    message(0), message(1, {type: "action", actionId: 1}), message(2, {type: "changes"}),
    message(3, {type: "message", message: "", reasoning: "Not a visible message"}),
    message(4, {type: "changes"}), message(5),
  ])).toEqual([
    {start: 0, end: 2, unreadEnd: 0, previousUnreadEnd: -1},
    {start: 3, end: 4, unreadEnd: null, previousUnreadEnd: 0},
    {start: 5, end: 5, unreadEnd: 5, previousUnreadEnd: 0},
  ]);
});
