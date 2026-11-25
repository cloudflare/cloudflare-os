import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Badge, Loader } from '@cloudflare/kumo'
import { CodeBlock } from '@/components/CodeBlock'
import {
  ArrowDown01Icon, BookOpen01Icon, Brain03Icon, Chat01Icon, CodeIcon, Edit02Icon, File01Icon, GitBranchIcon, GlobeIcon, Link01Icon,
  ListIcon, PlugIcon, PlusSignIcon, Search01Icon, StopIcon, type Icon,
} from '@/components/icons'
import { ShimmerSwitchText } from '@/components/ShimmerSwitchText'
import { Disclosure } from '@/components/Disclosure'
import { Markdown, useReducedMotion } from '@gadgets/ui'
import { SmoothHeight } from '@/components/SmoothHeight'
import { ActionFields, type ActionField } from './ActionFields'
import type { AnswerPart } from './AssistantMessage'
import { InlineViewDraft } from './InlineView'
import { ResourceLink, type ResourceLinkProps } from './ResourceLink'
import './ToolStep.css'

// A step's mark is the icon of what it did.
const ICONS = {
  file: File01Icon,
  edit: Edit02Icon,
  terminal: CodeIcon,
  globe: GlobeIcon,
  search: Search01Icon,
  link: Link01Icon,
  plus: PlusSignIcon,
  branch: GitBranchIcon,
  list: ListIcon,
  stop: StopIcon,
  plug: PlugIcon,
} satisfies Record<string, Icon>
const Thinking = Brain03Icon
const Writing = Chat01Icon
const Observation = BookOpen01Icon

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
  /** The reply as far as it has been drafted, with the views in it apart where it has any. */
  | { type: 'writing'; key: string; text: string; parts?: AnswerPart[] }

export type ToolStepProps = {
  entry: ToolStepEntry
  open: boolean
  onToggle: () => void
  /** The step came after the log was first shown: its row opens to its height as it comes in, rather than being there. */
  fresh?: boolean
}

/** What a step did. */
const Detail = ({ entry }: { entry: ToolStepEntry }) => {
  const text = 'text-[13px]/4.5'
  if (entry.type === 'thinking') return <div className={cn(text, 'text-kumo-subtle')}><Markdown>{entry.text}</Markdown></div>
  if (entry.type === 'writing') {
    return (
      // A draft, which is not yet the message: set apart by a rule beside it, quiet and in the size of the
      // rest of what a step shows, not the message's own, so that it is not mistaken for the reply as it
      // will be said.
      <div className={cn('flex flex-col gap-3 border-s-2 border-kumo-line ps-3 text-kumo-subtle', text)}>
        {(entry.parts ?? [{ type: 'text', text: entry.text }]).map((part, index) =>
          part.type === 'text'
            ? <Markdown key={index}>{part.text}</Markdown>
            : <InlineViewDraft key={index} title={part.title} drawing={part.drawing} />)}
      </div>
    )
  }
  if (entry.type === 'observation') {
    const { resource } = entry
    return (
      <>
        {resource && <ResourceLink {...resource} />}
        {entry.description && <div className={cn(text, 'text-kumo-default')}><Markdown>{entry.description}</Markdown></div>}
        <ActionFields fields={entry.fields} />
      </>
    )
  }
  return (
    <>
      {entry.reasoning && <div className={cn(text, 'text-kumo-subtle')}><Markdown>{entry.reasoning}</Markdown></div>}
      {entry.error && <CodeBlock label="Error" tone="danger">{entry.error}</CodeBlock>}
      {entry.sections.map(({ label, text }) => <CodeBlock key={label} label={label}>{text}</CodeBlock>)}
    </>
  )
}

