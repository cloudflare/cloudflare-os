import { useId, useRef } from 'react'
import { AgentRunPill } from '@/blocks/AgentRunPill'
import { MessageTrace } from '@/blocks/MessageBubble'
import type { ToolStepEntry } from '@/blocks/ToolStep'
import { useDetailsStage } from '@/blocks/useDetailsStage'
import { WorkLog } from '@/blocks/WorkLog'
import { STATUS_WORDS } from '@/automations/agents'
import { useLiveWorkOpen } from '@/hooks/useLiveWorkOpen'
import { useOpenKeys, type DisclosureStore } from './DisclosureStore'
import type { RunMark } from './chatRuns'

/**
 * The steps taken before a mark, since the mark before it, shown above it whenever the steps it is
 * among are: those of the reply after it, as its thinking is open (`thinkingKey`, as `ChatItemView`
 * has it), or those of the work under way, as the thinking indicator shows them (`live`).
 */
export type MarkSteps = { entries: ToolStepEntry[] } & (
  | { thinkingKey: string; tracedWhileShown: boolean; live?: undefined }
  | { live: boolean; thinkingKey?: undefined }
)

export type RunMarkViewProps = {
  mark: RunMark
  /** Opens a run's conversation, by its chat's id. Left out where none can be: the pills are then not pressed. */
  onOpen?: (chatId: number) => void
  /** A run's address, by its chat's id, so that it can be opened in another tab. */
  href?: (chatId: number) => string
  steps?: MarkSteps
  disclosure: DisclosureStore
}

/**
 * A point in the conversation about an agent it started: a pill where it started, saying only
 * that it did (how it is getting on is beside the composer), and one where it ended, saying how.
 * Each is a row of its own, growing in from the top corner on the agent's side as its messages do.
 * Where the steps it happened among are shown, those before it are above it, as the trace above a
 * reply has them, so that it is among them where it happened, and stays where it is as they open.
 */
export const RunMarkView = ({ mark: { kind, run }, onOpen, href, steps, disclosure }: RunMarkViewProps) => {
  const id = useId()
  const trace = useRef<HTMLDivElement>(null)
  const entries = steps?.entries ?? []
  const open = useOpenKeys(disclosure, steps?.thinkingKey ? [steps.thinkingKey, ...entries.map(({ key }) => key)] : entries.map(({ key }) => key))
  const [alwaysShowThinking] = useLiveWorkOpen()
  const live = steps?.thinkingKey === undefined
  const shown = !steps || entries.length === 0
    ? false
    : steps.thinkingKey === undefined ? steps.live : open.has(steps.thinkingKey) !== (alwaysShowThinking || steps.tracedWhileShown)
  const stage = useDetailsStage(shown, false)
  return (
    <div className="flex flex-col">
      {entries.length > 0 && stage !== 'gone' && (
        // Watched as they happen, they were in the thinking indicator a moment ago: the row they
        // arrive in opens from their height (`MessageList`).
        <MessageTrace ref={trace} id={id} stage={stage} shownAlready={live && shown}>
          <WorkLog steps={entries} toggledSteps={open} onToggleStep={disclosure.toggle} startOpen={live || !!steps?.tracedWhileShown} />
        </MessageTrace>
      )}
      <div className="arrives flex origin-top-left">
        <AgentRunPill
          title={run.title}
          agent={run.agent.name}
          status={kind === 'started' ? 'started' : run.status}
          statusWords={kind === 'started' ? 'Started' : STATUS_WORDS[run.status]}
          href={href?.(run.chatId)}
          onOpen={onOpen && (() => onOpen(run.chatId))}
        />
      </div>
    </div>
  )
}
