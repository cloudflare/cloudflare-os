import { useState, useSyncExternalStore } from 'react'
import { Switch } from '@cloudflare/kumo'
import { ConnectionIsland, type ConnectionIslandState } from '@/blocks/ConnectionIsland'
import { Button } from '@/components/Button'
import { ConnectionNotice } from '@/rpc/ConnectionNotice'
import { Section } from './Section'

const STATES: Array<[string, ConnectionIslandState]> = [
  ['Reconnecting', { status: 'reconnecting', alarms: 1, long: false, offline: false }],
  ['A long while', { status: 'reconnecting', alarms: 1, long: true, offline: false }],
  ['Offline', { status: 'reconnecting', alarms: 1, long: false, offline: true }],
  ['Back', { status: 'reconnected' }],
]

/**
 * The island over the top of the window while the connection is made again: each state where it
 * stands, then a live one played by the same rules as the app's, from the buttons.
 */
export const ConnectionIslandPreview = () => {
  const [notice] = useState(() => new ConnectionNotice())
  const state = useSyncExternalStore(notice.subscribe, notice.getSnapshot)
  const [down, setDown] = useState(false)
  const [offline, setOffline] = useState(false)
  // Bumped to show each state arriving again.
  const [shown, setShown] = useState(0)
  const [blocked, setBlocked] = useState<string>()

  return (
    <>
      <Section title="ConnectionIsland (each state, shaken by its alarm and then sad, or happy once back)">
        <div className="flex flex-wrap items-start gap-4">
          {STATES.map(([name, island]) => (
            <div key={`${name}/${shown}`} className="flex h-24 w-72 flex-col items-center gap-2">
              <span className="text-sm text-kumo-subtle">{name}</span>
              <ConnectionIsland state={island} onDismiss={() => {}} />
            </div>
          ))}
        </div>
        <Button onClick={() => setShown((current) => current + 1)}>Show them arriving again</Button>
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
