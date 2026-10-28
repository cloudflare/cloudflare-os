import type { AiChatMessage } from "@gadgets/workshop-shared/api";

/** Map rendered groups to cursor ranges without treating agent-only catalog gaps as new rows. */
export const timelineReadRanges = (
  starts: readonly (number | undefined)[],
  messages: readonly AiChatMessage[],
) => {
  const ranges: ({ start: number; end: number; unreadEnd: number | null; previousUnreadEnd: number } | undefined)[] = [];
  let messageIndex = messages.length - 1;
  for (let index = starts.length - 1; index >= 0; --index) {
    const start = starts[index];
    if (start === undefined) continue;
    while (messageIndex >= 0 && messages[messageIndex].type === "catalogChange")
      --messageIndex;
    const end = messages[messageIndex]?.sequence ?? start;
    let unreadEnd: number | null = null;
    while (messageIndex >= 0 && messages[messageIndex].sequence >= start) {
      const message = messages[messageIndex--];
      // Bookkeeping belongs to the receipt range, but cannot make an already-read response
      // the first unread item. Match the source's text/attachment counting rule.
      if (unreadEnd === null && message.type === "message" &&
          message.generatedBySlashCommandSequence === undefined &&
          (message.message.trim() || message.attachments?.length)) unreadEnd = message.sequence;
    }
    ranges[index] = { start, end, unreadEnd, previousUnreadEnd: -1 };
  }
  let previousUnreadEnd = (messages[0]?.sequence ?? 0) - 1;
  for (const range of ranges) {
    if (!range) continue;
    range.previousUnreadEnd = previousUnreadEnd;
    if (range.unreadEnd !== null) previousUnreadEnd = range.unreadEnd;
  }
  return ranges;
};
