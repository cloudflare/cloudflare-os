import type { AiChatMessage } from "@gadgets/workshop-shared/api";

/** Map rendered groups to cursor ranges without treating agent-only catalog gaps as new rows. */
export const timelineReadRanges = (
  starts: readonly (number | undefined)[],
  messages: readonly Pick<AiChatMessage, "sequence" | "type">[],
) => {
  const ranges: ({ start: number; end: number; previousEnd: number } | undefined)[] = [];
  let nextStart = Infinity;
  let messageIndex = messages.length - 1;
  for (let index = starts.length - 1; index >= 0; --index) {
    const start = starts[index];
    if (start === undefined) continue;
    while (
      messageIndex >= 0 &&
      (messages[messageIndex].sequence >= nextStart ||
        messages[messageIndex].type === "catalogChange")
    )
      --messageIndex;
    ranges[index] = { start, end: messages[messageIndex]?.sequence ?? start, previousEnd: -1 };
    nextStart = start;
  }
  let previousEnd = (messages[0]?.sequence ?? 0) - 1;
  for (const range of ranges) {
    if (!range) continue;
    range.previousEnd = previousEnd;
    previousEnd = range.end;
  }
  return ranges;
};
