import { useState } from 'react'
import { Input } from '@cloudflare/kumo'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'

/** What a gadget is: a noun, such as "Dashboard", and the icon it is drawn with. */
export type GadgetKind = { noun: string; icon: FormatIconName }

export type GadgetKindDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What it is now; none for a plain app. */
  initial?: GadgetKind
  /**
   * Keeps it, or with `null` makes it a plain app again. Resolves to whether it was tried (`false`
   * when the connection is down), and rejects with why it was not kept.
   */
  onSave: (kind: GadgetKind | null) => Promise<boolean>
}

// In the order they are offered, each named for whoever cannot see it.
const ICONS: { name: FormatIconName; label: string }[] = [
  { name: 'appWindow', label: 'App' },
  { name: 'fileText', label: 'Document' },
  { name: 'table', label: 'Table' },
  { name: 'gridNine', label: 'Grid' },
  { name: 'presentation', label: 'Slides' },
  { name: 'chartBar', label: 'Chart' },
  { name: 'kanban', label: 'Board' },
  { name: 'listChecks', label: 'Checklist' },
  { name: 'notebook', label: 'Notebook' },
  { name: 'flowArrow', label: 'Flow' },
  { name: 'calendar', label: 'Calendar' },
  { name: 'inbox', label: 'Inbox' },
  { name: 'form', label: 'Form' },
  { name: 'map', label: 'Map' },
  { name: 'dashboard', label: 'Dashboard' },
  { name: 'database', label: 'Database' },
  { name: 'schedule', label: 'Schedule' },
  { name: 'agent', label: 'Agent' },
  { name: 'people', label: 'People' },
  { name: 'web', label: 'Web' },
]

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Says what a gadget is: what it is called as a kind of thing ("Dashboard") and its icon, which
 * show wherever it is listed and go with a blueprint published from it. With no name it is a plain
 * app again.
 */
export const GadgetKindDialog = ({ open, onOpenChange, initial, onSave }: GadgetKindDialogProps) => {
  const [noun, setNoun] = useState(initial?.noun ?? '')
  const [icon, setIcon] = useState<FormatIconName>(initial?.icon ?? 'appWindow')
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()

  const save = async () => {
    setProblem(undefined)
    setPending(true)
    try {
      const name = noun.trim()
      if (await onSave(name ? { noun: name, icon } : null)) onOpenChange(false)
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!pending) onOpenChange(next) }}
      onClosed={() => setProblem(undefined)}
      title="What it is"
      description="Shown wherever it’s listed, and kept by blueprints published from it. Leave the name empty for a plain app."
      footer={(
        <>
          <Button disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={pending} onClick={() => void save()}>{pending ? 'Saving…' : 'Save'}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <Input label="Kind" value={noun} onChange={(event) => setNoun(event.target.value)} placeholder="App" disabled={pending} />
        <fieldset className="flex flex-col gap-2" disabled={pending}>
          <legend className="mb-2 text-sm font-medium text-kumo-default">Icon</legend>
          <div className="grid grid-cols-5 gap-2">
            {ICONS.map(({ name, label }) => (
              <label
                key={name}
                title={label}
                className="grid aspect-square cursor-pointer place-items-center rounded-xl text-kumo-default ring-1 ring-kumo-line hover:bg-kumo-tint has-checked:bg-kumo-tint has-checked:ring-2 has-checked:ring-kumo-contrast has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-kumo-focus [&>svg]:size-5"
              >
                <input type="radio" name="gadget-icon" value={name} checked={icon === name} onChange={() => setIcon(name)} aria-label={label} className="sr-only" />
                <FormatIcon name={name} />
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
    </Dialog>
  )
}