const summaryOf = (entry: ToolStepEntry): { icon: Icon; label: string } => {
  switch (entry.type) {
    case 'thinking':
      return { icon: Thinking, label: entry.running ? 'Thinking…' : 'Thought' }
    case 'writing':
      return { icon: Writing, label: 'Writing…' }
    case 'observation':
      return { icon: Observation, label: entry.label }
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

/**
 * Kumo's spinner, 16px, the size of the icons. It turns by an animation
 * inside its own SVG, which the app's motion level (off) cannot reach by CSS, so it is paused there
 * through the SVG.
 */
const StepSpinner = () => {
  const box = useRef<HTMLSpanElement>(null)
  const reduced = useReducedMotion()
  useLayoutEffect(() => {
    const svg = box.current?.querySelector('svg')
    if (reduced) svg?.pauseAnimations?.()
    else svg?.unpauseAnimations?.()
  }, [reduced])
  return (
    <span ref={box} className="contents">
      <Loader size="sm" aria-label="In progress" />
    </span>
  )
}

/**
 * How a step stands, as a mark in a column a little wider than the mascot: the icon of what it did, once it
 * is done, which grows out where the spinner was, and Kumo's spinner while it is happening.
 */
const StepMark = ({ entry, grows }: { entry: ToolStepEntry; grows?: boolean }) => {
  const { icon: StepIcon } = summaryOf(entry)
  return (
    <span className="grid size-7 shrink-0 place-items-center">
      {isUnderWay(entry)
        ? <StepSpinner />
        : <StepIcon aria-hidden="true" className={cn('size-4', grows && 'mark-grows')} />}
    </span>
  )
}

/** A step as one quiet line, which opens to show what it did when there is more to show. */
export const ToolStep = ({ entry, open, onToggle, fresh }: ToolStepProps) => (
  <Row entry={entry} label={summaryOf(entry).label} open={open} onToggle={onToggle} detail={hasDetail(entry)} fresh={fresh} />
)

/**
 * A step as one row. It is one row, the same element, from its first moment to its last, so that nothing
 * in it is made again as it goes on: the words change in place, and the mark and the caret come in where
 * they are due. While it is under way its words are in the full colour, and when it is done they fade to
 * the quiet colour of what is done as the icon grows out. A row that opens has what it did inside, in the
 * words' column, with nothing beside it in the marks' column; it has no fill, pointed at or open.
 */
const Row = ({ entry, label, open, onToggle, detail, fresh }: { entry: ToolStepEntry; label: string; open: boolean; onToggle: () => void; detail: boolean; fresh?: boolean }) => {
  const underWay = isUnderWay(entry)
  const [wasUnderWay, setWasUnderWay] = useState(false)
  if (underWay && !wasUnderWay) setWasUnderWay(true)
  // It was under way, and is not now: its mark grows out and its words go quiet.
  const quiets = wasUnderWay && !underWay
  // A step that comes in opens to what it did once its row is there, as it opens when clicked, rather than
  // being as tall as all of it at once: after its row has opened (`row-enter`), or with no motion, a frame after
  // it is drawn.
  const reduced = useReducedMotion()
  const [arrived, setArrived] = useState(!fresh)
  useEffect(() => {
    if (arrived || !reduced) return
    const frame = requestAnimationFrame(() => setArrived(true))
    return () => cancelAnimationFrame(frame)
  }, [arrived, reduced])
  return (
    <Disclosure
      open={open && detail && arrived}
      onToggle={onToggle}
      onAnimationEnd={(event) => {
        if (event.animationName === 'row-enter') setArrived(true)
      }}
      disabled={!detail}
      hideCaret
      summary={(
        <>
          <StepMark entry={entry} grows={quiets} />
          <span className={cn('min-w-0 truncate', underWay && 'text-kumo-default', quiets && 'row-quiets')}>
            <ShimmerSwitchText active={false} truncate>{label}</ShimmerSwitchText>
          </span>
          {entry.type === 'call' && entry.error && <Badge variant="error">Error</Badge>}
          {/* The chevron beside a step that opens: small, so a little bolder than the icons. */}
          <ArrowDown01Icon
            aria-hidden="true"
            weight="bold"
            className={cn('size-3 shrink-0 transition-[opacity,transform] duration-300 group-data-panel-open:rotate-180 motion-reduce:transition-none', detail ? 'opacity-100' : '-translate-x-1 opacity-0')}
          />
        </>
      )}
      // Pointed at, a row that opens has its icon, words and caret all in the full colour at once: they take the row's, which
      // is why none is set on them but a step under way (see `row-quiets`).
      triggerClassName={cn('min-h-10 w-fit rounded-xl px-1.5 py-0 pe-4 focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none', detail ? 'hover:text-kumo-default' : 'cursor-default hover:text-kumo-subtle')}
      className={cn('rounded-xl text-[13px]/5', fresh && 'row-enter')}
    >
      {/* What it says may be streaming in: its room eases to it. */}
      <SmoothHeight>
        <div className="flex flex-col gap-3 pt-0.5 pe-4 pb-3 ps-10.5">
          <Detail entry={entry} />
        </div>
      </SmoothHeight>
    </Disclosure>
  )
}
