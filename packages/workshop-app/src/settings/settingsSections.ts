import {
  BellIcon,
  ChartBarIcon,
  CpuIcon,
  LightningIcon,
  LockKeyIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  UserIcon,
  UsersIcon,
  WrenchIcon,
  type Icon,
} from '@phosphor-icons/react'

/** The parts of the settings, by what each is called in the page's address (`?section=`). */
export const SETTINGS_SECTION_IDS = [
  'profile',
  'security',
  'usage',
  'models',
  'approvals',
  'skills',
  'preferences',
  'notifications',
  'collaboration',
  'advanced',
] as const

export type SettingsSection = (typeof SETTINGS_SECTION_IDS)[number]

export const isSettingsSection = (value: unknown): value is SettingsSection =>
  SETTINGS_SECTION_IDS.includes(value as SettingsSection)

/** The part shown where none is named and there is room for one beside the list of them. */
export const FIRST_SECTION: SettingsSection = 'profile'

type SectionInfo = {
  id: SettingsSection
  label: string
  /** What is in it, in a few words: under its name in the list, and under its heading. */
  summary: string
  icon: Icon
}

/** The parts in the order they are listed, grouped by what they are about. */
export const SETTINGS_GROUPS: { label: string; sections: SectionInfo[] }[] = [
  {
    label: 'Account',
    sections: [
      { id: 'profile', label: 'Profile', summary: 'Name, picture, identity and your data', icon: UserIcon },
      { id: 'security', label: 'Security', summary: 'Password, sign-in and sessions', icon: LockKeyIcon },
      { id: 'usage', label: 'Usage & billing', summary: 'Free requests, billing and spending', icon: ChartBarIcon },
    ],
  },
  {
    label: 'Assistant',
    sections: [
      { id: 'models', label: 'Models', summary: 'Default model, reasoning and context', icon: CpuIcon },
      { id: 'approvals', label: 'Approvals', summary: 'What the assistant can do without asking', icon: ShieldCheckIcon },
      { id: 'skills', label: 'Instructions & skills', summary: 'Custom instructions and skills', icon: LightningIcon },
    ],
  },
  {
    label: 'App',
    sections: [
      { id: 'preferences', label: 'Preferences', summary: 'Appearance, side pane and keyboard', icon: SlidersHorizontalIcon },
      { id: 'notifications', label: 'Notifications', summary: 'Channels, events and muted workspaces', icon: BellIcon },
      { id: 'collaboration', label: 'Collaboration', summary: 'Invitations and presence', icon: UsersIcon },
      { id: 'advanced', label: 'Advanced', summary: 'Developer tools and local data', icon: WrenchIcon },
    ],
  },
]

/**
 * The parts as the ways to them list them (`SettingsSidebar`, `SettingsMenu`), each with its
 * address where `href` gives one.
 */
export const settingsNavGroups = (href?: (section: SettingsSection) => string) =>
  SETTINGS_GROUPS.map(({ label, sections }) => ({
    label,
    items: sections.map((section) => ({ ...section, href: href?.(section.id) })),
  }))

export const sectionInfo = (id: SettingsSection): SectionInfo =>
  SETTINGS_GROUPS.flatMap(({ sections }) => sections).find((section) => section.id === id)!
