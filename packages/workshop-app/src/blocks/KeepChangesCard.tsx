import { useState } from 'react'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { usePending, type ActionResult } from './usePending'

export type KeepChangesCardProps = {
  /** What the changes do, one line each: "Gives “Tip Jar” access to env.JIRA". */
  changes: string[]
  /** Why they wait for the user, rather than being kept as a turn's changes are. */
  reason: string
  onKeep: () => ActionResult
  /** Throws them away, once the user has said so again: what is discarded is gone. */
  onDiscard: () => ActionResult
}

/**
 * A chat's changes that could not be kept on their own, waiting for the user at the end of the
 * conversation: what they would do, why they wait, and the two answers.
 */
export const KeepChangesCard = ({ changes, reason, onKeep, onDiscard }: KeepChangesCardProps) => {
  const [pending, run] = usePending()
  const [confirming, setConfirming] = useState(false)

  return (
    <Card>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium text-kumo-default">Keep these changes?</span>
        {changes.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-sm text-kumo-default">
            {changes.map((change) => <li key={change}>{change}</li>)}
          </ul>
        )}
        <p className="text-sm text-kumo-subtle">{reason}</p>
      </div>
      <div className="flex justify-end gap-2">
        <Button disabled={pending} onClick={() => setConfirming(true)}>Discard</Button>
        <Button variant="primary" disabled={pending} onClick={() => run(onKeep)}>Keep</Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        destructive
        title="Discard these changes?"
        description="Everything this chat changed since its changes were last kept goes, and can’t be had back."
        confirm="Discard"
        onConfirm={async () => { await onDiscard() }}
      />
    </Card>
  )
}
