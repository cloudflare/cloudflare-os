import { useSyncExternalStore } from 'react'
import { ArrowCounterClockwiseIcon, PauseIcon, PlayIcon, SkipForwardIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { Tooltip } from '@/components/Tooltip'
import type { ScriptPlayer } from './ScriptPlayer'
import type { Scenario, Trigger } from './scenario'

const WAITING_FOR: Record<Trigger, string> = {
  onStart: 'the chat to open',
  onSend: 'a message',
  onApprove: 'Approve',
  onDeny: 'Deny',
  onRetry: 'Retry',
  onStop: 'Stop',
  onAcceptConnection: 'Set up',
  onDenyConnection: 'Deny',
}

export type MockControlsProps = {
  scenarios: Scenario[]
  scenario: Scenario
  player: ScriptPlayer
  onSelectScenario: (id: string) => void
  onRestart: () => void
}

/** The floating panel that picks a scripted chat and plays, pauses or steps through its script. */
export const MockControls = ({ scenarios, scenario, player, onSelectScenario, onRestart }: MockControlsProps) => {
  const { playing, position, total, waitingFor } = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const done = position === total
  const status = done
    ? 'Script finished'
    : waitingFor
      ? `Waiting for ${[...new Set(waitingFor.map((trigger) => WAITING_FOR[trigger]))].join(' or ')}`
      : `Step ${position} of ${total}`

  return (
    <aside
      aria-label="Mock scenario"
      className="absolute top-3 right-3 z-20 flex items-center gap-2 rounded-full bg-kumo-base p-1 pe-4 text-sm text-kumo-subtle ring-1 ring-kumo-line"
    >
      <DropdownMenu label={scenario.id} aria-label="Choose scenario" triggerVariant="ghost">
        {scenarios.map(({ id }) => (
          <DropdownMenu.Item key={id} onSelect={() => onSelectScenario(id)}>{id}</DropdownMenu.Item>
        ))}
      </DropdownMenu>
      <Button variant="ghost" icon={ArrowCounterClockwiseIcon} aria-label="Restart scenario" title="Restart scenario" onClick={onRestart} />
      {playing
        ? <Button variant="ghost" icon={PauseIcon} aria-label="Pause" title="Pause" onClick={player.pause} />
        : <Button variant="ghost" icon={PlayIcon} aria-label="Play" title="Play" disabled={done} onClick={player.play} />}
      <Button variant="ghost" icon={SkipForwardIcon} aria-label="Step" title="Run the next step" disabled={done || !!waitingFor} onClick={player.step} />
      <Tooltip content={scenario.description}>
        {/* One width for whatever it says, so the buttons before it stay where they are as the
            script moves on. */}
        <span role="status" tabIndex={0} className="w-44 truncate tabular-nums">{status}</span>
      </Tooltip>
    </aside>
  )
}
