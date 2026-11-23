import { useState, type ReactNode } from 'react'
import { Cancel01Icon, CheckmarkCircle02Icon, PackageIcon, RoboticIcon } from '@/components/icons'
import { Banner, Button, Dialog, Select } from '@gadgets/ui'
import { ServiceLogo } from '@/components/ServiceLogo'

/** A model one of the needs can be met with. */
export type SetupModel = { id: string; name: string }

/** One thing a template needs set up, as the dialog asks for it. */
export type UseTemplateNeed = {
  key: string
  /** What its creator called it: "Budget sheet". */
  title: string
  /** What it is for, where its creator said, under its title until it is met. */
  description?: string
} & (
  | {
      kind: 'connection'
      service: { name: string; logoUrl?: string; color?: string }
      /** The one chosen, as a line can show it. */
      chosen?: string
      /** Why it cannot be chosen here, such as a service the deployment does not offer. */
      unavailable?: string
      /** Goes to the service's own form for which one. */
      onChoose: () => void
    }
  | {
      /** A model it uses, or the one an agent it starts runs on. */
      kind: 'model' | 'agent'
      /** The user's models of its kind; none given, they are still being read. */
      models?: readonly SetupModel[]
      /** The id of the one chosen, or null for no model, which only an agent can run with. */
      chosen?: string | null
      onChoose: (id: string | null) => void
    }
)

export type UseTemplateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The template's name. */
  title: string
  /** Who created it, where that is someone other than the user. */
  creator?: string
  needs: readonly UseTemplateNeed[]
  /**
   * Makes something from it, holding the dialog while it does, and leaving it open under why if it
   * cannot. Resolves to whether it was tried: not while the connection is down, which says so itself.
   */
  onUse: () => Promise<boolean>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// What stands for no model at all, among the ids of the models an agent can run on.
const NO_MODEL = ''

/** What a need is drawn with: its service's logo, or what a model or an agent is. */
const needIcon = (need: UseTemplateNeed): ReactNode =>
  need.kind === 'connection'
    ? <ServiceLogo name={need.service.name} src={need.service.logoUrl} color={need.service.color} small />
    : (
        <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-kumo-fill text-kumo-default">
          {need.kind === 'agent' ? <RoboticIcon className="size-5" /> : <PackageIcon className="size-5" />}
        </span>
      )

/** How a need is met: the way to its service's form, or the model it runs on. */
const NeedControl = ({ need, pending }: { need: UseTemplateNeed; pending: boolean }) => {
  if (need.kind === 'connection') {
    if (need.unavailable) return <span className="pe-2 text-sm text-kumo-danger">{need.unavailable}</span>
    return (
      <span className="flex items-center gap-1.5">
        {need.chosen !== undefined && <CheckmarkCircle02Icon aria-label="Chosen" weight="fill" className="size-4 text-(--color-live)" />}
        <Button variant={need.chosen === undefined ? 'secondary' : 'ghost'} disabled={pending} onClick={need.onChoose} aria-label={`${need.chosen === undefined ? 'Choose' : 'Change'} ${need.title}`}>
          {need.chosen === undefined ? 'Choose' : 'Change'}
        </Button>
      </span>
    )
  }
  if (need.models === undefined) return <span role="status" className="appears-late pe-2 text-sm text-kumo-subtle">Reading your models…</span>
  // Only an agent can run with none, which is then one of the choices.
  const options = [...(need.kind === 'agent' ? [{ id: NO_MODEL, label: 'No agent' }] : []), ...need.models.map(({ id, name }) => ({ id, label: name }))]
  if (options.length === 0) return <span className="pe-2 text-sm text-kumo-danger">You have no model of this kind</span>
  return (
    <Select
      aria-label={need.title}
      value={need.chosen === null ? NO_MODEL : need.chosen ?? ''}
      onValueChange={(id) => need.onChoose(id === NO_MODEL ? null : id)}
      options={options}
      placeholder="Choose a model"
    />
  )
}

// What the dialog holds, which is only there while it is open: why it could not be made starts over each time.
const UseTemplateContent = ({ title, creator, needs, onUse, onDone }: Omit<UseTemplateDialogProps, 'open' | 'onOpenChange'> & { onDone: () => void }) => {
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  // An agent's model is met by none, which is null; anything else not chosen is undefined.
  const ready = needs.every((need) => need.chosen !== undefined) && !pending

  const use = async () => {
    setProblem(undefined)
    setPending(true)
    try {
      if (await onUse()) onDone()
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <header className="flex items-start gap-3 p-6">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
          <Dialog.Title className="text-lg font-medium text-kumo-default">Use “{title}”</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            {needs.length > 0
              ? 'Set up what it needs with your own accounts and models. It’s made in a new workspace, named after it.'
              : 'It needs nothing set up. It’s made in a new workspace, named after it.'}
            {creator && ` Created by ${creator}: nothing of theirs comes with it.`}
          </Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<Cancel01Icon weight="bold" />} aria-label="Close" disabled={pending} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>

      {needs.length > 0 && (
        <div className="flex min-h-0 flex-col overflow-y-auto px-6">
          <ul aria-label="What it needs" className="flex flex-col rounded-(--surface-radius) bg-kumo-tint p-2">
            {needs.map((need) => (
              <li key={need.key} className="flex items-center gap-3 p-2 text-base">
                {needIcon(need)}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
                  <span className="font-medium wrap-anywhere text-kumo-default">{need.title}</span>
                  {/* Which one, once it is chosen; until then, what it is for. */}
                  {(need.kind === 'connection' && need.chosen) || need.description
                    ? <span className="truncate text-sm text-kumo-subtle">{need.kind === 'connection' && need.chosen ? need.chosen : need.description}</span>
                    : null}
                </span>
                <span className="flex shrink-0 items-center">
                  <NeedControl need={need} pending={pending} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <footer className="flex flex-col gap-3 p-6">
        {problem && <Banner title={`Couldn’t make it: ${problem}`} />}
        <div className="flex items-center justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          <Button variant="primary" disabled={!ready} onClick={() => void use()}>{pending ? 'Making it…' : 'Use template'}</Button>
        </div>
      </footer>
    </>
  )
}

/**
 * Making something of the user's own from a template: each thing it needs on a row, met in place
 * (a model, from a menu) or in the service's own form (a connection, from Choose), with a tick once
 * it is. Use template is ready once everything is met, and makes it in a new workspace.
 */
export const UseTemplateDialog = ({ open, onOpenChange, ...props }: UseTemplateDialogProps) => {
  const [pending, setPending] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
      <UseTemplateContent
        {...props}
        onUse={async () => {
          setPending(true)
          try {
            return await props.onUse()
          } finally {
            setPending(false)
          }
        }}
        onDone={() => onOpenChange(false)}
      />
    </Dialog>
  )
}
