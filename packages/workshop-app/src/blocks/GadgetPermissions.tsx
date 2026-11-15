import { useId, useState } from 'react'
import { Switch } from '@cloudflare/kumo'
import { Button } from '@/components/Button'
import { ServiceLogo } from '@/components/ServiceLogo'
import { SettingsGroup, SettingsRow } from './SettingsGroup'
import { usePending, type ActionResult } from './usePending'

/** A kind of change the gadget may make without asking. */
export type GadgetAllowanceItem = {
  key: string
  /** The kind, as its service names it: "Append to documents". */
  title: string
  /** Where, and who allowed it: "Q3 Budget · Allowed by Phillip". */
  detail: string
  service?: { name: string; logoUrl?: string; color?: string }
}

export type GadgetPermissionsProps = {
  /** Who made it, when that is someone else. */
  madeBy?: string
  /** It may make any change its services let through unasked. */
  everything: boolean
  allowances: GadgetAllowanceItem[]
  /** Absent for whoever may not change it. */
  onEverythingChange?: (on: boolean) => Promise<void>
  onAskAgain?: (key: string) => ActionResult
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const AllowanceRow = ({ allowance, onAskAgain }: { allowance: GadgetAllowanceItem; onAskAgain?: () => ActionResult }) => {
  const [pending, run] = usePending()
  return (
    <div className="flex items-center gap-3 py-3">
      {allowance.service && <ServiceLogo name={allowance.service.name} src={allowance.service.logoUrl} color={allowance.service.color} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-base text-kumo-default">{allowance.title}</span>
        <span className="truncate text-sm text-kumo-subtle">{allowance.detail}</span>
      </div>
      {onAskAgain && <Button variant="ghost" disabled={pending} onClick={() => run(onAskAgain)}>Ask again</Button>}
    </div>
  )
}

/**
 * What a gadget may change through its connections without asking: everything its services let
 * through, with one switch, or the kinds allowed one at a time when it asked, each of which can be
 * made to ask again. Someone else's gadget says whose it is first, since its code is theirs.
 */
export const GadgetPermissions = ({ madeBy, everything, allowances, onEverythingChange, onAskAgain }: GadgetPermissionsProps) => {
  const id = useId()
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-1 ps-4">
        <h2 className="text-sm font-medium text-kumo-subtle">What it does without asking</h2>
        <p className="max-w-xl text-sm/5 text-kumo-subtle">
          {madeBy
            ? `Made by ${madeBy}. It asks the first time it wants to change something through your connections, and what you allow shows here.`
            : 'It asks before it changes something through its connections, unless it’s allowed here.'}
        </p>
      </div>
      <SettingsGroup label="What it does without asking">
        <SettingsRow
          id={id}
          title="Don’t ask"
          description={problem ?? 'Anything its services allow goes ahead. Sending, sharing and deleting still ask.'}
          control={(
            <Switch
              size="sm"
              aria-label="Don’t ask"
              aria-describedby={`${id}-description`}
              checked={everything}
              aria-disabled={!onEverythingChange || pending || undefined}
              transitioning={pending}
              onCheckedChange={(checked) => {
                if (!onEverythingChange || pending) return
                setPending(true)
                setProblem(undefined)
                onEverythingChange(checked)
                  .catch((error: unknown) => setProblem(`Couldn’t change it. ${messageOf(error)}`))
                  .finally(() => setPending(false))
              }}
            />
          )}
        />
        {!everything && (allowances.length === 0 ? (
          <SettingsRow title="Nothing allowed yet" description="When it asks, Always allow lets it make that kind of change again without asking." />
        ) : allowances.map((allowance) => (
          <AllowanceRow key={allowance.key} allowance={allowance} onAskAgain={onAskAgain && (() => onAskAgain(allowance.key))} />
        )))}
      </SettingsGroup>
    </section>
  )
}
