import { useId } from 'react'
import { GitMergeIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { usePending, type ActionResult } from './usePending'

export type KeepChangesCardProps = {
  /** What the changes do, one line each: "Connects “Tip Jar” to “Platform board”". */
  changes: string[]
  /** What to know before keeping them: that they are only in the chat until then, or more. */
  reason: string
  onKeep: () => ActionResult
  /** Throws them away, once the user has said so again: what is discarded is gone. */
  onDiscard: () => void
}

/**
 * A chat's changes, waiting for the user at the end of the conversation, as nothing is kept until
 * someone keeps it: what they would do, what to know before keeping them, and the two answers.
 * Discarding asks again, as what is discarded cannot be had back.
 */
export const KeepChangesCard = ({ changes, reason, onKeep, onDiscard }: KeepChangesCardProps) => {
  const id = useId()
  const [pending, run] = usePending()
  return (
    <Card>
      <section aria-labelledby={`${id}-title`} className="contents">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-kumo-fill text-kumo-default">
            <GitMergeIcon aria-hidden="true" className="size-5" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3 id={`${id}-title`} className="font-medium text-kumo-default">Keep these changes?</h3>
            <p id={`${id}-reason`} className="text-sm text-kumo-subtle">{reason}</p>
          </div>
        </div>
        {changes.length > 0 && (
          <ul className="flex flex-col gap-1 ps-12 text-sm text-kumo-default">
            {changes.map((change) => <li key={change}>{change}</li>)}
          </ul>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <ConfirmMenu
            label="Discard"
            triggerVariant="secondary"
            title="Discard these changes?"
            description="Everything this chat changed since its changes were last kept goes, and can’t be had back."
            confirmLabel="Discard"
            onConfirm={onDiscard}
            disabled={pending}
          />
          <Button variant="primary" disabled={pending} aria-describedby={`${id}-reason`} onClick={() => run(onKeep)}>Keep</Button>
        </div>
      </section>
    </Card>
  )
}
