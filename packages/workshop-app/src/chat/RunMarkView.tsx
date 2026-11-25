import { AgentRunPill } from '@/blocks/AgentRunPill'
import { AgentRunsStarted } from '@/blocks/AgentRunsStarted'
import { ENDED_WORDS, type RunMark } from './chatRuns'

export type RunMarkViewProps = {
  mark: RunMark
  /** Opens a run's conversation, by its chat's id. */
  onOpen: (chatId: number) => void
  /** A run's address, by its chat's id, so that it can be opened in another tab. */
  href?: (chatId: number) => string
}

/** A point in the conversation about the agents it started: those a turn started, or one ending. */
export const RunMarkView = ({ mark, onOpen, href }: RunMarkViewProps) =>
  mark.kind === 'started' ? (
    <AgentRunsStarted runs={mark.runs.map(({ chatId, title }) => ({ key: String(chatId), title, href: href?.(chatId), onOpen: () => onOpen(chatId) }))} />
  ) : (
    <div className="arrives flex">
      <AgentRunPill
        title={mark.run.title}
        status={mark.run.status}
        statusWords={ENDED_WORDS[mark.run.status]}
        href={href?.(mark.run.chatId)}
        onOpen={() => onOpen(mark.run.chatId)}
      />
    </div>
  )
