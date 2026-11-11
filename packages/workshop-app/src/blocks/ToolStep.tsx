import {
  CodeIcon, FileIcon, GitBranchIcon, GlobeIcon, LinkSimpleIcon, ListBulletsIcon, MagnifyingGlassIcon,
  PencilSimpleIcon, PlusIcon, StopIcon, BookOpenIcon, type Icon,
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

/** One step of the agent's work: a tool it called, or a resource that call read. */
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

export type ToolStepProps = { entry: ToolStepEntry; open: boolean; onToggle: () => void }

const Detail = ({ entry }: { entry: ToolStepEntry }) => {
  if (entry.type === 'observation') {
    const { resource } = entry
    return (
      <>
        {resource && <ResourceLink {...resource} />}
        {entry.description && <div className="text-sm text-kumo-default"><Markdown>{entry.description}</Markdown></div>}
        <ActionFields fields={entry.fields} />
      </>
    )
  }
  return (
    <>
      {entry.reasoning && <div className="text-sm text-kumo-subtle"><Markdown>{entry.reasoning}</Markdown></div>}
      {entry.error && <CodeBlock label="Error" tone="danger">{entry.error}</CodeBlock>}
      {entry.sections.map(({ label, text }) => <CodeBlock key={label} label={label}>{text}</CodeBlock>)}
    </>
  )
}

/** A step as one quiet line, which opens to show what it did when there is more to show. */
export const ToolStep = ({ entry, open, onToggle }: ToolStepProps) => {
  const StepIcon = entry.type === 'call' ? ICONS[entry.icon] ?? CodeIcon : BookOpenIcon
  const call = entry.type === 'call' ? entry : undefined
  const line = (
    <>
      <StepIcon aria-hidden="true" className="size-5 shrink-0" />
      <span className={cn('min-w-0 truncate', call?.running && 'animate-pulse motion-reduce:animate-none')}>{entry.label}</span>
      {call?.error && <Badge variant="error">Error</Badge>}
    </>
  )
  const hasDetail = !call || !!call.error || !!call.reasoning || call.sections.length > 0

  if (!hasDetail) {
    return <div role={call?.running ? 'status' : undefined} className="flex items-center gap-2 px-2 py-1 text-base/5 text-kumo-subtle">{line}</div>
  }
  return (
    <Disclosure open={open} onToggle={onToggle} summary={line}>
      <div className="ms-4 mt-1 mb-2 flex flex-col gap-3 border-s-2 border-kumo-line ps-4">
        <Detail entry={entry} />
      </div>
    </Disclosure>
  )
}
