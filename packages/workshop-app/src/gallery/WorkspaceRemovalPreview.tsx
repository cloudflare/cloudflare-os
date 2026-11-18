import { useState } from 'react'
import { RemoveWorkspaceDialog, type RemoveWorkspaceDialogProps } from '@/blocks/RemoveWorkspaceDialog'
import { WorkspaceMoreMenu } from '@/blocks/WorkspaceMoreMenu'
import { Button } from '@/components/Button'
import { useReport } from './previewState'
import { Section } from './Section'

const later = (action: () => void) => new Promise<void>((resolve, reject) => setTimeout(() => {
  try {
    action()
    resolve()
  } catch (error) {
    reject(error)
  }
}, 900))

const CASES: Record<string, { label: string } & Omit<RemoveWorkspaceDialogProps, 'open' | 'onOpenChange' | 'onConfirm'> & { fails?: boolean }> = {
  shared: { label: 'Delete, shared with three', title: 'Q3 platform review', removal: 'delete', others: 3 },
  one: { label: 'Delete, shared with one', title: 'Launch checklist', removal: 'delete', others: 1 },
  alone: { label: 'Delete, nobody else', title: 'Scratchpad', removal: 'delete', others: 0 },
  unknown: { label: 'Delete, members not read', title: 'Hiring plan', removal: 'delete' },
  dismiss: { label: 'Remove from my list', title: 'Hiring plan', removal: 'dismiss' },
  failing: { label: 'Deleting fails', title: 'Q3 platform review', removal: 'delete', others: 2, fails: true },
}

/** Deleting a workspace as its owner, or removing one shared with the viewer from their list, from its More menu. */
export const WorkspaceRemovalPreview = () => {
  const { report, say } = useReport()
  const [shown, setShown] = useState<string>()
  const [open, setOpen] = useState(false)
  const ask = (key: string) => {
    setShown(key)
    setOpen(true)
  }
  const props = shown ? CASES[shown] : undefined
  return (
    <>
      <Section title="WorkspaceMoreMenu (a workspace’s more: from a list, open in a new tab and copy its link, then delete it as its owner; on its page, only that; and for one shared with the viewer, removing it from their list instead)">
        <WorkspaceMoreMenu title="Q3 platform review" href="#q3" removal={{ kind: 'delete', onSelect: () => ask('shared') }} />
        <WorkspaceMoreMenu title="Q3 platform review" triggerVariant="secondary" removal={{ kind: 'delete', onSelect: () => ask('shared') }} />
        <WorkspaceMoreMenu title="Hiring plan" href="#hiring" removal={{ kind: 'dismiss', onSelect: () => ask('dismiss') }} />
      </Section>
      <Section title="RemoveWorkspaceDialog (asks before a workspace goes: deleting it says what goes and for whom, as far as its members are known, and that it can’t be undone; removing one shared with the viewer says they keep their access and its link brings it back; held while it is done, and a failure stays in it, under why)">
        {Object.entries(CASES).map(([key, { label }]) => (
          <Button key={key} onClick={() => ask(key)}>{label}</Button>
        ))}
        <p role="status" className="w-full text-sm text-kumo-subtle">{report}</p>
        {props && (
          <RemoveWorkspaceDialog
            open={open}
            onOpenChange={setOpen}
            {...props}
            onConfirm={() => later(() => {
              if (props.fails) throw new Error('The workspace couldn’t be reached. Try again.')
              say(`${props.removal === 'delete' ? 'deleted' : 'removed'} ${props.title}`)
              setOpen(false)
            })}
          />
        )}
      </Section>
    </>
  )
}
