import { useState, type FormEvent } from 'react'
import { PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button, CardAction, LIST_ACTION, ON_SETTINGS_CARD, SOON, SettingsGroup, Switch, TextField } from '@gadgets/ui'

/** A rule in the user's own words for what the assistant does. */
export type ApprovalRule = {
  id: string
  /** What it is about, as the user described it. */
  text: string
  /** Off, it is kept but not gone by. */
  enabled: boolean
}

export type ApprovalRulesProps = {
  /** What the rules say of what they describe, which they have in common: "Always ask". */
  title: string
  /** What that means for what the rules describe, in a line under the title. */
  description?: string
  /** None of it is there yet (see `SettingsGroup`). */
  soon?: boolean
  rules: ApprovalRule[]
  /** What a rule here reads like, in the field a new one is written in. */
  placeholder?: string
  onAdd: (text: string) => void
  onRemove: (id: string) => void
  onEnabledChange: (id: string, enabled: boolean) => void
}

/**
 * Rules in the user's own words that say one thing of what they describe, as a `SettingsGroup`:
 * what they say is its title, with the way to add one across from it, which opens a field under
 * the rules to write it in, where whoever keeps the rules then lists it: last. Each can be switched
 * off without being lost, or removed.
 */
export const ApprovalRules = ({ title, description, soon, rules, placeholder, onAdd, onRemove, onEnabledChange }: ApprovalRulesProps) => {
  // Open while a rule is being written, and what is written of it.
  const [draft, setDraft] = useState<string>()
  const add = (event: FormEvent) => {
    event.preventDefault()
    const written = draft?.trim()
    if (!written) return
    onAdd(written)
    setDraft(undefined)
  }

  return (
    <SettingsGroup
      title={title}
      description={description}
      soon={soon}
      action={<Button icon={PlusIcon} disabled={draft !== undefined} onClick={() => setDraft('')}>Add rule</Button>}
    >
      {rules.length === 0 && draft === undefined && <p className={cn('py-4 text-kumo-subtle', soon && SOON)}>No rules yet.</p>}
      {rules.length > 0 && (
        <ul aria-label={title} className="flex flex-col">
          {rules.map(({ id, text, enabled }) => (
            // A button tall, with what it says a line down from its top, so that the two are level however long the rule is.
            <li key={id} className="group flex items-start gap-3 border-t border-kumo-line py-2 first:border-t-0">
              <p className={cn('min-w-0 flex-1 py-2 leading-snug wrap-anywhere text-kumo-default', soon ? SOON : !enabled && 'opacity-60')}>{text}</p>
              <span inert={soon} className={cn('flex h-(--control-size) shrink-0 items-center gap-2', soon && SOON)}>
                {/* Seen while the rule is pointed at or has the focus, and always to a finger. Its room is kept, before the switch, so that neither the switch nor what the rule says moves as it shows. */}
                <CardAction>
                  <Button variant="ghost" icon={TrashIcon} aria-label={`Remove rule: ${text}`} title="Remove" onClick={() => onRemove(id)} className={LIST_ACTION} />
                </CardAction>
                <Switch aria-label={text} checked={enabled} onCheckedChange={(next) => onEnabledChange(id, next)} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* Under the rules, where the one written is then listed. */}
      {draft !== undefined && (
        <form onSubmit={add} className={cn('flex flex-col gap-3 py-4', rules.length > 0 && 'border-t border-kumo-line')}>
          <TextField
            aria-label={`New rule: ${title}`}
            placeholder={placeholder}
            autoFocus
            value={draft}
            onValueChange={setDraft}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setDraft(undefined)
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDraft(undefined)} className={ON_SETTINGS_CARD}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!draft.trim()}>Add</Button>
          </div>
        </form>
      )}
    </SettingsGroup>
  )
}
