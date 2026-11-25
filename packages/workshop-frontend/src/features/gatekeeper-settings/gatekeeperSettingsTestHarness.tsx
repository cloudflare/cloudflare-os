/* eslint-disable react/react-in-jsx-scope */

// What the jsdom and Chromium suites of GatekeeperSettings share.

import { useState } from 'react'
import type { AdminResourceVendor } from '@gadgets/workshop-shared/api'
import { GatekeeperSettings } from './GatekeeperSettings'

export type Setting = NonNullable<AdminResourceVendor['settings']>[number]

/** Web Search's two settings, with the choices `provider` and `fallback` in effect. */
export const webSearchSettings = (provider: string, fallback = 'none'): Setting[] => [
  {
    id: 'provider', label: 'Search provider', help: 'Where web searches run.',
    options: [
      { value: 'ceramic', label: 'Ceramic' }, { value: 'linkup', label: 'Linkup' },
      { value: 'exa', label: 'Exa' }, { value: 'model', label: 'The model’s provider' },
    ],
    defaultValue: 'ceramic', value: provider,
  },
  {
    id: 'fallback', label: 'Fallback search provider',
    help: 'Runs the searches that a model’s provider cannot.',
    options: [{ value: 'none', label: 'None' }, { value: 'ceramic', label: 'Ceramic' }],
    defaultValue: 'none', shownWhen: { settingId: 'provider', value: 'model' }, value: fallback,
  },
]

/**
 * The settings as the admin page holds them: a pick shows at once, and is being saved until the
 * promise that `onSave` returns for it resolves.
 */
export const SettingsPanel = ({ initial, onSave }: {
  initial: Setting[]
  onSave: (settingId: string, value: string) => Promise<void>
}) => {
  const [settings, setSettings] = useState(initial)
  const [saving, setSaving] = useState(false)
  return (
    <GatekeeperSettings
      vendorName="Web Search"
      settings={settings}
      saving={saving}
      onChoose={(settingId, value) => {
        setSettings((shown) => shown.map((setting) => (
          setting.id === settingId ? { ...setting, value } : setting)))
        setSaving(true)
        void onSave(settingId, value).then(() => setSaving(false))
      }}
    />
  )
}
