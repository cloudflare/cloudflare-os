import { useState, useSyncExternalStore } from 'react'
import { Switch, Tabs } from '@cloudflare/kumo'
import { ConnectionIsland, type ConnectionIslandState } from '@/blocks/ConnectionIsland'
import { Button } from '@/components/Button'
import { ConnectionNotice } from '@/rpc/ConnectionNotice'
import { Section } from './Section'

type Shown = 'hidden' | 'reconnecting' | 'long' | 'offline' | 'reconnected'

const TABS: Array<{ value: Shown; label: string }> = [
  { value: 'hidden', label: 'Hidden' },
  { value: 'reconnecting', label: 'Reconnecting' },
  { value: 'long', label: 'A long while' },
  { value: 'offline', label: 'Offline' },
  { value: 'reconnected', label: 'Reconnected' },
]

const stateOf = (shown: Shown, alarms: number): ConnectionIslandState | undefined => {
  switch (shown) {
    case 'hidden':
      return undefined
    case 'reconnected':
      return { status: 'reconnected' }
    default:
      return { status: 'reconnecting', alarms, long: shown === 'long', offline: shown === 'offline' }
  }
}

/**
 * The island over the top of the window while the connection is made again: one, put in each
 * state from the tabs, so that what changes between them can be seen, and its opening and closing
 * from Hidden; then a live one played by the same rules as the app's, from the buttons.
 */
export const ConnectionIslandPreview = () => {
  const [notice] = useState(() => new ConnectionNotice())
  const state = useSyncExternalStore(notice.subscribe, notice.getSnapshot)
  const [down, setDown] = useState(false)
  const [offline, setOffline] = useState(false)
  const [blocked, setBlocked] = useState<string>()
  const [shown, setShown] = useState<Shown>('reconnecting')
  // Bumped for a fresh alarm, as something that could not be done would.
  const [alarms, setAlarms] = useState(1)
  const island = stateOf(shown, alarms)

  return (
    <>
      <Section title="ConnectionIsland (each state, from the tabs: shaken by an alarm, then thinking while it reconnects or sad once it can’t, and happy once back; from Hidden it opens out of the top edge of the box, and goes back into it)">
        <div className="flex flex-wrap items-center gap-4">
          <Tabs size="sm" value={shown} onValueChange={(value) => setShown(value as Shown)} tabs={TABS} />
          <Button disabled={island?.status !== 'reconnecting'} onClick={() => setAlarms((current) => current + 1)}>Raise an alarm</Button>
        </div>
        {/* It opens out of a point this far above it, which is the box's top edge. */}
        <div className="flex h-24 w-full justify-center rounded-3xl pt-4 ring-1 ring-kumo-line">
          <ConnectionIsland state={island} onDismiss={() => setShown('hidden')} />
        </div>
      </Section>
      <Section title="ConnectionIsland, live (at the top of the window, by the app’s rules: said after a moment, put away by a swipe up or Escape, back with a shake when something can’t be done, then happy and away once back)">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => {
              if (down) notice.restored()
              else notice.lost()
              setDown(!down)
              setBlocked(undefined)
            }}
          >
            {down ? 'Connection back' : 'Lose the connection'}
          </Button>
          <Button onClick={() => setBlocked(notice.blocked() ? 'Not sent: the island came back.' : 'Sent.')}>Send a message</Button>
          <Switch
            label="Offline"
            checked={offline}
            onCheckedChange={(next) => {
              setOffline(next)
              notice.setOffline(next)
            }}
          />
          {blocked && <span role="status" className="text-sm text-kumo-subtle">{blocked}</span>}
        </div>
        <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center">
          <ConnectionIsland state={state.status === 'hidden' ? undefined : state} onDismiss={notice.dismiss} />
        </div>
      </Section>
    </>
  )
}
