/** A labelled rule across the conversation, marking a point rather than a message. */
export const FeedDivider = ({ children }: { children: string }) => (
  <div role="separator" aria-label={children} className="flex items-center gap-3 px-2 py-2 text-xs font-medium text-kumo-subtle">
    <span aria-hidden="true" className="h-px flex-1 bg-kumo-line" />
    {children}
    <span aria-hidden="true" className="h-px flex-1 bg-kumo-line" />
  </div>
)
