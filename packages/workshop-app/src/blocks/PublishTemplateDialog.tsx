import { useState, type FormEvent } from 'react'
import { ArrowRightIcon, CheckCircleIcon, LayoutIcon, XIcon } from '@phosphor-icons/react'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { LinkButton } from '@/components/LinkButton'
import { TextField } from '@/components/TextField'
import { ListGroup } from './ListGroup'

/** A template published from the gadget's workspace, as the dialog lists it. */
export type PublishedTemplate = {
  id: string
  title: string
  version: number
  /** The gadget has committed changes since it was last published, which can be published to it. */
  changes?: boolean
}

export type PublishTemplateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The gadget's title, which a new template is called unless another is typed. */
  title: string
  /** The templates published from its workspace already, while they are read, or why they could not be. */
  published: { status: 'loading' } | { status: 'ready'; templates: PublishedTemplate[] } | { status: 'failed'; message: string }
  /** Publishes it as a new template, rejecting with why it could not; gives the template's id. */
  onPublish: (template: { title: string; description: string }) => Promise<string>
  /** Publishes what it has committed since to one already published, rejecting with why it could not. */
  onPublishChanges: (id: string) => Promise<void>
  /** Goes to a template's page. */
  onViewTemplate: (id: string) => void
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
const PublishTemplateContent = ({ title: gadgetTitle, published, onPublish, onPublishChanges, onViewTemplate, templateHref }: Omit<PublishTemplateDialogProps, 'open' | 'onOpenChange'>) => {
  const templates = published.status === 'ready' ? published.templates : []
  // Until the user goes elsewhere, a gadget published before starts at what it was published as.
  const [chosen, setChosen] = useState<Step>()
  const step: Step = chosen ?? (templates.length > 0 ? { at: 'list' } : { at: 'form' })
  const [title, setTitle] = useState(gadgetTitle)
  const [description, setDescription] = useState('')
  // What is being published (`new`, or the id of one updated), and why the last could not be.
  const [pending, setPending] = useState<string>()
  const [problem, setProblem] = useState<string>()

  const run = async (what: string, act: () => Promise<Step>) => {
    if (pending) return
    setProblem(undefined)
    setPending(what)
    try {
      setChosen(await act())
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(undefined)
    }
  }
  const publish = (event: FormEvent) => {
    event.preventDefault()
    void run('new', async () => ({ at: 'done', id: await onPublish({ title: title.trim() || gadgetTitle, description: description.trim() }), updated: false }))
  }
  const publishChanges = (id: string) => void run(id, async () => {
    await onPublishChanges(id)
    return { at: 'done', id, updated: true }
  })

  // Until it is known whether it was published before, which is where it starts if it was.
  if (!chosen && published.status === 'loading') {
    return (
      <>
        <Header title={`Publish “${gadgetTitle}”`} description="Anyone you share a template with can make their own from it." />
        <p role="status" className="appears-late grid min-h-32 place-items-center px-6 pb-6 text-base text-kumo-subtle">Checking what it’s been published as…</p>
      </>
    )
  }

  if (step.at === 'done') {
    return (
      <>
        <Header title={step.updated ? 'Changes published' : 'Published'} description={step.updated ? `The template has ${gadgetTitle} as it is now. Anyone who made something from it can update to it.` : `Anyone you share the template with can make their own ${gadgetTitle} from it.`} />
        <div className="flex justify-center px-6 pb-2">
          <CheckCircleIcon aria-hidden="true" weight="fill" className="appears size-12 text-kumo-success" />
        </div>
        <footer className="flex justify-end gap-2 p-6">
          <Dialog.Close render={(props) => <Button {...props}>Done</Button>} />
          <Button variant="primary" icon={ArrowRightIcon} onClick={() => onViewTemplate(step.id)}>View template</Button>
        </footer>
      </>
    )
  }

  if (step.at === 'list') {
    return (
      <>
        <Header title={`Publish “${gadgetTitle}”`} description="It’s been published from this workspace before. Publish its changes to a template, or make a new one." />
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-1">
          <ListGroup label="Published from this workspace">
            {templates.map(({ id, title: templateTitle, version, changes }) => (
              <div key={id} className="flex items-center gap-3 rounded-2xl p-3 text-base">
                <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-base text-kumo-subtle ring-1 ring-kumo-line"><LayoutIcon className="size-5" /></span>
                <span className="flex min-w-0 flex-1 flex-col leading-snug">
                  <LinkButton href={templateHref?.(id)} onClick={() => onViewTemplate(id)} className="max-w-full truncate text-left font-medium text-kumo-default underline-offset-2 hover:underline">
                    {templateTitle}
                  </LinkButton>
                  <span className="truncate text-kumo-subtle">{changes ? `${versionWords(version)} · Has changes to publish` : `${versionWords(version)} · Up to date`}</span>
                </span>
                <Button disabled={!changes || pending !== undefined} onClick={() => publishChanges(id)} className="shrink-0">
                  {pending === id ? 'Publishing…' : 'Publish changes'}
                </Button>
              </div>
            ))}
          </ListGroup>
        </div>
        <footer className="flex flex-col gap-3 p-6">
          {problem && <Banner title={`Couldn’t publish it: ${problem}`} />}
          <div className="flex justify-end gap-2">
            <Button disabled={pending !== undefined} onClick={() => setChosen({ at: 'form' })}>Publish as a new template</Button>
          </div>
        </footer>
      </>
    )
  }

  return (
    <form onSubmit={publish} className="flex min-h-0 flex-col">
      <Header title={`Publish “${gadgetTitle}” as a template`} description="Anyone you share it with can make their own from it, connected to their own accounts. It’s made from what’s been kept, not what’s waiting in a chat." />
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-1">
        {published.status === 'failed' && <Banner title="Couldn’t check what it’s been published as" description={published.message} />}
        <TextField label="Title" autoFocus placeholder={gadgetTitle} value={title} onValueChange={setTitle} />
        <TextField label="What it’s for" rows={3} placeholder="Optional. Shown on the template’s page" value={description} onValueChange={setDescription} />
      </div>
      <footer className="flex flex-col gap-3 p-6">
        {problem && <Banner title={`Couldn’t publish it: ${problem}`} />}
        <div className="flex justify-end gap-2">
          {templates.length > 0
            ? <Button disabled={pending !== undefined} onClick={() => setChosen({ at: 'list' })}>Back</Button>
            : <Dialog.Close render={(props) => <Button {...props} disabled={pending !== undefined}>Cancel</Button>} />}
          <Button type="submit" variant="primary" disabled={pending !== undefined}>{pending === 'new' ? 'Publishing…' : 'Publish'}</Button>
        </div>
      </footer>
    </form>
  )
}

/**
 * Publishing a gadget as a template, over the page. One its workspace has published before starts
 * at those templates, each with the way to publish what the gadget has kept since as its next
 * version; and a new one is a title, its own to start with, and what it is for. Once published it
 * says so, with the way to the template's page.
 */
export const PublishTemplateDialog = ({ open, onOpenChange, ...props }: PublishTemplateDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <PublishTemplateContent {...props} />
  </Dialog>
)
