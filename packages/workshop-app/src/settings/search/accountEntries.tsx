import { ArrowCounterClockwiseIcon, SignOutIcon, XIcon } from '@phosphor-icons/react'
import type { SearchEntry, SearchPage } from '@/blocks/SearchDialog'
import { signOut } from '@/rpc/signOut'
import { resetLocalPreferences } from '../resetLocalPreferences'

const GROUP = 'Account'

/** What cannot be taken back is asked for twice, as the settings ask: a page with the one thing to do, and a way out. */
const confirmPage = (title: string, confirmTitle: string, warning: string, icon: SearchEntry['icon'], onConfirm: () => void | Promise<void>): SearchPage => ({
  kind: 'list',
  title,
  placeholder: title,
  entries: [
    { key: 'confirm', group: GROUP, title: confirmTitle, detail: warning, icon, onSelect: onConfirm },
    { key: 'cancel', group: GROUP, title: 'Cancel', icon: <XIcon />, onSelect: () => {} },
  ],
})

/**
 * What the Security and Advanced settings offer that is not a setting to look at: signing out of
 * this browser, and forgetting what is kept on this device.
 */
export const accountEntries: SearchEntry[] = [
  {
    key: 'setting:sign-out',
    group: GROUP,
    title: 'Sign out',
    keywords: ['log out', 'logout', 'security'],
    icon: <SignOutIcon />,
    onSelect: () => confirmPage('Sign out?', 'Sign out', 'Running tasks continue', <SignOutIcon />, signOut),
  },
  {
    key: 'setting:reset-local-preferences',
    group: GROUP,
    title: 'Reset local preferences',
    keywords: ['forget', 'clear', 'stars', 'layout', 'theme', 'advanced'],
    icon: <ArrowCounterClockwiseIcon />,
    onSelect: () => confirmPage('Reset local preferences?', 'Reset', 'Can’t be undone', <ArrowCounterClockwiseIcon />, resetLocalPreferences),
  },
]
