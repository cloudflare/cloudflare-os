import { useState, type FormEvent, type ReactNode } from 'react'
import { CheckCircleIcon, LayoutIcon, XIcon } from '@phosphor-icons/react'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { LinkButton } from '@/components/LinkButton'
import { TextField } from '@/components/TextField'
import { CopyLinkButton } from './CopyLinkButton'
import { ListGroup } from './ListGroup'

/** A template made from the gadget's workspace, as the dialog lists it. */
export type MadeTemplate = {
  id: string
  title: string
  /** What it is for, as its page says. */
  description: string
  version: number
  /** The gadget has committed changes since the template's last version, which can be released as its next. */
  changes?: boolean
}

export type CreateTemplateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The gadget's title, which a new template is called unless another is typed. */
  title: string
  /** The templates made from its workspace already, while they are read, or why they could not be. */
  existing: { status: 'loading' } | { status: 'ready'; templates: MadeTemplate[] } | { status: 'failed'; message: string }
  /** Creates a new template from it, rejecting with why it could not; gives the template's id. */
  onCreate: (template: { title: string; description: string }) => Promise<string>
  /** Releases what it has committed since as the next version of a template already made, rejecting with why it could not. */
  onRelease: (id: string) => Promise<void>
  /** Goes to a template's page. */
  onViewTemplate: (id: string) => void
  /** The template just made or released to, as the Templates page lists it, for the dialog to show in place of a tick. Left out, there is the tick. */
  renderTemplate?: (id: string) => ReactNode
  /** A template's page, so that it can be opened in another tab. */
  templateHref?: (id: string) => string
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const versionWords = (version: number) => `Version ${version}`

type Step = { at: 'list' } | { at: 'form' } | { at: 'done'; id: string; updated: boolean }

const Header = ({ title, description }: { title: string; description: string }) => (
  <header className="flex items-start gap-3 p-6 pb-5">
    <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
      <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">{title}</Dialog.Title>
      <Dialog.Description className="text-sm text-pretty text-kumo-subtle">{description}</Dialog.Description>
    </div>
    <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
  </header>
)

