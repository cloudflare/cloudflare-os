import type { Icon } from '@phosphor-icons/react'
import type { SettingsSection } from './settingsSections'

type Shared = {
  /** What it is called, by its row on the Settings page and by search alike. */
  title: string
  /** What it does, under its row's title. */
  description: string
  /** The part of the Settings page it is in, which is also what search lists it under. */
  section: SettingsSection
  icon: Icon
  /** Words search finds it by besides its title and, for a choice, the names of its options. */
  keywords?: readonly string[]
  /** The server keeps it, so nothing is tried while the connection is down. */
  remote?: boolean
  /** It is not there yet: its row is shown as such and search leaves it out. */
  soon?: boolean
}

/** A setting that is on or off. `set` rejects with why it could not be changed. */
export type ToggleSetting = Shared & {
  kind: 'toggle'
  checked: boolean
  set: (checked: boolean) => void | Promise<void>
}

/**
 * A setting that is one of a few things. `set` is a method so that a choice of some values is
 * also a choice of strings; it rejects with why it could not be changed.
 */
export type ChoiceSetting<Value extends string = string> = Shared & {
  kind: 'choice'
  value: Value
  options: readonly { id: Value; label: string }[]
  /** What each option is drawn with in search, instead of the setting's own. */
  optionIcons?: Partial<Record<Value, Icon>>
  /** What is said while the value is none of the options. */
  placeholder: string
  /** For more options than are easily read through. */
  searchable?: boolean
  /**
   * Its options are not known: still being read, or they could not be. Search lists it anyway,
   * without what it is set to, and says so if it is chosen before they are; the page draws none, as
   * it waits for what it is set by.
   */
  unavailable?: { status: 'loading' } | { status: 'failed'; message: string; retry: () => void }
  set(value: Value): void | Promise<void>
}

/** A setting that is a line of text. `set` rejects with why it could not be kept. */
export type TextSetting = Shared & {
  kind: 'text'
  value: string
  placeholder: string
  type?: 'text' | 'email'
  /** It may be left empty, which `set` is then given. */
  optional?: boolean
  set: (value: string) => Promise<void>
}

/**
 * A setting that is defined once for the Settings page and for search: what it is called and
 * does, what it is set to, and how to change it. The page draws its own row for it and search its
 * own entry, so that neither says what the other does not, and one that is not there yet (`soon`)
 * is not offered by search before it is on the page.
 */
export type SettingDefinition = ToggleSetting | ChoiceSetting | TextSetting
