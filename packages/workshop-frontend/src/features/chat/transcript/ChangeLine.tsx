import type { ReactNode } from 'react'
import styles from './transcript.module.css'

/**
 * A point the person can go back to: one quiet line, in the receipts' voice, where a turn's
 * changes landed ("Updated Budget") or where they went back ("Restored Budget to an earlier
 * version"). The newest point offers Undo outright. Older ones offer Restore when the line is
 * hovered or focused (and always on touch), so the history reads calmly and every point stays
 * one click away. Restoring adds a point rather than rewriting any, and new words fade in place,
 * so going back never moves the chat.
 */
export function ChangeLine({ icon, label, action, actionTitle, reveal = false, busy, onAction }: {
  icon: ReactNode
  label: string
  /** The way back; absent when there is none. */
  action?: 'Undo' | 'Redo' | 'Restore'
  /** What the action will do, as its tooltip. */
  actionTitle?: string
  /** Shows the action only on hover or focus, as older points do. */
  reveal?: boolean
  busy?: boolean
  onAction?: () => void
}) {
  return (
    <div className="group/change flex h-8 w-fit max-w-full items-center gap-[9px] px-1.5 text-[14px] leading-5 text-kumo-subtle">
      <span className="flex size-5 shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">{icon}</span>
      <span key={label} className={`${styles.statusLabel} min-w-0 truncate`}>{label}</span>
      {action && (
        <button
          key={action}
          type="button"
          disabled={busy}
          onClick={onAction}
          title={actionTitle}
          className={`${styles.statusLabel} -my-1 inline-flex h-7 shrink-0 cursor-pointer items-center rounded-full px-2.5 text-[13px] font-medium text-kumo-default transition-[background-color,opacity] duration-150 hover:bg-kumo-tint focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-default disabled:opacity-50 ${reveal ? 'pointer-fine:opacity-0 pointer-fine:group-hover/change:opacity-100' : ''}`}
        >
          {action}
        </button>
      )}
    </div>
  )
}

/** "Budget", "Budget and Notes", or "3 apps". */
export function listApps(titles: string[], noun = 'apps'): string {
  if (titles.length <= 2) return titles.join(' and ')
  return `${titles.length} ${noun}`
}
