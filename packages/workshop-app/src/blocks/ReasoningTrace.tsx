import { BrainIcon } from '@phosphor-icons/react'
import { Disclosure } from '@/components/Disclosure'
import { Markdown } from '@/components/Markdown'

export type ReasoningTraceProps = {
  text: string
  /** Still being written. */
  live?: boolean
  open: boolean
  onToggle: () => void
}

/** What the agent thought before answering. Closed until asked for. */
export const ReasoningTrace = ({ text, live, open, onToggle }: ReasoningTraceProps) => (
  <Disclosure
    open={open}
    onToggle={onToggle}
    summary={
      <>
        <BrainIcon aria-hidden="true" className="size-5 shrink-0" />
        <span role={live ? 'status' : undefined}>{live ? 'Thinking…' : 'Thinking'}</span>
      </>
    }
  >
    <div className="ms-4 mt-1 mb-1 border-s-2 border-kumo-line ps-4 text-sm text-kumo-subtle">
      <Markdown>{text}</Markdown>
    </div>
  </Disclosure>
)
