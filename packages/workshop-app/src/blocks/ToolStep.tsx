import {
  BookOpenIcon, BrainIcon, ChatTextIcon, CodeIcon, FileIcon, GitBranchIcon, GlobeIcon, LinkSimpleIcon, ListBulletsIcon,
  MagnifyingGlassIcon, PencilSimpleIcon, PlusIcon, StopIcon, type Icon,
} from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Badge } from '@cloudflare/kumo'
import { CodeBlock } from '@/components/CodeBlock'
import { Disclosure } from '@/components/Disclosure'
import { Markdown } from '@/components/Markdown'
import { ActionFields, type ActionField } from './ActionFields'
import { ResourceLink, type ResourceLinkProps } from './ResourceLink'

const ICONS = {
  file: FileIcon,
  edit: PencilSimpleIcon,
  terminal: CodeIcon,
  globe: GlobeIcon,
  search: MagnifyingGlassIcon,
  link: LinkSimpleIcon,
  plus: PlusIcon,
  branch: GitBranchIcon,
  list: ListBulletsIcon,
  stop: StopIcon,
} satisfies Record<string, Icon>

/**
 * One step in the making of a reply: a tool the agent called, a resource that call read, or what
 * it is doing right now, which is thinking or writing the reply.
 */
export type ToolStepEntry =
  | {
      type: 'call'
      key: string
      icon: keyof typeof ICONS
      label: string
      error?: string
      /** What the agent thought before this step. */
      reasoning?: string
      /** Titled blocks of literal text, such as the code and its output. */
      sections: { label: string; text: string }[]
      /** Still being written or run. */
      running?: boolean
    }
  | {
      type: 'observation'
      key: string
      label: string
      resource?: ResourceLinkProps
      description: string
      fields: ActionField[]
    }
  /** What was thought before something was said, or has been so far while it is `running`. */
  | { type: 'thinking'; key: string; text: string; running?: boolean }
  /** The reply as far as it has been drafted. */
  | { type: 'writing'; key: string; text: string }

export type ToolStepProps = { entry: ToolStepEntry; open: boolean; onToggle: () => void }

const Detail = ({ entry }: { entry: ToolStepEntry }) => {
  if (entry.type === 'thinking') return <div className="text-sm/5 text-kumo-subtle"><Markdown>{entry.text}</Markdown></div>
  if (entry.type === 'writing') return <div className="text-base/5 text-kumo-default"><Markdown>{entry.text}</Markdown></div>
  if (entry.type === 'observation') {
    const { resource } = entry
    return (
      <>
        {resource && <ResourceLink {...resource} />}
        {entry.description && <div className="text-sm/5 text-kumo-default"><Markdown>{entry.description}</Markdown></div>}
        <ActionFields fields={entry.fields} />
      </>
    )
  }
  return (
    <>
      {entry.reasoning && <div className="text-sm/5 text-kumo-subtle"><Markdown>{entry.reasoning}</Markdown></div>}
      {entry.error && <CodeBlock label="Error" tone="danger">{entry.error}</CodeBlock>}
      {entry.sections.map(({ label, text }) => <CodeBlock key={label} label={label}>{text}</CodeBlock>)}
    </>
  )
}

const summaryOf = (entry: ToolStepEntry): { icon: Icon; label: string } => {
  switch (entry.type) {
    case 'thinking':
      return { icon: BrainIcon, label: entry.running ? 'Thinking…' : 'Thought' }
    case 'writing':
      return { icon: ChatTextIcon, label: 'Writing…' }
    case 'observation':
      return { icon: BookOpenIcon, label: entry.label }
    case 'call':
      return { icon: ICONS[entry.icon] ?? CodeIcon, label: entry.label }
  }
}

const hasDetail = (entry: ToolStepEntry) => {
  switch (entry.type) {
    case 'thinking':
    case 'writing':
      return entry.text !== ''
    case 'observation':
      return true
    case 'call':
      return !!entry.error || !!entry.reasoning || entry.sections.length > 0
  }
}

/** Whether a step is what is happening right now, rather than something done. */
export const isUnderWay = (entry: ToolStepEntry) =>
  entry.type === 'writing' || ((entry.type === 'call' || entry.type === 'thinking') && !!entry.running)

/** A step as one quiet line, which opens to show what it did when there is more to show. */
export const ToolStep = ({ entry, open, onToggle }: ToolStepProps) => {
  const { icon: StepIcon, label } = summaryOf(entry)
  const line = (
    <>
      <StepIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className={cn('min-w-0 truncate', isUnderWay(entry) && 'animate-pulse motion-reduce:animate-none')}>{label}</span>
      {entry.type === 'call' && entry.error && <Badge variant="error">Error</Badge>}
    </>
  )

  if (!hasDetail(entry)) {
    return <div className="flex items-center gap-2 px-2 py-1 text-sm/5 text-kumo-subtle">{line}</div>
  }
  return (
    <Disclosure open={open} onToggle={onToggle} summary={line} className="text-sm/5">
      <div className="ms-4 mt-1 mb-2 flex flex-col gap-3 border-s-2 border-kumo-line ps-3.5">
        <Detail entry={entry} />
      </div>
    </Disclosure>
  )
}
