import type { SearchEntry } from '@/blocks/SearchDialog'
import { sectionInfo, type SettingsSection } from '../settingsSections'

// The parts with settings in them that are there. What is only coming is not worth going to, and
// the admin's are not changed from here.
const SECTIONS: SettingsSection[] = ['profile', 'security', 'usage', 'models', 'preferences', 'notifications', 'advanced']

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
