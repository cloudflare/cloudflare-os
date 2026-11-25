import { AgentRunPill } from './AgentRunPill'

export type StartedRun = {
  key: string
  title: string
  /** The run's address, so that it can be opened in another tab. */
  href?: string
  onOpen: () => void
}

export type AgentRunsStartedProps = { runs: readonly StartedRun[] }

const COUNT = new Intl.NumberFormat('en')

/**
 * The agents a turn started, at its end: how many, over a pill for each, which opens its run. It
 * says only that they started, as it stays in the conversation: how each is getting on is beside
 * the composer, and its end is a mark of its own, where it ended.
 */
export const AgentRunsStarted = ({ runs }: AgentRunsStartedProps) => {
  const caption = runs.length === 1 ? 'Started an agent' : `Started ${COUNT.format(runs.length)} agents`
  return (
    <div role="group" aria-label={caption} className="arrives flex flex-col items-start gap-1.5">
      <p className="px-1 text-sm text-kumo-subtle">{caption}</p>
      {runs.map(({ key, title, href, onOpen }) => <AgentRunPill key={key} title={title} href={href} onOpen={onOpen} />)}
    </div>
  )
}
