import { useState, type ReactElement } from 'react'
import { CaretDownIcon, CheckIcon, FolderPlusIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { DropdownMenu } from '@/components/DropdownMenu'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { BlueprintNeedRow } from './BlueprintNeedRow'
import { MenuChooser, type MenuChoice } from './MenuChooser'


/** One thing the blueprint needs, as the dialog asks for it. */
export type UseBlueprintNeed = {
  key: string
  title: string
  /** What it is for, as its author said, under its name until it is met. */
  description?: string
  service?: { name: string; logoUrl?: string; color?: string }
  icon?: ReactElement
} & (
  /**
   * A resource of a service: `chosen` names the one chosen; `onChoose` goes to the service's form.
   * `unavailable` says why it cannot be, such as a service this deployment does not offer.
   */
  | { kind: 'connection'; chosen?: string; unavailable?: string; onChoose: () => void }
  /**
   * A model, or the model an agent runs on: `chosen` is its id, or null for none, which only an
   * agent can have, offered as `none` says.
   */
  | { kind: 'model'; models: readonly MenuChoice[]; chosen?: string | null; none?: string; onChoose: (id: string | null) => void }
)

export type UseBlueprintDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The blueprint's name. */
  title: string
  needs: readonly UseBlueprintNeed[]
  /**
   * Where the gadget goes, for one that can go in a workspace the user has as well as a new one:
   * `value` is the workspace chosen, none for a new one.
   */
  place?: { workspaces: readonly { id: string; title: string; label: string }[]; value?: string; onChange: (id: string | undefined) => void }
  /** Makes it. Resolves to whether it was tried (`false` when the connection is down), and rejects with why it was not made. */
  onUse: () => Promise<boolean>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const tick = (on: boolean) => (on
  ? <CheckIcon aria-label="Chosen" weight="bold" className="size-3.5 shrink-0" />
  : <span aria-hidden="true" className="size-3.5 shrink-0" />)

const PlaceChooser = ({ place }: { place: NonNullable<UseBlueprintDialogProps['place']> }) => {
  const chosen = place.value === undefined ? undefined : place.workspaces.find(({ id }) => id === place.value)
  return (
    <DropdownMenu
      label={(
        <span className="flex min-w-0 items-center gap-2">
          {chosen && <WorkspaceIcon label={chosen.label} small />}
          <span className="min-w-0 truncate">{chosen?.title ?? 'A new workspace'}</span>
          <CaretDownIcon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle" />
        </span>
      )}
      aria-label={`It goes in: ${chosen?.title ?? 'a new workspace'}`}
      triggerClassName="h-8 max-w-48 px-3 text-sm"
      align="end"
    >
      <DropdownMenu.Item label="A new workspace" onSelect={() => place.onChange(undefined)}>
        <FolderPlusIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block">A new workspace</span>
          <span className="block text-sm text-kumo-subtle">Named after it</span>
        </span>
        {tick(chosen === undefined)}
      </DropdownMenu.Item>
      {place.workspaces.length > 0 && <DropdownMenu.Separator />}
      {place.workspaces.map((workspace) => (
        <DropdownMenu.Item key={workspace.id} label={workspace.title} onSelect={() => place.onChange(workspace.id)}>
          <WorkspaceIcon label={workspace.label} small />
          <span className="min-w-0 flex-1 truncate">{workspace.title}</span>
          {tick(workspace.id === chosen?.id)}
        </DropdownMenu.Item>
      ))}
    </DropdownMenu>
  )
}

/**
 * Starts a gadget of one's own from a blueprint: each thing it needs on a row, met in place (a
 * model, from a menu) or in the service's own form (a connection, from Choose), with a tick once
 * it is; and, for one that needs nothing, where it goes: a new workspace named after it, or one
 * the user has. Use is ready once everything is met.
 */
export const UseBlueprintDialog = ({ open, onOpenChange, title, needs, place, onUse }: UseBlueprintDialogProps) => {
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  // A model need with none chosen is null only where none is a choice.
  const ready = needs.every(({ chosen }) => chosen !== undefined)

  const use = async () => {
    setProblem(undefined)
    setPending(true)
    try {
      await onUse()
    } catch (error) {
      setProblem(`Couldn’t make it: ${messageOf(error)}`)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!pending) onOpenChange(next) }}
      onClosed={() => setProblem(undefined)}
      size={needs.length > 0 ? 'lg' : 'md'}
      title={`Use “${title}”`}
      description={needs.length > 0
        ? 'Set up what it needs, with your own accounts and models. It’s made in a new workspace, named after it.'
        : 'It needs nothing set up. Choose where your gadget goes.'}
      footer={(
        <>
          <Button disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={pending || !ready} onClick={() => void use()}>{pending ? 'Making it…' : 'Use blueprint'}</Button>
        </>
      )}
    >
      {needs.length > 0 && (
        <section aria-label="What it needs" className="flex flex-col rounded-3xl bg-kumo-tint p-1.5">
          {needs.map((need) => (
            <BlueprintNeedRow
              key={need.key}
              title={need.title}
              service={need.service}
              icon={need.icon}
              detail={need.kind === 'connection' ? need.chosen ?? (need.description || need.service?.name) : need.description || undefined}
              control={need.kind === 'connection' && need.unavailable ? (
                <span className="shrink-0 pe-2 text-sm text-kumo-danger">{need.unavailable}</span>
              ) : need.kind === 'connection' ? (
                <span className="flex shrink-0 items-center gap-1">
                  {need.chosen !== undefined && <CheckIcon aria-label="Chosen" weight="bold" className="size-4 text-kumo-success" />}
                  <Button variant={need.chosen === undefined ? 'secondary' : 'ghost'} className="h-8 px-3 text-sm" disabled={pending} onClick={need.onChoose}>
                    {need.chosen === undefined ? 'Choose' : 'Change'}
                  </Button>
                </span>
              ) : need.models.length === 0 && !need.none ? (
                <span className="shrink-0 pe-2 text-sm text-kumo-danger">You have no model of this kind</span>
              ) : (
                <MenuChooser label={need.title} choices={need.models} value={need.chosen} none={need.none} onChoose={need.onChoose} />
              )}
            />
          ))}
        </section>
      )}
      {place && (
        <div className="flex items-center justify-between gap-3 rounded-3xl bg-kumo-tint py-2 pr-2 pl-4">
          <span className="text-base text-kumo-default">It goes in</span>
          <PlaceChooser place={place} />
        </div>
      )}
      {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
    </Dialog>
  )
}
