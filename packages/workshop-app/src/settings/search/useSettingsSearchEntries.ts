import type { SearchEntry } from '@/blocks/SearchDialog'
import { modelChoiceSettings } from '../modelChoiceSettings'
import type { SettingDefinition } from '../settingDefinition'
import type { SettingsSection } from '../settingsSections'
import { useModelSettings } from '../useModelSettings'
import { usePreferenceSettings } from '../usePreferenceSettings'
import { useProfileSettings } from '../useProfileSettings'
import { accountEntries } from './accountEntries'
import { sectionEntries } from './sectionEntries'
import { settingEntry } from './settingEntry'
import { useNotificationEntries } from './useNotificationEntries'
import { usePictureEntries } from './usePictureEntries'
import { useRequireConnection } from './useRequireConnection'
import { useUsageEntries } from './useUsageEntries'

/**
 * The settings that can be changed from search, as entries: those defined once for the Settings
 * page too (`SettingDefinition`), so that the two cannot differ, then those that are only
 * actions, with a way to each part of the page for what needs more room than search has.
 * `suggested` are the few offered before anything is typed: the default model, which is told apart
 * as it may be put first, and then the others in the order they are offered. What
 * has to be read from the server (the models, the usage) is read while `enabled`, which is while
 * search is open, so that nothing is asked for before it is wanted.
 */
export const useSettingsSearchEntries = (
  enabled: boolean,
  onOpenSection: (section: SettingsSection) => void,
): { entries: SearchEntry[]; suggested: { model: SearchEntry | undefined; settings: SearchEntry[] } } => {
  const requireConnection = useRequireConnection()
  const profile = useProfileSettings()
  const preferences = usePreferenceSettings()
  const models = useModelSettings(enabled)
  const { defaultModel, quickModel } = modelChoiceSettings(models.state, models)

  const definitions: SettingDefinition[] = [
    profile.displayName,
    profile.commitEmail,
    defaultModel,
    quickModel,
    preferences.theme,
    preferences.motion,
    preferences.autoOpenOutputs,
  ]
  // What is reached for most, and what bothers someone enough to look for it: the model, the
  // theme, the animations. The model is there before its value is read.
  const suggestedDefinitions: SettingDefinition[] = [preferences.theme, preferences.motion]

  const entryOf = new Map(definitions.flatMap((definition) => {
    const entry = settingEntry(definition, requireConnection)
    return entry ? [[definition, entry] as const] : []
  }))

  return {
    entries: [
      ...entryOf.values(),
      ...usePictureEntries(() => onOpenSection('profile')),
      ...useUsageEntries(enabled),
      ...useNotificationEntries(),
      ...accountEntries,
      ...sectionEntries(onOpenSection),
    ],
    suggested: {
      model: entryOf.get(defaultModel),
      settings: suggestedDefinitions.flatMap((definition) => entryOf.get(definition) ?? []),
    },
  }
}
