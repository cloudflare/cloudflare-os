import type { ReactNode } from 'react'
import type { ResourceLinkProps } from './ResourceLink'
import type { ActionResult } from './usePending'

/** Everything there is to say of one automation, and what can be done to it, as its row and its dialog show it. */
export type AutomationDetails = {
  /** A scheduled task (a clock), or something an event a service delivers sets off (a bolt). */
  kind: 'schedule' | 'event'
  title: string
  /** When it runs, in words: "Every weekday at 9:00 AM". Absent where that is not known. */
  when?: string
  /** When it runs next while on course: how soon ("in 3 days") and when exactly ("Monday at 8:00 AM"). */
  next?: { soon: string; at: string }
  /** Said in place of when it runs next: why it stopped, that it is trying again, or that it is done. */
  note?: { words: string; tone: 'quiet' | 'warning' }
  /** What it does each time, as it was set up to, in Markdown. */
  description?: string
  /** What an event comes from, such as a board or an inbox. */
  resource?: ResourceLinkProps
  /** The app whose code it runs, which opens it. */
  gadget?: { title: string; href?: string; onOpen: () => void }
  /** The workspace it is in, where it is listed among others': it opens the workspace. */
  workspace?: { title: string; icon: ReactNode; href?: string; onOpen: () => void }
  enabled: boolean
  /** Absent for whoever may not change it, who sees whether it is on. */
  onEnabledChange?: (enabled: boolean) => ActionResult
  /** Deletes it for good. Absent for whoever may not. A rejection is said where it was asked from. */
  onDelete?: () => ActionResult
  /** Why the last change to it was refused. */
  problem?: string
}

/** What deleting one does, as both ways of asking say it. */
export const deletionWords = ({ gadget }: Pick<AutomationDetails, 'gadget'>) =>
  `It won’t run again, and this can’t be undone. ${gadget ? `“${gadget.title}”` : 'The app it runs'} stays as it is. To stop it for a while instead, turn it off.`

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Why a deletion failed, from what it rejected with. */
export const deletionProblem = (error: unknown) => `Couldn’t delete it: ${messageOf(error)}`
