import { useId } from 'react'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { Segmented } from '@/components/Segmented'

/** One kind of change a connection can make, and whether it may, and does, go ahead without asking. */
export type ChangeRule = {
  kind: ActionKind
  /** It can be made automatic; one that cannot always asks. */
  autoApprovable: boolean
  automatic: boolean
}

export type ChangeRulesListProps = {
  changes: ChangeRule[]
  onChange: (kind: ActionKind, automatic: boolean) => void
  /** Nothing can be made automatic here, such as where everything asks whatever is chosen: the choices are shown as they are. */
  disabled?: boolean
}

const CHOICES = [{ value: 'ask', label: 'Ask first' }, { value: 'auto', label: 'Allow' }]

/**
 * A kind's label as a row says it: what it is, then how far it reaches, which gatekeepers write
 * after ", in ": "Document edits" and "In any Doc this connection reaches".
 */
export const kindLabel = (label: string): { title: string; reach?: string } => {
  const at = label.indexOf(', in ')
  if (at === -1) return { title: label }
  const reach = label.slice(at + 2)
  return { title: label.slice(0, at), reach: reach.charAt(0).toUpperCase() + reach.slice(1) }
}

/**
 * Every kind of change one connection can make, on a tinted surface, each "Ask first" or
 * "Allow" (`Segmented`), allowed meaning it goes ahead without asking,; one that can never go ahead on its own says "Always asks" in place of
 * the choice, so nothing it can do is left unsaid.
 */
export const ChangeRulesList = ({ changes, onChange, disabled }: ChangeRulesListProps) => {
  const id = useId()
  return (
    <ul className="rounded-3xl bg-kumo-tint px-4 [&>li+li]:border-t [&>li+li]:border-kumo-line">
      {changes.map(({ kind, autoApprovable, automatic }) => {
        const { title, reach } = kindLabel(kind.label)
        const reachId = `${id}-${kind.tag}-reach`
        return (
          <li key={kind.tag} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
              <span className={autoApprovable ? 'text-base/5 text-kumo-default' : 'text-base/5 text-kumo-subtle'}>{title}</span>
              {reach && <span id={reachId} className="text-sm/5 text-kumo-subtle">{reach}</span>}
            </span>
            {autoApprovable ? (
              <Segmented
                aria-label={title}
                aria-describedby={reach ? reachId : undefined}
                value={automatic ? 'auto' : 'ask'}
                options={CHOICES}
                disabled={disabled}
                onValueChange={(value) => onChange(kind, value === 'auto')}
              />
            ) : (
              // As tall as the choice beside it, so that the rows line up.
              <span className="inline-flex h-8 shrink-0 items-center rounded-full bg-kumo-contrast/5 px-3.5 text-sm font-medium text-kumo-subtle">Always asks</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
