import { useEffect, useId, useRef, useState } from 'react'
import { Button, Dialog } from '@cloudflare/kumo'
import {
  getIssueReportErrorCode,
  ISSUE_REPORT_ERROR_CODES,
  type IssueReportAssignee,
  type NamedUser,
} from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { issueFailure } from '../issue-reports/issueFailure'

const Since = ({ at }: { at: Date }) => <time dateTime={at.toISOString()}>{formatFullTimestamp(at)}</time>

// What the block's one button does, for who holds the report and who is reading it. A held
// report offers nothing until the reader is known: releasing is for its holder alone, and taking
// over is asked about by the holder's name.
const ACTIONS = { claim: 'Assign to me', release: 'Release', takeOver: 'Take over…' }
const actionFor = (assignee: IssueReportAssignee | undefined, me: NamedUser | undefined): keyof typeof ACTIONS | undefined =>
  assignee === undefined ? 'claim' : me === undefined ? undefined : assignee.id === me.id ? 'release' : 'takeOver'

/**
 * Who holds an issue report, and the one thing the admin reading it can do about that: take a
 * report nobody holds, release their own, or take over another admin's, which is asked about
 * first in a dialog that names the holder. A take-over takes the report from the holder the
 * dialog named and from nobody else: when another admin holds the report by the time the call
 * lands, nothing is taken and the dialog asks again, naming that admin. A change that fails says
 * why beneath the block.
 *
 * The button is one element whatever it does, and it is disabled while a call runs, so focus is
 * given back to it, or to the block when no button is left, once the call has answered. The
 * dialog gives focus back itself when it closes.
 */
export const ReportAssignee = ({ assignee, me, onClaim, onRelease }: {
  /** The admin who holds the report, as last read. */
  assignee: IssueReportAssignee | undefined
  /** The admin reading it, once known. */
  me: NamedUser | undefined
  /** Makes the reader the assignee, taking the report from the admin `takeOverFrom` names by id
   * when it is given, and settles once the report shows it. A claim refused because another
   * admin holds the report rejects once the report was read again, so that `assignee` is then
   * the admin who holds it. */
  onClaim: (takeOverFrom?: string) => Promise<void>
  /** Leaves the report with no assignee, and settles once the report shows it. */
  onRelease: () => Promise<void>
}) => {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // The take-over last asked about. `holder` is the admin the dialog names, from whom alone
  // confirming it takes the report: kept while the dialog closes so that its words stay as they
  // were. `refused` is set once the server refused the take-over because `holder` no longer held
  // the report, and `after` names the admin a dialog that asks again asked about before.
  const [asked, setAsked] = useState<{
    holder: IssueReportAssignee; open: boolean; refused?: true; after?: IssueReportAssignee
  }>()
  const heading = useId()
  const block = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  // Set by a press of the block's button, for the call it made.
  const pressed = useRef(false)

  const action = actionFor(assignee, me)
  const mine = action === 'release'

  // A refused take-over is settled here, where `assignee` is who the report read again says holds
  // it (see `onClaim`). Another admin than the one asked about is asked about in their turn, and
  // the dialog says why it asks again. Anything else closes the dialog, with the refusal beneath
  // the block.
  if (asked?.refused) {
    if (assignee !== undefined && action === 'takeOver' && assignee.id !== asked.holder.id) {
      setAsked({ holder: assignee, open: true, after: asked.holder })
      setProblem(null)
    } else {
      setAsked({ ...asked, open: false, refused: undefined })
    }
  }

  useEffect(() => {
    if (busy || !pressed.current) return
    pressed.current = false
    const focused = document.activeElement
    if (focused === document.body || block.current?.contains(focused)) (button.current ?? block.current)?.focus()
  }, [busy])

  // A dialog that asks again was confirmed with a button its call then disabled, which leaves
  // focus on nothing: Cancel takes it, as when the dialog opens, so that Enter takes nothing.
  const askedAfter = asked?.after
  useEffect(() => {
    if (askedAfter !== undefined) cancel.current?.focus()
  }, [askedAfter])

  const closeDialog = () => setAsked((previous) => previous && { ...previous, open: false })

  // Makes a change, and answers what it was refused with, or undefined when it went through.
  const change = async (make: () => Promise<void>) => {
    setBusy(true)
    setProblem(null)
    let failure: unknown
    try {
      await make()
    } catch (err) {
      failure = err
      setProblem(issueFailure(err, 'Couldn’t change who holds the report.'))
    }
    setBusy(false)
    return failure
  }

  const takeOver = async (holder: IssueReportAssignee) => {
    if (busy) return
    const failure = await change(() => onClaim(holder.id))
    if (getIssueReportErrorCode(failure) === ISSUE_REPORT_ERROR_CODES.assigned) {
      setAsked((previous) => previous && { ...previous, refused: true })
    } else {
      closeDialog()
    }
  }

  const press = () => {
    if (busy) return
    if (assignee !== undefined && action === 'takeOver') {
      setAsked({ holder: assignee, open: true })
      return
    }
    pressed.current = true
    void change(action === 'release' ? onRelease : () => onClaim())
  }

  return (
    <div
      ref={block}
      role="group"
      tabIndex={-1}
      aria-labelledby={heading}
      aria-busy={busy}
      className="space-y-1.5 focus:outline-none"
    >
      <p id={heading} className="text-base font-medium text-kumo-default">Assignee</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="min-w-0 break-words text-sm text-kumo-default">
          {assignee === undefined ? 'Unassigned' : (
            <>
              {mine ? 'You' : assignee.name}, since <Since at={assignee.at} />
              {assignee.via === 'gatekeeper' && ', by an agent'}
            </>
          )}
        </p>
        {action !== undefined && (
          <Button ref={button} size="sm" variant="secondary" loading={busy} onClick={press}>
            {ACTIONS[action]}
          </Button>
        )}
      </div>
      {problem !== null && <p role="alert" className="text-sm text-kumo-danger">{problem}</p>}

      <Dialog.Root
        open={asked?.open ?? false}
        onOpenChange={(open) => { if (!open && !busy) closeDialog() }}
      >
        <Dialog className="p-6">
          {asked !== undefined && (
            // One column that may be narrower than a name with nowhere to break, which then wraps:
            // the dialog hides what is wider than it, the buttons included.
            <div className="grid grid-cols-1 gap-4">
              <div className="space-y-1">
                <Dialog.Title className="break-words text-lg font-semibold text-kumo-strong">
                  Take this report over from {asked.holder.name}?
                </Dialog.Title>
                <Dialog.Description className="break-words text-sm text-kumo-subtle">
                  {asked.holder.name} holds this report since <Since at={asked.holder.at} />. Taking it
                  over assigns it to you and is entered in the thread, where admins read it.
                </Dialog.Description>
                {asked.after !== undefined && (
                  <p role="alert" className="break-words text-sm text-kumo-danger">
                    {asked.after.name} no longer holds this report, so it was not taken over.
                  </p>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button ref={cancel} variant="secondary" disabled={busy} onClick={closeDialog}>Cancel</Button>
                <Button variant="primary" loading={busy} onClick={() => void takeOver(asked.holder)}>
                  Take over
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      </Dialog.Root>
    </div>
  )
}
