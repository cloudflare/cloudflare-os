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
  PlugsIcon,
  SlidersHorizontalIcon,
  UserIcon,
  UserPlusIcon,
  type Icon,
} from '@phosphor-icons/react'

/** The parts of the settings, by what each is called in the page's address (`?section=`). */
export const SETTINGS_SECTION_IDS = [
  'profile',
  'preferences',
  'notifications',
  'models',
  'skills',
  'usage',
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

/** Parts listed together, under what they have in common where it is said. */
type SectionGroup = { label?: string; sections: SectionInfo[] }

/**
 * The user's own parts, in the order they are listed: one list, with no heading over it, as there
 * are few enough to read at a glance.
 */
export const SETTINGS_GROUP: SectionGroup = {
  sections: [
    { id: 'profile', label: 'Profile', summary: 'Name, picture, identity and password', icon: UserIcon },
    { id: 'preferences', label: 'Preferences', summary: 'Appearance, side pane and developer mode', icon: SlidersHorizontalIcon },
    { id: 'notifications', label: 'Notifications', summary: 'This browser and muted workspaces', icon: BellIcon },
    { id: 'models', label: 'Models', summary: 'Default and quick models, and your own', icon: CpuIcon },
    { id: 'skills', label: 'Skills', summary: 'Your skills and their collections', icon: LightningIcon },
    { id: 'usage', label: 'Usage & billing', summary: 'Free requests and billing', icon: ChartBarIcon },
  ],
}

/**
 * The deployment's own settings, for everyone on it, which only its admins are shown, after the
 * user's own. Main's Admin page, a tab to a part.
 */
export const ADMIN_GROUP: SectionGroup = {
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
  (admin ? [SETTINGS_GROUP, ADMIN_GROUP] : [SETTINGS_GROUP]).map(({ label, sections }) => ({
    label,
    items: sections.map((section) => ({ ...section, href: href?.(section.id) })),
  }))

export const sectionInfo = (id: SettingsSection): SectionInfo =>
  [SETTINGS_GROUP, ADMIN_GROUP].flatMap(({ sections }) => sections).find((section) => section.id === id)!
