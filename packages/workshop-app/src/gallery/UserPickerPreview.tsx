import { useState } from 'react'
import { UserPickerDialog, type UserPickerDialogProps } from '@/blocks/UserPickerDialog'
import { Button } from '@gadgets/ui'
import { Section } from './Section'

const DIRECTORY = [
  { id: 'grace', name: 'Grace Hopper' },
  { id: 'alan', name: 'Alan Turing' },
  { id: 'katherine', name: 'Katherine Johnson' },
]

const STATES: Record<string, { label: string; state: Partial<UserPickerDialogProps> }> = {
  empty: { label: 'Nobody yet', state: {} },
  picked: { label: 'Two added', state: { picked: DIRECTORY.slice(0, 2), announcement: 'Added Alan Turing' } },
  adding: { label: 'Adding one', state: { picked: DIRECTORY.slice(0, 1), pending: true } },
  refused: { label: 'Refused by the app', state: { picked: DIRECTORY.slice(0, 1), notice: 'Katherine Johnson: They already have access.' } },
  waiting: { label: 'Done, waiting', state: { picked: DIRECTORY.slice(0, 1), pending: true, closing: true } },
}

/** The person picker a gatekeeper's app opens, in each of its states; the first adds whoever is typed or chosen. */
export const UserPickerPreview = () => {
  const [open, setOpen] = useState<string>()
  const [value, setValue] = useState('')
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([])
  const shown = open === undefined ? undefined : STATES[open]
  const searched = value.trim() === '' ? [] : DIRECTORY.filter(({ name }) => name.toLowerCase().includes(value.toLowerCase()))
  return (
    <Section title="UserPickerDialog (the Workshop’s person picker over a gatekeeper’s app: each person chosen is added as the app takes them, one at a time; what the app refuses is said; Done waits for whoever is being added, with a way to stop waiting)">
      <div className="flex flex-wrap gap-2">
        {Object.entries(STATES).map(([key, { label }]) => <Button key={key} onClick={() => setOpen(key)}>{label}</Button>)}
      </div>
      {shown && (
        <UserPickerDialog
          appTitle="Example Library"
          value={value}
          onValueChange={setValue}
          onPick={(id) => {
            setValue('')
            const person = DIRECTORY.find((candidate) => candidate.id === id) ?? { id, name: id }
            setPicked((current) => (current.some((existing) => existing.id === id) ? current : [...current, person]))
          }}
          picked={open === 'empty' ? picked : []}
          pending={false}
          suggestions={{ people: searched, searching: false, failed: false }}
          announcement=""
          closing={false}
          onClose={() => {
            setOpen(undefined)
            setPicked([])
          }}
          onStopWaiting={() => setOpen(undefined)}
          {...shown.state}
        />
      )}
    </Section>
  )
}