// What the dialog holds while it is open, which starts over each time it is opened.
const CreateTemplateContent = ({ title: gadgetTitle, existing, onCreate, onRelease, onViewTemplate, renderTemplate, templateHref, onDone }: Omit<CreateTemplateDialogProps, 'open' | 'onOpenChange'> & { onDone: () => void }) => {
  const templates = existing.status === 'ready' ? existing.templates : []
  // Until the user goes elsewhere, a gadget with templates already starts at them.
  const [chosen, setChosen] = useState<Step>()
  const step: Step = chosen ?? (templates.length > 0 ? { at: 'list' } : { at: 'form' })
  const [title, setTitle] = useState(gadgetTitle)
  const [description, setDescription] = useState('')
  // What is being done (`new`, or the id of the template released to), and why the last could not be.
  const [pending, setPending] = useState<string>()
  const [problem, setProblem] = useState<string>()

  const run = async (what: string, act: () => Promise<Step>) => {
    if (pending) return
    setProblem(undefined)
    setPending(what)
    try {
      const next = await act()
      setChosen(next)
      if (next.at === 'done') onDone()
    } catch (error) {
      setProblem(`Couldn’t ${what === 'new' ? 'create the template' : 'release the update'}: ${messageOf(error)}`)
    } finally {
      setPending(undefined)
    }
  }
  const create = (event: FormEvent) => {
    event.preventDefault()
    void run('new', async () => ({ at: 'done', id: await onCreate({ title: title.trim() || gadgetTitle, description: description.trim() }), updated: false }))
  }
  const release = (id: string) => void run(id, async () => {
    await onRelease(id)
    return { at: 'done', id, updated: true }
  })

  // Until it is known whether it has templates already, which is where it starts if it has.
  if (!chosen && existing.status === 'loading') {
    return (
      <>
        <Header title={`Create template from “${gadgetTitle}”`} description="Anyone you share a template with can make their own copy from it." />
        <p role="status" className="appears-late grid min-h-32 place-items-center px-6 pb-6 text-base text-kumo-subtle">Checking for templates already made from it…</p>
      </>
    )
  }

  if (step.at === 'done') {
    const card = renderTemplate?.(step.id)
    return (
      <>
        <Header title={step.updated ? 'Update released' : 'Template created'} description={step.updated ? `The template has ${gadgetTitle} as it is now. Anyone who made something from it can update to it.` : `Anyone you share the template with can make their own ${gadgetTitle} from it.`} />
        {card ? <div className="appears px-6 py-4">{card}</div> : (
          <div className="flex justify-center px-6 pb-2">
            <CheckCircleIcon aria-hidden="true" weight="fill" className="appears size-12 text-kumo-success" />
          </div>
        )}
        <footer className="flex justify-end gap-2 p-6">
          <Button onClick={() => onViewTemplate(step.id)}>View template</Button>
          {templateHref && <CopyLinkButton labelled primary withoutIcon link={new URL(templateHref(step.id), window.location.href).href} title={gadgetTitle} />}
        </footer>
      </>
    )
  }

  if (step.at === 'list') {
    return (
      <>
        <Header title="Your template" description="This workspace has a template already. Release what has been kept since as its next version." />
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-1">
          <ListGroup label="Made from this workspace">
            {templates.map(({ id, title: templateTitle, version, changes }) => (
              <div key={id} className="flex items-center gap-3 rounded-2xl p-3 text-base">
                <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-base text-kumo-subtle ring-1 ring-kumo-line"><LayoutIcon className="size-5" /></span>
                <span className="flex min-w-0 flex-1 flex-col leading-snug">
                  <LinkButton href={templateHref?.(id)} onClick={() => onViewTemplate(id)} className="max-w-full truncate text-left font-medium text-kumo-default underline-offset-2 hover:underline">
                    {templateTitle}
                  </LinkButton>
                  <span className="truncate text-kumo-subtle">{changes ? `${versionWords(version)} · Has changes to release` : `${versionWords(version)} · Up to date`}</span>
                </span>
                {changes && (
                  <Button variant="primary" disabled={pending !== undefined} onClick={() => release(id)} className="shrink-0">
                    {pending === id ? 'Releasing…' : 'Release update'}
                  </Button>
                )}
              </div>
            ))}
          </ListGroup>
        </div>
        <footer className="flex flex-col gap-3 p-6">
          {problem && <Banner title={problem} />}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={(props) => <Button {...props} disabled={pending !== undefined}>Done</Button>} />
          </div>
        </footer>
      </>
    )
  }

  return (
    <form onSubmit={create} className="flex min-h-0 flex-col">
      <Header title={`Create template from “${gadgetTitle}”`} description="Anyone you share it with can make their own copy from it, connected to their own accounts. It’s made from what’s been kept, not what’s waiting in a chat." />
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-1">
        {existing.status === 'failed' && <Banner title="Couldn’t check for templates already made from it" description={existing.message} />}
        <TextField label="Title" autoFocus placeholder={gadgetTitle} value={title} onValueChange={setTitle} />
        <TextField label="What it’s for" rows={3} placeholder="Optional. Shown on the template’s page" value={description} onValueChange={setDescription} />
      </div>
      <footer className="flex flex-col gap-3 p-6">
        {problem && <Banner title={problem} />}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} disabled={pending !== undefined}>Cancel</Button>} />
          <Button type="submit" variant="primary" disabled={pending !== undefined}>{pending === 'new' ? 'Creating…' : 'Create'}</Button>
        </div>
      </footer>
    </form>
  )
}

/**
 * Creating a template from a gadget, over the page: a title, the gadget's own to start with, and
 * what it is for. There is one template to an app, so a workspace that has one starts at it
 * instead, with the way to release what has been kept since as its next version, and no way to
 * make another. Once made or released it says so, with the way to the template's page.
 */
export const CreateTemplateDialog = ({ open, onOpenChange, ...props }: CreateTemplateDialogProps) => {
  // Once it has made or released something, which is a card and a few words, it is as narrow as they are.
  const [done, setDone] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setDone(false); onOpenChange(next) }} narrow={done}>
      <CreateTemplateContent {...props} onDone={() => setDone(true)} />
    </Dialog>
  )
}
