import { Switch } from '@/components/Switch'
import { SettingRow } from './SettingRow'

/**
 * Where this browser stands: notifications `on` or `off` (`loading` until that is known, shown as
 * off and out of use), `blocked` by the browser's own settings, or not for this browser at all,
 * as on an iPhone or iPad, whose notifications come from the Cloudflare OS app, and on Android.
 */
export type BrowserNotificationsState = 'loading' | 'on' | 'off' | 'blocked' | 'appleMobile' | 'android'

export type BrowserNotificationsRowProps = {
  state: BrowserNotificationsState
  /** What it was switched to is under way. */
  pending?: boolean
  /** Why the last switch did not hold. */
  problem?: string
  onChange: (on: boolean) => void
}

const SAYS: Record<BrowserNotificationsState, string> = {
  loading: 'Get a notification in this browser when a task finishes or needs your approval while the Workshop isn’t in view.',
  off: 'Get a notification in this browser when a task finishes or needs your approval while the Workshop isn’t in view.',
  on: 'This browser shows a notification when a task finishes or needs your approval while the Workshop isn’t in view.',
  blocked: 'Notifications are blocked for this site in your browser’s settings.',
  appleMobile: 'On iPhone and iPad, notifications come from the Cloudflare OS app.',
  android: 'Browser notifications aren’t available on Android yet.',
}

/**
 * The setting for this browser's notifications: what they do as they stand, and the switch, which
 * is out of use while they are blocked, and left out where this browser cannot have them.
 */
export const BrowserNotificationsRow = ({ state, pending = false, problem, onChange }: BrowserNotificationsRowProps) => (
  <SettingRow
    title="Browser notifications"
    description={(
      <>
        {SAYS[state]}
        {problem && <span role="alert" className="mt-1 block text-kumo-danger">{problem}</span>}
      </>
    )}
  >
    {state !== 'appleMobile' && state !== 'android' && (
      <Switch
        aria-label="Browser notifications"
        checked={state === 'on'}
        disabled={state === 'loading' || state === 'blocked'}
        busy={pending}
        onCheckedChange={onChange}
      />
    )}
  </SettingRow>
)
