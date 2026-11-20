import { useState, type ReactNode } from 'react'
import { LayoutIcon, XIcon } from '@phosphor-icons/react'
import { Banner, Button, Dialog, Select } from '@gadgets/ui'
import type { SetupModel } from './UseTemplateDialog'

/** The template a gadget follows, as it now stands. */
export type UpdateTemplate = {
  title: string
  /** What it is for. */
  description?: string
  version: number
  /** Whether the gadget has its latest version yet, where that can be told. */
  status?: 'available' | 'upToDate'
}

/**
 * How asking for the update went: proposed in a new chat (which whoever asked then goes to), nothing
 * proposed and why, or not tried, as over a lost connection, which says so itself.
 */
export type UpdateFromTemplateOutcome =
  | { outcome: 'proposed' }
  | { outcome: 'blocked' }
  /** It has the latest version already. */
  | { outcome: 'upToDate' }
  /** It shares no history with the template, so that it can only be merged over a guess, once the user is warned. */
  | { outcome: 'unrelated' }
  /** The version the two have in common cannot be read to merge against. */
  | { outcome: 'baseUnavailable' }
  | { outcome: 'failed'; message: string }

export type UpdateFromTemplateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The gadget's title. */
  gadget: string
  /** The template it follows: undefined while it is read, null once it is not there any more. */
  template?: UpdateTemplate | null
  /** The user's models, any of which can review the update; none given, they are still being read. */
  models?: readonly SetupModel[]
  /** The id of the model that reviews it, null for none, undefined until one is known. */
  reviewer?: string | null
  onReviewerChange: (id: string | null) => void
  /** Asks for the update, holding the dialog while it is worked out, `allowUnrelated` once warned. */
  onUpdate: (allowUnrelated: boolean) => Promise<UpdateFromTemplateOutcome>
}

// What stands for no agent at all, among the ids of the models.
const NO_AGENT = ''

// The merge is kept as the smallest difference, which is slow to find between files that share little.
const WORKING = 'Working out the update. This can take a few minutes for a template that has little in common with the gadget.'

const STATUS = { available: 'Update available', upToDate: 'Up to date' }

type Ended = Exclude<UpdateFromTemplateOutcome, { outcome: 'proposed' | 'blocked' }>

const Header = ({ title, description, pending }: { title: string; description: string; pending: boolean }) => (
  <header className="flex items-start gap-3 p-6">
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
      <Dialog.Title className="text-lg font-medium text-kumo-default">{title}</Dialog.Title>
      <Dialog.Description className="text-sm text-pretty text-kumo-subtle">{description}</Dialog.Description>
    </div>
    <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" disabled={pending} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
  </header>
)

const Footer = ({ pending, children }: { pending: boolean; children: ReactNode }) => (
  <div className="flex items-center justify-between gap-3">
    <p role="status" className="min-w-0 text-sm text-pretty text-kumo-subtle">{pending && WORKING}</p>
    <div className="flex shrink-0 items-center gap-2">{children}</div>
  </div>
)

