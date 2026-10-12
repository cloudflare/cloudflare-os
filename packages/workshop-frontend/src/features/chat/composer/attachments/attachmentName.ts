const MAX_VISIBLE_LENGTH = 24;
const TAIL_LENGTH = 8;

/**
 * Shortens a long file name in the middle so its end, which carries the extension, stays visible.
 * CSS can only clip the end of a multi-line block, so the cut is made by character count. The
 * limit is sized for the two-line label of an attachment card; the CSS clamp stays as a backstop.
 */
export const shortenAttachmentName = (name: string): string => {
  if (name.length <= MAX_VISIBLE_LENGTH) return name;
  const head = name.slice(0, MAX_VISIBLE_LENGTH - TAIL_LENGTH - 1);
  return `${head}…${name.slice(-TAIL_LENGTH)}`;
};
