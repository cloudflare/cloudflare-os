import { usePending, type ActionResult } from './usePending'

export type FeedDividerProps = {
  children: string
  /** What can be done about what it marks, as a word after it: "Redo". */
  action?: { label: string; title?: string; onSelect: () => ActionResult }
}

/**
 * A labelled rule across the conversation, marking a point rather than a message: where the
 * context was cut, or something a person did to the chat's changes, with what can be done about it.
 */
export const FeedDivider = ({ children, action }: FeedDividerProps) => {
  const [pending, run] = usePending()
  return (
    <div role="separator" aria-label={children} className="flex items-center gap-3 px-2 py-2 text-xs font-medium text-kumo-subtle">
      <span aria-hidden="true" className="h-px flex-1 bg-kumo-line" />
      <span className="flex items-center gap-1.5">
        {children}
        {action && (
          <>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              title={action.title}
              disabled={pending}
              onClick={() => run(action.onSelect)}
              className="rounded-sm text-kumo-default underline-offset-2 outline-none hover:underline focus-visible:underline disabled:opacity-50"
            >
              {action.label}
            </button>
          </>
        )}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-kumo-line" />
    </div>
  )
}
