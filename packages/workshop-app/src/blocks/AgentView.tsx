import { useState, type ReactNode } from 'react'
import { ChatCircleIcon, RobotIcon } from '@phosphor-icons/react'
import { EditableTitle } from '@/components/EditableTitle'
import { LinkButton } from '@/components/LinkButton'
import { ListGroup } from './ListGroup'
import { MenuChooser, type MenuChoice } from './MenuChooser'
import { SettingsGroup, SettingsRow } from './SettingsGroup'

/** Somewhere the page links to: a gadget or chat that calls on it, or one of its runs. */
export type AgentViewLink = { title: string; href?: string; onOpen: () => void }

/** One of its runs, as listed: the conversation it had. */
export type AgentViewRun = AgentViewLink & {
  key: string
  /** When it was last active, as the app says it. */
  time?: string
  /** It stopped on something only a person can decide. */
  waiting?: boolean
}

export type AgentViewProps = {
  name: string
  /** Renames it; absent where the viewer cannot. */
  onRename?: (name: string) => Promise<void>
  /** The models it can think with; `undefined` while they are read. */
  models?: readonly MenuChoice[]
  /** The model it thinks with; `null` when its runs only collect what they are given, for a person. */
  modelId: string | null
  /** Its model's name, for when the viewer's models don't include it. */
  modelName?: string
  /** Changes its model; absent where the viewer cannot. */
  onModelChange?: (modelId: string) => Promise<void>
  /** The gadgets and chats that call on it. */
  calledBy: AgentViewLink[]
  /** What each run can use, by what it is. */
  access: string[]
  /** Its runs, latest first, grouped by when. */
  runs: { key: string; label: string; runs: AgentViewRun[] }[]
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h2 className="px-4 text-sm font-medium text-kumo-subtle">{title}</h2>
    {children}
  </section>
)

// Places, said as links in a sentence: "Tip jar and Inbox".
const Links = ({ links }: { links: AgentViewLink[] }) => (
  <>
    {links.map((link, at) => (
      <span key={`${at}:${link.title}`}>
        {at > 0 && (at === links.length - 1 ? ' and ' : ', ')}
        <LinkButton href={link.href} onClick={link.onOpen} className="rounded-sm text-kumo-default underline decoration-kumo-line underline-offset-2 outline-none hover:decoration-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-ring">
          {link.title}
        </LinkButton>
      </span>
    ))}
  </>
)

const RunRow = ({ title, time, waiting, href, onOpen }: Omit<AgentViewRun, 'key'>) => (
  <LinkButton href={href} onClick={onOpen} className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-base outline-none hover:bg-kumo-contrast/5 focus-visible:ring-2 focus-visible:ring-kumo-ring">
    <ChatCircleIcon aria-hidden="true" className="size-5 shrink-0 text-kumo-default" />
    <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{title}</span>
    {waiting && (
      <span className="flex shrink-0 items-center gap-1.5 text-sm text-kumo-warning">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-kumo-warning" />
        Waits on you
      </span>
    )}
    {time && <span className="shrink-0 text-kumo-subtle">{time}</span>}
  </LinkButton>
)

/**
 * An agent, on a page of its own: one that works on its own each time a gadget, a schedule or a
 * chat calls on it, each run a conversation of its own. Its name, which can be changed in place,
 * and how many runs it has had and wait on a person; then how it works (the model it thinks with,
 * and the gadgets and chats that call on it), what each run can use, and its conversations by when,
 * those waiting on a person marked, each opening as any chat does.
 */
export const AgentView = ({ name, onRename, models, modelId, modelName, onModelChange, calledBy, access, runs }: AgentViewProps) => {
  const [problem, setProblem] = useState<string>()
  const [pending, setPending] = useState(false)
  const all = runs.flatMap((group) => group.runs)
  const waiting = all.filter((run) => run.waiting).length

  const run = async (change: () => Promise<void>) => {
    setProblem(undefined)
    setPending(true)
    try {
      await change()
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  // The model it has, among those offered, though the viewer's models don't include it.
  const choices = models && modelId !== null && !models.some(({ id }) => id === modelId)
    ? [...models, { id: modelId, name: modelName ?? modelId }]
    : models

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-8">
      <div className="flex flex-col items-center gap-2 pt-8 text-center">
        <span aria-hidden="true" className="grid size-14 place-items-center rounded-full bg-kumo-contrast/7 text-kumo-default">
          <RobotIcon className="size-7" />
        </span>
        {onRename
          ? <h1 className="max-w-full"><EditableTitle value={name} onRename={(next) => void run(() => onRename(next))} aria-label="Agent name" className="text-center text-xl font-medium text-kumo-default" /></h1>
          : <h1 className="text-xl font-medium text-kumo-default">{name}</h1>}
        <p className="text-base/5 text-kumo-subtle">
          {all.length === 0 ? 'Hasn’t run yet' : all.length === 1 ? 'One run' : `${all.length} runs`}
          {waiting > 0 && <span className="text-kumo-warning"> · {waiting === 1 ? 'one waits on you' : `${waiting} wait on you`}</span>}
        </p>
        {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
      </div>

      <Section title="How it works">
        <SettingsGroup label="How it works">
          <SettingsRow
            title="Thinks with"
            description={modelId === null ? 'No model: each run waits in its conversation for a person to pick it up.' : 'Each run uses this model, on your account.'}
            control={choices === undefined
              ? <span role="status" className="appears-late text-sm text-kumo-subtle">Reading models…</span>
              : onModelChange && !pending
                ? <MenuChooser choices={choices} value={modelId} onChoose={(id) => { if (id && id !== modelId) void run(() => onModelChange(id)) }} label="Model" placeholder="Choose a model" />
                : <span className="text-base text-kumo-default">{choices.find(({ id }) => id === modelId)?.name ?? modelName ?? 'None'}</span>}
          />
          <SettingsRow
            title="Called on by"
            description={calledBy.length > 0
              ? <><Links links={calledBy} />, whenever {calledBy.length === 1 ? 'it needs' : 'they need'} it.</>
              : 'Nothing yet. Ask in a chat for a gadget or a schedule to call on it.'}
          />
        </SettingsGroup>
      </Section>

      <Section title="What it can use">
        {access.length > 0 ? (
          <SettingsGroup label="What it can use">
            {access.map((title) => <SettingsRow key={title} title={title} />)}
          </SettingsGroup>
        ) : (
          <p className="rounded-3xl bg-kumo-tint px-5 py-4 text-base/6 text-kumo-subtle">
            Nothing yet. A chat can give it more, which you’re asked to accept.
          </p>
        )}
      </Section>

      <Section title="Conversations">
        {all.length === 0 ? (
          <p className="rounded-3xl bg-kumo-tint px-5 py-4 text-base/6 text-kumo-subtle">
            Each time it’s called on, what it does is kept here as a conversation you can look in on.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {runs.map((group) => (
              <ListGroup key={group.key} label={group.label}>
                {group.runs.map(({ key, ...each }) => <RunRow key={key} {...each} />)}
              </ListGroup>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
