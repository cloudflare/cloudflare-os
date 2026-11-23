import { useCallback, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import {
  ArrowDown01Icon, BookOpen01Icon, Brain03Icon, Chat01Icon, CodeIcon, Edit02Icon, File01Icon, GitBranchIcon, GlobeIcon, Link01Icon,
  ListIcon, PlugIcon, PlusSignIcon, Search01Icon, StopIcon,
} from '@hugeicons/core-free-icons'
import { cn } from '@cloudflare/kumo/utils'
import { Badge, Loader } from '@cloudflare/kumo'
import { CodeBlock } from '@/components/CodeBlock'
import { hugeIcon, type HugeIconProps } from '@/components/HugeIcon'
import { ShimmerSwitchText } from '@/components/ShimmerSwitchText'
import { Disclosure } from '@/components/Disclosure'
import { Markdown, useReducedMotion } from '@gadgets/ui'
import { SmoothHeight } from '@/components/SmoothHeight'
import { ActionFields, type ActionField } from './ActionFields'
import type { AnswerPart } from './AssistantMessage'
import { InlineViewDraft } from './InlineView'
import { LeavingSlot, MascotSlot, usePresenceSlot } from './presenceSlot'
import { ResourceLink, type ResourceLinkProps } from './ResourceLink'
import './ToolStep.css'

type StepIconType = ComponentType<HugeIconProps>

// Hugeicons, the free set: a step's mark is the icon of what it did.
const Code = hugeIcon(CodeIcon)
const ICONS = {
  file: hugeIcon(File01Icon),
  edit: hugeIcon(Edit02Icon),
  terminal: Code,
  globe: hugeIcon(GlobeIcon),
  search: hugeIcon(Search01Icon),
  link: hugeIcon(Link01Icon),
  plus: hugeIcon(PlusSignIcon),
  branch: hugeIcon(GitBranchIcon),
  list: hugeIcon(ListIcon),
  stop: hugeIcon(StopIcon),
  plug: hugeIcon(PlugIcon),
} satisfies Record<string, StepIconType>
const Thinking = hugeIcon(Brain03Icon)
const Writing = hugeIcon(Chat01Icon)
const Observation = hugeIcon(BookOpen01Icon)
// The chevron beside a step that opens: small, so a little bolder than the icons.
const Caret = hugeIcon(ArrowDown01Icon, 2.25)

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
  /** The step came after the log was first shown: it comes in, rather than being there. */
  fresh?: boolean
  /** Its row opens to its height as it comes in, which `fresh` alone does not say (it is made room for already). */
  enter?: boolean
  /** The mascot is at this step, in place of its spinner. */
  mascot?: boolean
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

const summaryOf = (entry: ToolStepEntry): { icon: StepIconType; label: string } => {
  switch (entry.type) {
    case 'thinking':
      return { icon: Thinking, label: entry.running ? 'Thinking…' : 'Thought' }
    case 'writing':
      return { icon: Writing, label: 'Writing…' }
    case 'observation':
      return { icon: Observation, label: entry.label }
    case 'call':
      return { icon: ICONS[entry.icon] ?? Code, label: entry.label }
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
 * is done, and Kumo's spinner while it is happening. Where the mascot is at the step,
 * there is room for it instead, and once it is done that room is kept bare while the mascot is still over
 * it: the icon grows out as the mascot has moved on (`LeavingSlot`).
 */
const StepMark = ({ entry, mascot, fresh, lingering, onCleared, grows }: { entry: ToolStepEntry; mascot?: boolean; fresh?: boolean; lingering?: boolean; onCleared: () => void; grows?: boolean }) => {
  const { icon: StepIcon } = summaryOf(entry)
  return (
    <span className="grid size-7 shrink-0 place-items-center">
      {mascot
        ? <MascotSlot holdUntilArrived={fresh} />
        : lingering
          ? <LeavingSlot onClear={onCleared} />
          : isUnderWay(entry)
            ? <StepSpinner />
            : <StepIcon aria-hidden="true" className={cn('size-4', grows && 'mark-grows')} />}
    </span>
  )
}

/** A step as one quiet line, which opens to show what it did when there is more to show. */
export const ToolStep = ({ entry, open, onToggle, fresh, enter = fresh, mascot }: ToolStepProps) => (
  <Row entry={entry} label={summaryOf(entry).label} open={open} onToggle={onToggle} detail={hasDetail(entry)} fresh={fresh} enter={enter} mascot={mascot} />
)

/**
 * A step as one row. It is one row, the same element, from its first moment to its last, so that nothing
 * in it is made again as it goes on: the words change in place, and the mark and the caret come in where
 * they are due. While it is under way its words are in the full colour, and when it is done they fade to
 * the quiet colour of what is done as the icon grows out. A row that opens has what it did inside, in the
 * words' column, set off by a line down the middle of the marks' column; it has no fill, pointed at or open.
 */
const Row = ({ entry, label, open, onToggle, detail, fresh, enter, mascot }: { entry: ToolStepEntry; label: string; open: boolean; onToggle: () => void; detail: boolean; fresh?: boolean; enter?: boolean; mascot?: boolean }) => {
  const underWay = isUnderWay(entry)
  const presence = usePresenceSlot()
  const [wasUnderWay, setWasUnderWay] = useState(false)
  if (underWay && !wasUnderWay) setWasUnderWay(true)
  // The mascot was at the step and has not yet moved on from it: its mark waits for that.
  const [hadMascot, setHadMascot] = useState(false)
  if (mascot && !hadMascot) setHadMascot(true)
  const [cleared, setCleared] = useState(false)
  const clear = useCallback(() => setCleared(true), [])
  const lingering = !!presence && hadMascot && !mascot && !cleared
  const live = underWay || lingering
  // It was under way, or had the mascot, and is not now: its mark grows out and its words go quiet.
  const quiets = (wasUnderWay || hadMascot) && !live
  return (
    <Disclosure
      open={open && detail}
      onToggle={onToggle}
      disabled={!detail}
      hideCaret
      summary={(
        <>
          <StepMark entry={entry} mascot={mascot} fresh={fresh} lingering={lingering} onCleared={clear} grows={quiets} />
          <span className={cn('min-w-0 truncate transition-opacity duration-500 group-has-data-waiting:opacity-0 group-has-data-waiting:transition-none motion-reduce:transition-none', live && 'text-kumo-default', quiets && 'row-quiets')}>
            <ShimmerSwitchText active={false} truncate>{label}</ShimmerSwitchText>
          </span>
          {entry.type === 'call' && entry.error && <Badge variant="error">Error</Badge>}
          <Caret
            aria-hidden="true"
            className={cn('size-3 shrink-0 transition-[opacity,transform] duration-300 group-data-panel-open:rotate-180 motion-reduce:transition-none', detail ? 'opacity-100 group-has-data-waiting:opacity-0 group-has-data-waiting:transition-none' : '-translate-x-1 opacity-0')}
          />
        </>
      )}
      // Pointed at, a row that opens has its icon, words and caret all in the full colour at once: they take the row's, which
      // is why none is set on them but a step under way (see `row-quiets`).
      triggerClassName={cn('min-h-10 w-fit rounded-xl px-1.5 py-0 pe-4 focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none', detail ? 'hover:text-kumo-default' : 'cursor-default hover:text-kumo-subtle')}
      className={cn('rounded-xl text-[13px]/5', enter && 'row-enter')}
    >
      {/* What it says may be streaming in: its room eases to it. */}
      <SmoothHeight>
        <div className="relative flex flex-col gap-3 pt-0.5 pe-4 pb-3 ps-10.5">
          {/* What an open step did is set off by a line of 1px down the middle of the marks' column, under its icon, as long as it is. */}
          <span aria-hidden="true" className="absolute start-5 top-0 bottom-3 w-px bg-kumo-contrast/12" />
          <Detail entry={entry} />
        </div>
      </SmoothHeight>
    </Disclosure>
  )
}
