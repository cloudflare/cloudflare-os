import type { SearchEntry } from '@/blocks/SearchDialog'
import { sectionInfo, type SettingsSection } from '../settingsSections'

// The user's own parts. The admin's are not changed from here.
const SECTIONS: SettingsSection[] = ['profile', 'preferences', 'notifications', 'models', 'usage']

/**
 * A way to each of those parts, for what is changed there and not here, such as the password and
 * a model of the user's own.
 */
export const sectionEntries = (onOpen: (section: SettingsSection) => void): SearchEntry[] =>
  SECTIONS.map((section) => {
    const { label, summary, icon: Icon } = sectionInfo(section)
    return {
      key: `settings:${section}`,
      group: 'Settings',
      title: `Settings › ${label}`,
      keywords: [summary],
      icon: <Icon />,
      onSelect: () => onOpen(section),
    }
  })
