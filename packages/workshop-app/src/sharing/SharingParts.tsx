import type { ReactNode } from 'react'
import type { ObserverBindingNeed } from '@gadgets/workshop-shared/api'
import { ShareNote } from '@/blocks/ShareNote'
import { Button } from '@/components/Button'
import type { SharingSnapshot } from './SharingSession'

/** The dialog's people while they are read, or why they could not be. */
export const SharingPending = ({ snapshot, onRetry }: { snapshot: Exclude<SharingSnapshot, { status: 'ready' }>; onRetry: () => void }) =>
  snapshot.status === 'loading' ? (
    // As tall as a short list, so the dialog does not jump much once it is read.
    <p role="status" className="grid min-h-32 place-items-center text-base/5 text-kumo-subtle">Loading who has access…</p>
  ) : (
    <ShareNote tone="error" detail={snapshot.message} action={<Button onClick={onRetry}>Try again</Button>}>
      Couldn’t load who has access.
    </ShareNote>
  )

const listed = (titles: readonly string[]) =>
  titles.length <= 1 ? titles.join('') : `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`

/**
 * What someone given it must have their own access to before they can open it: the connections it
 * reads from, which each person uses with an account of their own. One line, as most are set up
 * for them, such as Scheduled Tasks.
 */
export const RequirementsNote = ({ requirements, what }: { requirements?: readonly ObserverBindingNeed[]; what: ReactNode }) => {
  if (!requirements || requirements.length === 0) return null
  const titles = [...new Set(requirements.map(({ resourceTitle }) => resourceTitle))]
  return (
    <ShareNote tone="info">
      Whoever opens {what} uses their own {listed(titles)} {titles.length === 1 ? 'account' : 'accounts'} with it, connected the first time.
    </ShareNote>
  )
}
