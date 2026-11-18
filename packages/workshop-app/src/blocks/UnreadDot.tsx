/**
 * The mark of something with what the viewer has not read, as the sidebar marks a workspace: a dot
 * in the brand's colour, saying how many messages wait where that is known.
 */
export const UnreadDot = ({ count }: { count?: number }) => (
  <span
    role="img"
    aria-label={count === undefined ? 'Unread' : `${count} unread ${count === 1 ? 'message' : 'messages'}`}
    className="size-2 shrink-0 rounded-full bg-kumo-brand"
  />
)
