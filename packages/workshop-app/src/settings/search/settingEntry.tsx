import type { SearchEntry } from '@/blocks/SearchDialog'
import type { SettingDefinition } from '../settingDefinition'
import { sectionInfo } from '../settingsSections'

/**
 * A setting as search offers it, by its kind: a switch flips in place and stays open to show it, a
 * choice goes on to a page of its options, and a line of text to a page to type it in. Nothing for
 * one that is not there yet, or a choice with nothing to choose from. A choice whose options are
 * still being read is listed all the same, and says so if it is chosen. `requireConnection` is
 * called before a change the server keeps.
 */
export const settingEntry = (setting: SettingDefinition, requireConnection: () => void): SearchEntry | undefined => {
  if (setting.soon) return undefined
  const guard = () => {
    if (setting.remote) requireConnection()
  }
  const base = {
    key: `setting:${setting.section}:${setting.title}`,
    group: sectionInfo(setting.section).label,
  }
  const Icon = setting.icon

  switch (setting.kind) {
    case 'toggle':
      return {
        ...base,
        title: setting.title,
        keywords: setting.keywords,
        on: setting.checked,
        icon: <Icon />,
        keepOpen: true,
        onSelect: () => {
          guard()
          return setting.set(!setting.checked)
        },
      }
    case 'choice': {
      const { unavailable } = setting
      // Listed before its options are known, so that it does not appear a moment after search opens.
      if (unavailable) {
        return {
          ...base,
          title: setting.title,
          keywords: setting.keywords,
          detail: unavailable.status === 'failed' ? 'Unavailable' : undefined,
          icon: <Icon />,
          onSelect: () => {
            if (unavailable.status === 'loading') throw new Error('Still loading. Try again in a moment.')
            unavailable.retry()
            throw new Error(`${unavailable.message}. Trying again.`)
          },
        }
      }
      if (setting.options.length === 0) return undefined
      return {
        ...base,
        title: setting.title,
        keywords: [...(setting.keywords ?? []), ...setting.options.map(({ label }) => label)],
        detail: setting.options.find(({ id }) => id === setting.value)?.label ?? setting.placeholder,
        icon: <ChoiceIcon setting={setting} option={setting.value} />,
        onSelect: () => ({
          kind: 'list',
          title: setting.title,
          placeholder: `Choose ${setting.title.toLowerCase()}`,
          entries: setting.options.map(({ id, label }) => ({
            key: `${base.key}:${id}`,
            group: setting.title,
            title: label,
            detail: id === setting.value ? 'Current' : undefined,
            icon: <ChoiceIcon setting={setting} option={id} />,
            onSelect: () => {
              guard()
              return setting.set(id)
            },
          })),
        }),
      }
    }
    case 'text':
      return {
        ...base,
        title: `Change ${setting.title.toLowerCase()}`,
        keywords: setting.keywords,
        detail: setting.value || undefined,
        icon: <Icon />,
        onSelect: () => ({
          kind: 'text',
          title: setting.title,
          placeholder: setting.placeholder,
          initial: setting.value,
          type: setting.type,
          optional: setting.optional,
          onSubmit: async (value) => {
            guard()
            await setting.set(value)
          },
        }),
      }
  }
}

// What an option is drawn with, or what the setting is.
const ChoiceIcon = ({ setting, option }: { setting: Extract<SettingDefinition, { kind: 'choice' }>; option: string }) => {
  const Icon = setting.optionIcons?.[option] ?? setting.icon
  return <Icon />
}
