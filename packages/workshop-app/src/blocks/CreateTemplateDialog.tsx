import { useState, type FormEvent, type ReactNode } from 'react'
import { Cancel01Icon, CheckmarkCircle02Icon, Layout01Icon } from '@/components/icons'
import { Banner, Button, Dialog, LinkButton, ListGroup, TextField } from '@gadgets/ui'
import { CopyLinkButton } from './CopyLinkButton'

/**
 * What a template's gadget has that the template has not released, each only if it has: committed
 * `code`, and `bindings` (what it is connected to, renamed, swapped or given a new note). Releasing
 * the code takes the bindings with it; bindings alone can be sent without a new version.
 */
export type TemplateChanges = { code?: true; bindings?: true }

/** A template made from the gadget's workspace, as the dialog lists it. */
export type MadeTemplate = {
  id: string
  title: string
  /** What it is for, as its page says. */
  description: string
  version: number
  /** What the gadget has changed since the template's last version, which can be released to it. Left out, nothing. */
  changes?: TemplateChanges
}

/** What releasing `changes` is called: a new version for code, the connections alone otherwise. */
export const releaseWords = (changes: TemplateChanges) => changes.code
  ? { action: 'Release update', pending: 'Releasing…', status: 'Has changes to release', done: 'Update released' }
  : { action: 'Update connections', pending: 'Updating…', status: 'Its connections have changed', done: 'Connections updated' }

export type CreateTemplateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The gadget's title, which a new template is called unless another is typed. */
  title: string
  /** The templates made from its workspace already, while they are read, or why they could not be. */
  existing: { status: 'loading' } | { status: 'ready'; templates: MadeTemplate[] } | { status: 'failed'; message: string }
  /** Creates a new template from it, rejecting with why it could not; gives the template's id. */
  onCreate: (template: { title: string; description: string }) => Promise<string>
  /** Releases `changes`, what it has since the template's last version, to a template already made, rejecting with why it could not. */
  onRelease: (id: string, changes: TemplateChanges) => Promise<void>
  /** Goes to a template's page. */
  onViewTemplate: (id: string) => void
  /** The template just made or released to, as the Templates page lists it, for the dialog to show in place of a tick. Left out, there is the tick. */
  renderTemplate?: (id: string) => ReactNode
  /** A template's page, so that it can be opened in another tab. */
  templateHref?: (id: string) => string
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const versionWords = (version: number) => `Version ${version}`

type Step = { at: 'list' } | { at: 'form' } | { at: 'done'; id: string; released?: TemplateChanges }

const Header = ({ title, description }: { title: string; description: string }) => (
  <header className="flex items-start gap-3 p-6 pb-5">
    <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
      <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">{title}</Dialog.Title>
      <Dialog.Description className="text-sm text-pretty text-kumo-subtle">{description}</Dialog.Description>
    </div>
    <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<Cancel01Icon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
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
      setProblem(`Couldn’t ${what === 'new' ? 'create the template' : 'update the template'}: ${messageOf(error)}`)
    } finally {
      setPending(undefined)
    }
  }
  const create = (event: FormEvent) => {
    event.preventDefault()
    void run('new', async () => ({ at: 'done', id: await onCreate({ title: title.trim() || gadgetTitle, description: description.trim() }) }))
  }
  const release = (id: string, changes: TemplateChanges) => void run(id, async () => {
    await onRelease(id, changes)
    return { at: 'done', id, released: changes }
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
        <Header
          title={step.released ? releaseWords(step.released).done : 'Template created'}
          description={!step.released
            ? `Anyone you share the template with can make their own ${gadgetTitle} from it.`
            : step.released.code
              ? `The template has ${gadgetTitle} as it is now. Anyone who made something from it can update to it.`
              : `The template asks for what ${gadgetTitle} is connected to now. Its code and version stay as they were.`}
        />
        {card ? <div className="appears px-6 py-4">{card}</div> : (
          <div className="flex justify-center px-6 pb-2">
            <CheckmarkCircle02Icon aria-hidden="true" weight="fill" className="appears size-12 text-kumo-success" />
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
                <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-base text-kumo-subtle ring-1 ring-kumo-line"><Layout01Icon className="size-5" /></span>
                <span className="flex min-w-0 flex-1 flex-col leading-snug">
                  <LinkButton href={templateHref?.(id)} onClick={() => onViewTemplate(id)} className="max-w-full truncate text-left font-medium text-kumo-default underline-offset-2 hover:underline">
                    {templateTitle}
                  </LinkButton>
                  <span className="truncate text-kumo-subtle">{`${versionWords(version)} · ${changes ? releaseWords(changes).status : 'Up to date'}`}</span>
                </span>
                {changes && (
                  <Button variant="primary" disabled={pending !== undefined} onClick={() => release(id, changes)} className="shrink-0">
                    {pending === id ? releaseWords(changes).pending : releaseWords(changes).action}
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