// What the dialog holds, which is only there while it is open: how the last ask went starts over each time.
const UpdateContent = ({ gadget, template, models, reviewer, onReviewerChange, onUpdate }: Omit<UpdateFromTemplateDialogProps, 'open' | 'onOpenChange'>) => {
  const [pending, setPending] = useState(false)
  const [ended, setEnded] = useState<{ outcome: Ended; allowUnrelated: boolean }>()
  const ready = template != null && reviewer !== undefined && !pending

  const update = async (allowUnrelated: boolean) => {
    setPending(true)
    try {
      const result = await onUpdate(allowUnrelated)
      if (result.outcome !== 'proposed' && result.outcome !== 'blocked') setEnded({ outcome: result, allowUnrelated })
    } finally {
      setPending(false)
    }
  }

  const name = template ? `“${template.title}”` : 'its template'
  if (ended?.outcome.outcome === 'unrelated') {
    return (
      <>
        <Header title="Unrelated template" description={`This gadget shares no history with ${name}.`} pending={pending} />
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-6">
          <Banner
            title="Your own changes may be undone"
            description="With no version in common, the update has to be merged against a guess at what this gadget was built from. A change of yours that the guess happens to include looks like something the template removed, and is undone without a conflict being reported."
          />
          <p className="text-sm text-pretty text-kumo-subtle">The update opens in a new chat, where you can check the result before accepting it. Nothing changes until you do.</p>
        </div>
        <footer className="p-6">
          <Footer pending={pending}>
            {/* The button that led here is gone, and took the focus with it. */}
            <Button autoFocus disabled={pending} onClick={() => setEnded(undefined)}>Back</Button>
            <Button variant="primary" disabled={pending} onClick={() => void update(true)}>{pending ? 'Preparing update…' : 'Update anyway'}</Button>
          </Footer>
        </footer>
      </>
    )
  }

  const outcome = ended?.outcome
  const options = [...(models ?? []).map(({ id, name: label }) => ({ id, label })), { id: NO_AGENT, label: 'No agent' }]
  return (
    <>
      <Header
        title="Update from template"
        description={`Merge the latest version of ${name} into ${gadget || 'this gadget'}. The update opens in a new chat, where you can try it before accepting it.`}
        pending={pending}
      />
      <div className="flex min-h-0 flex-col overflow-y-auto px-6">
        <div className="flex flex-col rounded-(--surface-radius) bg-kumo-tint p-2">
          <div className="flex items-start gap-3 p-2 text-base">
            <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-kumo-fill text-kumo-default">
              <LayoutIcon className="size-5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
              {template === undefined ? <span role="status" className="appears-late py-2.5 text-sm text-kumo-subtle">Reading the template…</span>
                : template === null ? (
                    <>
                      <span className="font-medium text-kumo-default">Its template is gone</span>
                      <span className="text-sm text-pretty text-kumo-subtle">The template this gadget follows is no longer available, so there is nothing to update it from.</span>
                    </>
                  ) : (
                    <>
                      <span className="font-medium wrap-anywhere text-kumo-default">{template.title}</span>
                      <span className="text-sm text-kumo-subtle">
                        Version {template.version}
                        {template.status && <>{' · '}<span className={template.status === 'available' ? 'text-kumo-brand' : undefined}>{STATUS[template.status]}</span></>}
                      </span>
                      {template.description && <span className="line-clamp-2 text-sm text-pretty text-kumo-subtle">{template.description}</span>}
                    </>
                  )}
            </span>
          </div>
          <div className="flex items-center gap-3 p-2 text-base">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
              <span className="font-medium text-kumo-default">Reviewing agent</span>
              <span className="text-sm text-pretty text-kumo-subtle">If you’ve customized this gadget, this agent makes sure your customizations work with the new version. Choose “No agent” to check them yourself.</span>
            </span>
            <span className="flex shrink-0 items-center">
              {models === undefined
                ? <span role="status" className="appears-late pe-2 text-sm text-kumo-subtle">Reading your models…</span>
                : <Select aria-label="Reviewing agent" value={reviewer === null ? NO_AGENT : reviewer ?? ''} onValueChange={(id) => onReviewerChange(id === NO_AGENT ? null : id)} options={options} placeholder="Choose a model" />}
            </span>
          </div>
        </div>
      </div>
      <footer className="flex flex-col gap-3 p-6">
        {outcome?.outcome === 'upToDate' && <p role="status" className="px-2 text-sm text-pretty text-kumo-default">Already up to date: this gadget has the latest version of {name}.</p>}
        {outcome?.outcome === 'baseUnavailable' && (
          <Banner title="This update can’t be merged" description={`This gadget and ${name} have an earlier version in common, but its files aren’t available to merge against.`} />
        )}
        {outcome?.outcome === 'failed' && (
          <Banner
            title="The update couldn’t be prepared"
            description={outcome.message}
            action={{ label: 'Try again', disabled: pending, onSelect: () => void update(ended?.allowUnrelated ?? false) }}
          />
        )}
        <Footer pending={pending}>
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          <Button variant="primary" disabled={!ready} onClick={() => void update(false)}>{pending ? 'Preparing update…' : 'Update'}</Button>
        </Footer>
      </footer>
    </>
  )
}

/**
 * Proposes merging the latest version of the template a gadget follows into it: what that version
 * is, with whether the gadget has it, and the model that makes sure the gadget's own changes work
 * with it, or none. The update is worked out in a new chat, where it is tried and then accepted,
 * so nothing here changes the gadget. Where nothing was proposed it says why: it was up to date,
 * the two cannot be merged, or it could not be asked, with the way to try again. A gadget that
 * shares no history with its template is warned of first, in the dialog's place, and merged over a
 * guess only once Update anyway is chosen.
 */
export const UpdateFromTemplateDialog = ({ open, onOpenChange, ...props }: UpdateFromTemplateDialogProps) => {
  const [pending, setPending] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
      <UpdateContent
        {...props}
        onUpdate={async (allowUnrelated) => {
          setPending(true)
          try {
            return await props.onUpdate(allowUnrelated)
          } finally {
            setPending(false)
          }
        }}
      />
    </Dialog>
  )
}
