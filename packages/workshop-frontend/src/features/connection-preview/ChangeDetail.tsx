import type { ActionField } from '@gadgets/workshop-shared/gatekeeper'
import { ActionFields } from '../../components/ActionFields'

// A value keeps every space as sent, as ActionFields shows one.
const chipClass = 'rounded bg-kumo-tint px-1 py-0.5 font-mono text-[12px] leading-[18px] text-kumo-default whitespace-pre-wrap break-words'

/**
 * A description's prose with its code spans drawn as values. Nothing else in it is read as
 * Markdown: a span holds a name the gatekeeper stripped of backticks, so it cannot end early.
 */
export const ChangeProse = ({ text }: { text: string }) => {
  const parts = text.split('`')
  // An odd backtick opens a span nothing closes, so the text is shown as it is.
  if (parts.length % 2 === 0) return text
  return parts.map((part, n) => n % 2 === 0 ? part : <code key={n} className={chipClass}>{part}</code>)
}

type ShortField = Extract<ActionField, { kind: 'inline' }>

const isShort = (field: ActionField): field is ShortField =>
  field.kind === 'inline' && field.value !== '' && !field.truncated

/**
 * What a waiting change sends, in the room a card has: values short enough for one line share it
 * with their labels, and ActionFields draws the rest as it does everywhere, a block each.
 */
export const ChangeFields = ({ fields }: { fields: ActionField[] }) => {
  const runs: ActionField[][] = []
  for (const field of fields) {
    const run = runs.at(-1)
    if (run && isShort(run[0]) === isShort(field)) run.push(field)
    else runs.push([field])
  }
  return runs.map((run, n) => isShort(run[0]) ? (
    <dl key={n} className="m-0 mt-2.5 grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5">
      {run.filter(isShort).map((field, row) => (
        <div key={row} className="contents">
          <dt className="text-[12px] leading-[18px] text-kumo-subtle">{field.label}</dt>
          <dd className="m-0 min-w-0"><code className={chipClass}>{field.value}</code></dd>
        </div>
      ))}
    </dl>
  ) : (
    <ActionFields key={n} fields={run} className="mt-2.5" />
  ))
}
