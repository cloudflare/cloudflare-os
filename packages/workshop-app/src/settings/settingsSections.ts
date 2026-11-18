import {
  ArrowsClockwiseIcon,
  BellIcon,
  BrainIcon,
  ChartBarIcon,
  CpuIcon,
  FileTextIcon,
  GearSixIcon,
  LightningIcon,
  ListMagnifyingGlassIcon,
  LockKeyIcon,
  PlugsIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  UserIcon,
  UserPlusIcon,
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
  'admin-general',
  'admin-services',
  'admin-formats',
  'admin-models',
  'admin-access',
  'admin-audit',
  'admin-updates',
] as const

export type SettingsSection = (typeof SETTINGS_SECTION_IDS)[number]

export const isSettingsSection = (value: unknown): value is SettingsSection =>
  SETTINGS_SECTION_IDS.includes(value as SettingsSection)

/** Whether a part is one of the deployment's, which only its admins are shown (`ADMIN_GROUP`). */
export const isAdminSection = (id: SettingsSection) => id.startsWith('admin-')

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
      { id: 'models', label: 'Models', summary: 'Default model, context and custom instructions', icon: CpuIcon },
      { id: 'approvals', label: 'Approvals', summary: 'What the assistant can do without asking', icon: ShieldCheckIcon },
      { id: 'skills', label: 'Skills', summary: 'Your skills and how they are used', icon: LightningIcon },
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
 * The deployment's own settings, for everyone on it, which only its admins are shown, after the
 * user's own. Main's Admin page, a tab to a part.
 */
export const ADMIN_GROUP: { label: string; sections: SectionInfo[] } = {
  label: 'Admin',
  sections: [
    { id: 'admin-general', label: 'General', summary: 'Name, logo, notices and agent instructions', icon: GearSixIcon },
    { id: 'admin-services', label: 'Services', summary: 'Which services and resources are offered', icon: PlugsIcon },
    { id: 'admin-formats', label: 'Formats', summary: 'The kinds of thing offered to be made', icon: FileTextIcon },
    { id: 'admin-models', label: 'Gateway models', summary: 'Models and providers through AI Gateway', icon: BrainIcon },
    { id: 'admin-access', label: 'Access', summary: 'Sign-ups and finding people', icon: UserPlusIcon },
    { id: 'admin-audit', label: 'Audit', summary: 'What admins have done, and may do', icon: ListMagnifyingGlassIcon },
    { id: 'admin-updates', label: 'Updates', summary: 'New releases of this deployment', icon: ArrowsClockwiseIcon },
  ],
}

/**
 * The parts as the ways to them list them (`SettingsSidebar`, `SettingsMenu`), each with its
 * address where `href` gives one.
 */
export const settingsNavGroups = (href?: (section: SettingsSection) => string, admin = false) =>
  (admin ? [...SETTINGS_GROUPS, ADMIN_GROUP] : SETTINGS_GROUPS).map(({ label, sections }) => ({
    label,
    items: sections.map((section) => ({ ...section, href: href?.(section.id) })),
  }))

export const sectionInfo = (id: SettingsSection): SectionInfo =>
  [...SETTINGS_GROUPS, ADMIN_GROUP].flatMap(({ sections }) => sections).find((section) => section.id === id)!
